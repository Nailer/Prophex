/**
 * PROPHEX — Validator Health Scorer
 * Computes a 0-100 health score for validators based on skip rate,
 * vote latency, block utilization, and Jito status.
 */

import { ValidatorMetrics, HealthScore } from '../types';

export class ValidatorHealthScorer {
  private metrics = new Map<string, ValidatorMetrics>();
  private slotOutcomes: Array<{ slot: bigint; leader: string; produced: boolean }> = [];
  private readonly windowSlots: number;

  constructor(windowSlots = 50) {
    this.windowSlots = windowSlots;
  }

  /**
   * Record whether a leader produced a block for the given slot.
   * Used to build rolling skip rate data.
   */
  recordSlotOutcome(slot: bigint, leader: string, produced: boolean): void {
    this.slotOutcomes.push({ slot, leader, produced });
    // Keep rolling window bounded
    if (this.slotOutcomes.length > 500) this.slotOutcomes.shift();
    this.recomputeMetrics(leader);
  }

  private recomputeMetrics(pubkey: string): void {
    const relevant = this.slotOutcomes
      .filter(o => o.leader === pubkey)
      .slice(-this.windowSlots);
    if (relevant.length === 0) return;

    const produced = relevant.filter(o => o.produced).length;
    const existing = this.metrics.get(pubkey) || {
      pubkey,
      skipRateLast50: 0,
      voteLatencyMs: 400,
      blockUtilization: 0.8,
      isJitoEnabled: false,
      slotsAssigned: 0,
      slotsProduced: 0,
    };

    this.metrics.set(pubkey, {
      ...existing,
      slotsAssigned: relevant.length,
      slotsProduced: produced,
      skipRateLast50: 1 - (produced / relevant.length),
    });
  }

  /**
   * Update vote latency using exponential moving average.
   */
  updateVoteLatency(pubkey: string, latencyMs: number): void {
    const existing = this.metrics.get(pubkey);
    if (existing) {
      existing.voteLatencyMs = existing.voteLatencyMs * 0.8 + latencyMs * 0.2;
    }
  }

  /**
   * Update block utilization ratio (0.0 - 1.0).
   */
  updateBlockUtilization(pubkey: string, utilization: number): void {
    const existing = this.metrics.get(pubkey);
    if (existing) existing.blockUtilization = utilization;
  }

  /**
   * Set whether this validator runs Jito.
   */
  setJitoStatus(pubkey: string, isJito: boolean): void {
    const existing = this.metrics.get(pubkey) || {
      pubkey,
      skipRateLast50: 0.05,
      voteLatencyMs: 400,
      blockUtilization: 0.8,
      isJitoEnabled: false,
      slotsAssigned: 0,
      slotsProduced: 0,
    };
    existing.isJitoEnabled = isJito;
    this.metrics.set(pubkey, existing);
  }

  /**
   * Seed metrics for a validator without slot history.
   * Used when ingesting leader schedule data from RPC.
   */
  seedMetrics(pubkey: string, partial: Partial<ValidatorMetrics>): void {
    const existing = this.metrics.get(pubkey) || {
      pubkey,
      skipRateLast50: 0.05,
      voteLatencyMs: 400,
      blockUtilization: 0.8,
      isJitoEnabled: false,
      slotsAssigned: 0,
      slotsProduced: 0,
    };
    this.metrics.set(pubkey, { ...existing, ...partial, pubkey });
  }

  /**
   * Compute composite health score (0-100) for a validator.
   *
   * Weights:
   *   - Skip rate:        40 points (lower is better)
   *   - Vote latency:     30 points (lower is better, capped at 500ms)
   *   - Block utilization: 20 points (higher is better)
   *   - Jito enabled:     10 bonus points
   */
  computeScore(pubkey: string): HealthScore {
    const m = this.metrics.get(pubkey) || {
      pubkey,
      skipRateLast50: 0.05,
      voteLatencyMs: 400,
      blockUtilization: 0.8,
      isJitoEnabled: true,
      slotsAssigned: 0,
      slotsProduced: 0,
    };

    const skipRateComponent = (1 - m.skipRateLast50) * 40;
    const voteLatencyComponent = Math.max(0, Math.min(30, (500 - m.voteLatencyMs) / 500 * 30));
    const blockUtilComponent = m.blockUtilization * 20;
    const jitoBonus = m.isJitoEnabled ? 10 : 0;

    const score = Math.round(
      skipRateComponent + voteLatencyComponent + blockUtilComponent + jitoBonus
    );

    return {
      pubkey,
      score: Math.min(100, Math.max(0, score)),
      skipRateComponent,
      voteLatencyComponent,
      blockUtilComponent,
      jitoBonus,
      computedAt: Date.now(),
    };
  }

  /**
   * Get raw metrics for a validator (if available).
   */
  getMetrics(pubkey: string): ValidatorMetrics | undefined {
    return this.metrics.get(pubkey);
  }

  /**
   * Compute global skip rate across all tracked slots.
   */
  getGlobalSkipRate(): number {
    if (this.slotOutcomes.length === 0) return 0.04; // Default estimate
    const last100 = this.slotOutcomes.slice(-100);
    const skipped = last100.filter(o => !o.produced).length;
    return skipped / last100.length;
  }
}
