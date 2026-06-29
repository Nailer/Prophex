/**
 * PROPHEX — Main Orchestrator
 * Coordinates all subsystems: AI agent, Jito bundles, lifecycle tracking,
 * leader scheduling, tip calculation, and fault injection.
 *
 * This is the brain of the system — it connects real infrastructure
 * to AI-driven decision making.
 */

import * as web3 from '@solana/web3.js';
import {
  AgentContext, AgentDecision, BundleRecord, CongestionLevel,
  FaultType, TipStats,
} from './types';
import { ValidatorHealthScorer } from './health/scorer';
import { classifyFailure } from './health/failure';
import { AgentRunner } from './agent/runner';
import { ReEvaluationLoop } from './agent/re-evaluator';
import { LifecycleStateMachine } from './lifecycle/state-machine';
import { LifecycleLogger } from './lifecycle/logger';
import { LifecycleTracker } from './lifecycle/tracker';
import { YellowstoneClient } from './infra/yellowstone';
import { JitoClient } from './infra/jito';
import { TipCalculator } from './infra/tip-calculator';
import { LeaderSchedule } from './infra/leader-schedule';
import { FaultInjector } from './testing/fault-injector';

export interface ProphexConfig {
  rpcUrl: string;
  grpcEndpoint?: string;
  grpcToken?: string;
  jitoBlockEngine?: string;
}

export class PROPHEX {
  private connection: web3.Connection;
  private scorer: ValidatorHealthScorer;
  private agent: AgentRunner;
  private lifecycle: LifecycleStateMachine;
  private logger: LifecycleLogger;
  private tracker: LifecycleTracker;
  private yellowstone: YellowstoneClient;
  private jito: JitoClient;
  private tipCalc: TipCalculator;
  private leaderSchedule: LeaderSchedule;
  private reEval: ReEvaluationLoop;
  private fault: FaultInjector;
  private runCounter = 0;

  constructor(config: ProphexConfig) {
    this.connection = new web3.Connection(config.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://'),
    });

    this.scorer = new ValidatorHealthScorer();
    this.agent = new AgentRunner();
    this.lifecycle = new LifecycleStateMachine();
    this.logger = new LifecycleLogger('./logs');
    this.tracker = new LifecycleTracker(this.connection);
    this.yellowstone = new YellowstoneClient(
      this.connection,
      config.grpcEndpoint,
      config.grpcToken
    );
    this.jito = new JitoClient(config.jitoBlockEngine);
    this.tipCalc = new TipCalculator(this.connection);
    this.leaderSchedule = new LeaderSchedule(this.connection, this.scorer);
    this.reEval = new ReEvaluationLoop(this.agent);
    this.fault = new FaultInjector();
  }

  /**
   * Initialize the system: connect to streaming, load leader schedule,
   * detect Jito validators, and fetch initial tip data.
   */
  async initialize(): Promise<void> {
    console.log('═══════════════════════════════════════════════════');
    console.log('  PROPHEX — Predictive Health Oracle');
    console.log('  for Pre-submission Execution');
    console.log('═══════════════════════════════════════════════════');
    console.log('');

    // 1. Connect slot streaming
    console.log('[Init] Connecting to slot stream...');
    try {
      await this.yellowstone.connect();
    } catch (err) {
      console.warn(`[Init] Slot streaming unavailable: ${(err as Error).message}`);
      console.warn('[Init] Continuing without real-time slot data (will use RPC)');
    }

    // 2. Load leader schedule
    console.log('[Init] Loading leader schedule...');
    await this.leaderSchedule.refreshSchedule();

    // 3. Detect Jito validators
    console.log('[Init] Detecting Jito validators...');
    await this.leaderSchedule.detectJitoValidators();

    // 4. Fetch initial tip data
    console.log('[Init] Fetching live tip data...');
    const tipStats = await this.tipCalc.fetchLiveTipStats();
    console.log(`[Init] Tip stats — p50:${tipStats.p50} p75:${tipStats.p75} p90:${tipStats.p90} p95:${tipStats.p95}`);

    console.log('');
    console.log(`[Init] ✓ Streaming mode: ${this.yellowstone.getMode()}`);
    console.log(`[Init] ✓ Leader schedule: ${this.leaderSchedule.getScheduleSize()} slot assignments`);
    console.log('[Init] ✓ PROPHEX ready');
    console.log('');
  }

  /**
   * Submit a bundle through the full PROPHEX pipeline:
   *   1. Fetch blockhash + leader data + tip data
   *   2. AI decides when/how to submit
   *   3. Handle HOLD with re-evaluation loop
   *   4. Build and submit Jito bundle
   *   5. Track lifecycle via stream subscriptions
   *   6. Handle failures with AI-driven recovery
   *   7. Log everything
   */
  async submitBundle(opts: {
    wallet: web3.Keypair;
    faultType?: FaultType;
    label?: string;
  }): Promise<BundleRecord> {
    this.runCounter++;
    const runNum = this.runCounter;
    const runId = `prophex_run_${String(runNum).padStart(3, '0')}`;
    const label = opts.label || `RUN ${runNum}`;
    const { wallet, faultType } = opts;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${label}: ${faultType ? `FAULT INJECTION (${faultType})` : 'NORMAL SUBMISSION'}`);
    console.log(`  Run ID: ${runId}`);
    console.log(`${'═'.repeat(60)}\n`);

    if (faultType) this.fault.activate(faultType);

    // ─── Step 1: Fetch fresh blockhash at confirmed commitment ───
    console.log('[Step 1] Fetching blockhash at confirmed commitment...');
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const blockhashFetchSlot = BigInt(await this.connection.getSlot('confirmed'));
    const finalBlockhash = this.fault.applyToBlockhash(blockhash);
    this.fault.pushBlockhash(blockhash);
    console.log(`[Step 1] Blockhash: ${blockhash.substring(0, 16)}... at slot ${blockhashFetchSlot}`);

    // ─── Step 2: Fetch live tip stats ───
    console.log('[Step 2] Fetching live tip data...');
    const tipStats = await this.tipCalc.fetchLiveTipStats();

    // ─── Step 3: Build agent context with real data ───
    console.log('[Step 3] Building AI context from live data...');
    const currentSlot = BigInt(await this.connection.getSlot('processed'));
    const blockhashAge = Number(currentSlot - blockhashFetchSlot);
    const upcomingLeaders = await this.leaderSchedule.getUpcomingLeaders(currentSlot);
    const globalSkipRate = this.scorer.getGlobalSkipRate();
    const congestion = this.determineCongestion(globalSkipRate);

    const ctx: AgentContext = {
      transaction: {
        id: runId,
        blockhashAgeSlots: blockhashAge,
        blockhashExpiresInSlots: 150 - blockhashAge,
        isBlockhashFresh: blockhashAge < 10,
      },
      upcomingLeaders,
      networkState: {
        currentSlot: currentSlot.toString(),
        globalSkipRateLast100: globalSkipRate,
        congestionLevel: congestion,
        tipStats,
      },
    };

    // ─── Step 4: AI decision ───
    console.log('[Step 4] Requesting AI decision...');
    let decision = await this.agent.evaluate(ctx);
    console.log(`[AI Decision] ${decision.action} | Tip: ${decision.tipPercentile} (${decision.tipLamports} lamports) | Confidence: ${decision.confidence}`);
    console.log(`[AI Reasoning] ${decision.reasoning}`);

    const tipAccount = JitoClient.getRandomTipAccount();
    const record = this.lifecycle.create(
      runId, 0, tipAccount,
      finalBlockhash, blockhashFetchSlot, decision
    );

    // ─── Step 5: Handle HOLD with re-evaluation ───
    if (decision.action === 'HOLD') {
      console.log(`[Step 5] AI chose HOLD — entering re-evaluation loop...`);
      this.lifecycle.transition(runId, 'HELD', currentSlot, decision.reasoning);

      decision = await this.reEval.holdAndReEvaluate(
        runId,
        async () => {
          const freshSlot = BigInt(await this.connection.getSlot('processed'));
          const freshLeaders = await this.leaderSchedule.getUpcomingLeaders(freshSlot);
          const freshAge = Number(freshSlot - blockhashFetchSlot);
          return {
            ...ctx,
            transaction: {
              ...ctx.transaction,
              blockhashAgeSlots: freshAge,
              blockhashExpiresInSlots: 150 - freshAge,
              isBlockhashFresh: freshAge < 10,
            },
            upcomingLeaders: freshLeaders,
            networkState: {
              ...ctx.networkState,
              currentSlot: freshSlot.toString(),
            },
          };
        },
        (d, count) => {
          console.log(`[ReEval #${count}] ${d.action} — ${d.reasoning.substring(0, 100)}`);
        }
      );

      record.aiDecision = decision;
    }

    // ─── Step 6: Build and submit Jito bundle ───
    const normalTip = this.tipCalc.getLiveTip(decision.tipPercentile, tipStats);
    const finalTip = this.fault.applyToTip(normalTip);
    record.tipLamports = finalTip;

    console.log(`[Step 6] Building Jito bundle — tip: ${finalTip} lamports to ${tipAccount.substring(0, 8)}...`);

    try {
      // Build the transaction
      const tx = this.jito.buildBundleTransaction(
        wallet, finalBlockhash, finalTip, tipAccount
      );
      const signature = JitoClient.getSignature(tx);
      record.signature = signature;
      console.log(`[Step 6] Transaction signature: ${signature}`);

      // Start lifecycle tracking BEFORE submission
      const trackingPromise = this.tracker.trackToFinalization(signature, 90000);

      // Submit to Jito Block Engine
      this.lifecycle.transition(runId, 'SUBMITTED', currentSlot);
      const submitSlot = BigInt(await this.connection.getSlot('processed'));

      const bundleResult = await this.jito.sendBundle([tx]);
      record.bundleId = bundleResult.bundleId;
      console.log(`[Step 6] ✓ Bundle submitted: ${bundleResult.bundleId}`);

      // ─── Step 7: Track lifecycle via stream subscriptions ───
      console.log('[Step 7] Tracking lifecycle via stream subscriptions...');

      const confirmation = await trackingPromise;

      if (confirmation.error) {
        throw new Error(`Transaction error: ${confirmation.error}`);
      }

      // Record each confirmation level with real slot data
      if (confirmation.processed) {
        this.lifecycle.transition(
          runId, 'PROCESSED', confirmation.processed.slot,
          `Stream confirmation at slot ${confirmation.processed.slot}`
        );
      }

      if (confirmation.confirmed) {
        this.lifecycle.transition(
          runId, 'CONFIRMED', confirmation.confirmed.slot,
          `Stream confirmation at slot ${confirmation.confirmed.slot}`
        );
      }

      if (confirmation.finalized) {
        this.lifecycle.transition(
          runId, 'FINALIZED', confirmation.finalized.slot,
          `Stream confirmation at slot ${confirmation.finalized.slot}`
        );
      } else {
        // If we didn't get finalized via stream, poll as last resort
        console.log('[Step 7] Finalized not received via stream, polling...');
        await this.pollForFinalization(runId, signature, submitSlot);
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Step 6] ✗ Submission failed: ${errMsg}`);

      const fc = classifyFailure(err, { targetSlot: record.targetSlot });
      console.log(`[Step 6] Failure classified as: ${fc}`);
      this.lifecycle.fail(runId, fc, currentSlot);

      // ─── Step 8: AI-driven recovery ───
      if (fc !== 'UNKNOWN' && fc !== 'SIMULATION_FAILED') {
        await this.aiRecovery(record, fc, wallet, tipStats);
      }
    }

    // ─── Step 9: Log the result ───
    const finalRecord = this.lifecycle.get(runId)!;
    const mode = faultType
      ? `FAULT_INJECTION_${faultType}`
      : decision.action === 'HOLD' ? 'HOLD_THEN_SUBMIT' : 'NORMAL';
    this.logger.writeEntry(finalRecord, ctx.networkState, mode);
    this.fault.deactivate();

    console.log(`\n[Result] ${runId} → ${finalRecord.state}`);
    if (finalRecord.signature) {
      console.log(`[Result] Explorer: https://solscan.io/tx/${finalRecord.signature}`);
    }
    console.log('');

    return finalRecord;
  }

  /**
   * AI-driven recovery: when a submission fails, the AI analyzes the failure
   * and decides how to recover. This is NOT hardcoded retry logic.
   */
  private async aiRecovery(
    record: BundleRecord,
    fc: string,
    wallet: web3.Keypair,
    tipStats: TipStats
  ): Promise<void> {
    console.log(`\n[AI Recovery] Failure: ${fc}`);
    console.log('[AI Recovery] AI analyzing failure and deciding recovery strategy...');

    // Fetch fresh data for recovery
    const freshSlot = BigInt(await this.connection.getSlot('processed'));
    const { blockhash: freshBlockhash } = await this.connection.getLatestBlockhash('confirmed');
    const freshBlockhashSlot = BigInt(await this.connection.getSlot('confirmed'));
    const freshLeaders = await this.leaderSchedule.getUpcomingLeaders(freshSlot);

    // Refresh tip data for recovery
    const freshTipStats = await this.tipCalc.fetchLiveTipStats();

    const recoveryCtx: AgentContext = {
      transaction: {
        id: record.id + '_retry',
        blockhashAgeSlots: 0,
        blockhashExpiresInSlots: 150,
        isBlockhashFresh: true,
      },
      upcomingLeaders: freshLeaders,
      networkState: {
        currentSlot: freshSlot.toString(),
        globalSkipRateLast100: this.scorer.getGlobalSkipRate(),
        congestionLevel: this.determineCongestion(this.scorer.getGlobalSkipRate()),
        tipStats: freshTipStats,
      },
      previousDecision: {
        action: record.aiDecision.action,
        reasoning: record.aiDecision.reasoning,
        outcome: 'FAILED',
        failureClass: fc,
      },
    };

    const retryDecision = await this.agent.evaluate(recoveryCtx);
    console.log(`[AI Recovery] Decision: ${retryDecision.action} | Tip: ${retryDecision.tipPercentile} (${retryDecision.tipLamports} lamports)`);
    console.log(`[AI Recovery] Reasoning: ${retryDecision.reasoning}`);

    record.retryDecision = retryDecision;

    // Execute the recovery
    if (retryDecision.action === 'SUBMIT' || retryDecision.action === 'EMERGENCY_SUBMIT') {
      const retryTip = this.tipCalc.getLiveTip(retryDecision.tipPercentile, freshTipStats);
      const tipAccount = JitoClient.getRandomTipAccount();

      console.log(`[AI Recovery] Rebuilding transaction with fresh blockhash and ${retryTip} lamport tip...`);

      try {
        const retryTx = this.jito.buildBundleTransaction(
          wallet, freshBlockhash, retryTip, tipAccount
        );
        const retrySig = JitoClient.getSignature(retryTx);
        record.signature = retrySig;
        record.tipLamports = retryTip;
        record.blockhash = freshBlockhash;
        record.blockhashFetchSlot = freshBlockhashSlot;

        // Track the retry
        const retryTrackPromise = this.tracker.trackToFinalization(retrySig, 90000);

        // Submit retry
        this.lifecycle.transition(record.id, 'SUBMITTED', freshSlot, `AI retry after ${fc}`);
        const retryResult = await this.jito.sendBundle([retryTx]);
        record.bundleId = retryResult.bundleId;
        console.log(`[AI Recovery] ✓ Retry submitted: ${retryResult.bundleId}`);

        // Track retry lifecycle
        const retryConfirmation = await retryTrackPromise;
        if (retryConfirmation.processed) {
          this.lifecycle.transition(record.id, 'PROCESSED', retryConfirmation.processed.slot);
        }
        if (retryConfirmation.confirmed) {
          this.lifecycle.transition(record.id, 'CONFIRMED', retryConfirmation.confirmed.slot);
        }
        if (retryConfirmation.finalized) {
          this.lifecycle.transition(record.id, 'FINALIZED', retryConfirmation.finalized.slot);
        } else {
          await this.pollForFinalization(record.id, retrySig, freshSlot);
        }

        console.log(`[AI Recovery] ✓ Recovery complete: ${record.state}`);

      } catch (retryErr) {
        console.error(`[AI Recovery] ✗ Retry also failed: ${(retryErr as Error).message}`);
      }
    }
  }

  /**
   * Fallback: poll for finalization if stream subscription didn't fire.
   */
  private async pollForFinalization(
    runId: string,
    signature: string,
    submitSlot: bigint
  ): Promise<void> {
    console.log('[Polling] Waiting for finalization via RPC (fallback)...');

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 2000));

      try {
        const status = await this.connection.getSignatureStatus(signature);
        const slot = BigInt(await this.connection.getSlot('processed'));

        if (status?.value?.confirmationStatus === 'processed' && this.lifecycle.get(runId)?.state === 'SUBMITTED') {
          this.lifecycle.transition(runId, 'PROCESSED', slot, 'RPC poll');
        }
        if (status?.value?.confirmationStatus === 'confirmed' && this.lifecycle.get(runId)?.state === 'PROCESSED') {
          this.lifecycle.transition(runId, 'CONFIRMED', slot, 'RPC poll');
        }
        if (status?.value?.confirmationStatus === 'finalized') {
          if (this.lifecycle.get(runId)?.state !== 'FINALIZED') {
            this.lifecycle.transition(runId, 'FINALIZED', slot, 'RPC poll (finalized)');
          }
          return;
        }

        if (status?.value?.err) {
          console.log(`[Polling] Transaction error: ${JSON.stringify(status.value.err)}`);
          return;
        }
      } catch {
        // RPC error, retry
      }
    }

    console.log('[Polling] Timeout waiting for finalization');
  }

  /**
   * Determine congestion level from global skip rate.
   */
  private determineCongestion(skipRate: number): CongestionLevel {
    if (skipRate > 0.08) return 'HIGH';
    if (skipRate > 0.05) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Get the lifecycle logger for summary output.
   */
  getLogger(): LifecycleLogger {
    return this.logger;
  }

  /**
   * Clean shutdown.
   */
  async shutdown(): Promise<void> {
    console.log('\n[Shutdown] Cleaning up...');
    await this.tracker.shutdown();
    await this.yellowstone.disconnect();
    this.logger.writeSummary();
    console.log('[Shutdown] ✓ PROPHEX stopped');
  }
}
