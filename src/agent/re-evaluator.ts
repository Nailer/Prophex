/**
 * PROPHEX — Re-Evaluation Loop
 * When the AI decides to HOLD, this module periodically re-evaluates
 * conditions until the AI decides to SUBMIT or blockhash becomes critical.
 */

import { AgentContext, AgentDecision } from '../types';
import { AgentRunner } from './runner';

export class ReEvaluationLoop {
  private agent: AgentRunner;

  constructor(agent: AgentRunner) {
    this.agent = agent;
  }

  /**
   * Hold and periodically re-evaluate until the AI decides to submit.
   * Includes hard safety: if blockhash has < 10 slots remaining,
   * force an EMERGENCY_SUBMIT regardless of AI opinion.
   *
   * @param bundleId - ID of the bundle being held
   * @param getContext - Async function to fetch fresh context each iteration
   * @param onDecision - Callback fired each time the AI makes a decision
   * @param slotIntervalMs - How often to re-evaluate (default: 400ms ≈ 1 Solana slot)
   */
  async holdAndReEvaluate(
    bundleId: string,
    getContext: () => Promise<AgentContext>,
    onDecision: (d: AgentDecision, evalCount: number) => void,
    slotIntervalMs = 400
  ): Promise<AgentDecision> {
    let evalCount = 0;
    const maxEvals = 40; // Hard cap to prevent infinite loops (~16 seconds)

    while (evalCount < maxEvals) {
      const ctx = await getContext();
      const remaining = ctx.transaction.blockhashExpiresInSlots;

      // Hard safety: must submit now
      if (remaining < 10) {
        console.log(`[ReEval] ⚠ EMERGENCY: blockhash expires in ${remaining} slots. Forcing submission.`);
        const emergency: AgentDecision = {
          action: 'EMERGENCY_SUBMIT',
          tipPercentile: 'p95',
          tipLamports: ctx.networkState.tipStats.p95,
          targetSlotOffset: 0,
          holdSlots: 0,
          confidence: 'HIGH',
          reasoning: `EMERGENCY: blockhash expires in ${remaining} slots. Submitting immediately at p95 tip (${ctx.networkState.tipStats.p95} lamports) regardless of leader conditions.`,
          flags: ['BLOCKHASH_CRITICAL', 'EMERGENCY_OVERRIDE'],
        };
        onDecision(emergency, evalCount + 1);
        return emergency;
      }

      // Ask the AI again
      const decision = await this.agent.evaluate(ctx);
      evalCount++;
      console.log(`[ReEval #${evalCount}] ${decision.action} — ${decision.reasoning.substring(0, 100)}...`);
      onDecision(decision, evalCount);

      // If the AI no longer wants to hold, we're done
      if (decision.action !== 'HOLD') {
        return decision;
      }

      // Wait approximately one slot before re-evaluating
      await new Promise(r => setTimeout(r, slotIntervalMs));
    }

    // If we exhausted re-evaluations, force submit with elevated tip
    console.log('[ReEval] Max re-evaluations reached. Forcing submission at p90.');
    const ctx = await getContext();
    const forced: AgentDecision = {
      action: 'SUBMIT',
      tipPercentile: 'p90',
      tipLamports: ctx.networkState.tipStats.p90,
      targetSlotOffset: 0,
      holdSlots: 0,
      confidence: 'MEDIUM',
      reasoning: `Max re-evaluations (${maxEvals}) reached. Forcing submission at p90 tip to avoid further delay. Blockhash has ${ctx.transaction.blockhashExpiresInSlots} slots remaining.`,
      flags: ['MAX_REEVALS_REACHED', 'FORCED_SUBMISSION'],
    };
    onDecision(forced, evalCount + 1);
    return forced;
  }
}
