/**
 * PROPHEX — Live Leader Schedule
 * Fetches the real leader schedule from the Solana cluster and identifies
 * upcoming Jito-enabled leaders for optimal bundle submission timing.
 */

import * as web3 from '@solana/web3.js';
import { LeaderSlotInfo, AgentContext } from '../types';
import { ValidatorHealthScorer } from '../health/scorer';
import { JITO_TIP_ACCOUNTS } from './jito';

// Known Jito validators (subset — expanded at runtime via heuristics)
// In production, this list is maintained by Jito Labs.
// We bootstrap with known validators and expand via tip account analysis.
const KNOWN_JITO_VALIDATORS = new Set<string>();

export class LeaderSchedule {
  private connection: web3.Connection;
  private scorer: ValidatorHealthScorer;
  private cachedSchedule: Map<number, string> = new Map(); // slot → leader pubkey
  private cachedEpoch: number | null = null;
  private jitoValidators = new Set<string>();

  constructor(connection: web3.Connection, scorer: ValidatorHealthScorer) {
    this.connection = connection;
    this.scorer = scorer;
  }

  /**
   * Refresh the leader schedule for the current epoch.
   * Fetches from RPC and caches locally.
   */
  async refreshSchedule(): Promise<void> {
    try {
      const epochInfo = await this.connection.getEpochInfo();
      const currentEpoch = epochInfo.epoch;

      // Only refresh if epoch changed
      if (this.cachedEpoch === currentEpoch && this.cachedSchedule.size > 0) {
        return;
      }

      console.log(`[LeaderSchedule] Fetching schedule for epoch ${currentEpoch}...`);

      const schedule = await this.connection.getLeaderSchedule();
      if (!schedule) {
        console.warn('[LeaderSchedule] No schedule returned from RPC');
        return;
      }

      this.cachedSchedule.clear();

      // Build slot → leader mapping
      const epochStartSlot = epochInfo.absoluteSlot - epochInfo.slotIndex;
      for (const [leader, slots] of Object.entries(schedule)) {
        for (const relativeSlot of slots) {
          const absoluteSlot = epochStartSlot + relativeSlot;
          this.cachedSchedule.set(absoluteSlot, leader);
        }

        // Seed the health scorer with this validator
        this.scorer.seedMetrics(leader, { pubkey: leader });
      }

      this.cachedEpoch = currentEpoch;
      console.log(`[LeaderSchedule] Cached ${this.cachedSchedule.size} slot assignments for epoch ${currentEpoch}`);

    } catch (err) {
      console.error(`[LeaderSchedule] Failed to refresh: ${(err as Error).message}`);
    }
  }

  /**
   * Identify Jito-enabled validators by checking tip account transaction history.
   * Validators that have recently received tips to Jito accounts are Jito-enabled.
   */
  async detectJitoValidators(): Promise<void> {
    console.log('[LeaderSchedule] Detecting Jito-enabled validators...');

    try {
      // Check a few tip accounts for recent signatures
      const tipAccount = new web3.PublicKey(JITO_TIP_ACCOUNTS[0]);
      const signatures = await this.connection.getSignaturesForAddress(tipAccount, { limit: 50 });

      for (const sigInfo of signatures) {
        if (sigInfo.slot) {
          const leader = this.cachedSchedule.get(sigInfo.slot);
          if (leader) {
            this.jitoValidators.add(leader);
            this.scorer.setJitoStatus(leader, true);
          }
        }
      }

      console.log(`[LeaderSchedule] Detected ${this.jitoValidators.size} Jito-enabled validators`);
    } catch (err) {
      console.warn(`[LeaderSchedule] Jito detection failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get upcoming leaders from the current slot, with health scores.
   * Returns the next N leaders with their Jito status and health metrics.
   */
  async getUpcomingLeaders(
    currentSlot: bigint,
    count = 8
  ): Promise<AgentContext['upcomingLeaders']> {
    // Ensure we have a fresh schedule
    await this.refreshSchedule();

    const leaders: AgentContext['upcomingLeaders'] = [];
    const currentSlotNum = Number(currentSlot);

    // Scan ahead up to 64 slots to find leaders
    for (let offset = 1; offset <= 64 && leaders.length < count; offset++) {
      const targetSlot = currentSlotNum + offset;
      const leader = this.cachedSchedule.get(targetSlot);

      if (leader) {
        const isJito = this.jitoValidators.has(leader);
        const healthScore = this.scorer.computeScore(leader);
        const metrics = this.scorer.getMetrics(leader);

        leaders.push({
          slotsFromNow: offset,
          slot: BigInt(targetSlot).toString(),
          validatorId: leader.substring(0, 8) + '...' + leader.substring(leader.length - 4),
          isJitoEnabled: isJito,
          healthScore: healthScore.score,
          skipRateLast50: metrics?.skipRateLast50 ?? 0.05,
          voteLatencyMs: metrics?.voteLatencyMs ?? 400,
          blockUtilization: metrics?.blockUtilization ?? 0.8,
        });
      }
    }

    // If we couldn't find leaders from the schedule (e.g., epoch boundary),
    // use getSlotLeaders RPC as fallback
    if (leaders.length === 0) {
      try {
        const slotLeaders = await this.connection.getSlotLeaders(
          Number(currentSlot),
          Math.min(count * 4, 64)
        );

        for (let i = 0; i < slotLeaders.length && leaders.length < count; i++) {
          const leader = slotLeaders[i].toBase58();
          const isJito = this.jitoValidators.has(leader);
          const healthScore = this.scorer.computeScore(leader);

          leaders.push({
            slotsFromNow: i + 1,
            slot: (currentSlot + BigInt(i + 1)).toString(),
            validatorId: leader.substring(0, 8) + '...' + leader.substring(leader.length - 4),
            isJitoEnabled: isJito,
            healthScore: healthScore.score,
            skipRateLast50: 0.05, // default for unknown
            voteLatencyMs: 400,
            blockUtilization: 0.8,
          });
        }
      } catch (err) {
        console.warn(`[LeaderSchedule] getSlotLeaders fallback failed: ${(err as Error).message}`);
      }
    }

    return leaders;
  }

  /**
   * Find the best upcoming Jito-enabled leader within a slot window.
   */
  async findBestJitoLeader(
    currentSlot: bigint,
    maxSlotsAhead = 32
  ): Promise<{ slot: bigint; leader: string; score: number } | null> {
    const leaders = await this.getUpcomingLeaders(currentSlot, 16);
    const jitoLeaders = leaders.filter(l => l.isJitoEnabled);

    if (jitoLeaders.length === 0) return null;

    // Sort by health score descending
    jitoLeaders.sort((a, b) => b.healthScore - a.healthScore);

    const best = jitoLeaders[0];
    return {
      slot: BigInt(best.slot),
      leader: best.validatorId,
      score: best.healthScore,
    };
  }

  /**
   * Check if a specific leader is Jito-enabled.
   */
  isJitoEnabled(pubkey: string): boolean {
    return this.jitoValidators.has(pubkey);
  }

  /**
   * Get the cached schedule size (for diagnostics).
   */
  getScheduleSize(): number {
    return this.cachedSchedule.size;
  }
}
