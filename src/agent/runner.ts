/**
 * PROPHEX — AI Agent Runner
 * Interfaces with Claude to make autonomous decisions about
 * bundle submission timing, tip amounts, and failure recovery.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, AgentDecision } from '../types';
import { SYSTEM_PROMPT, formatContextForAgent } from './prompts';

export class AgentRunner {
  private client: Anthropic;
  private callCount = 0;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }

  /**
   * Submit context to Claude and get an autonomous decision.
   * Falls back to a safe default if the API call fails.
   */
  async evaluate(context: AgentContext): Promise<AgentDecision> {
    this.callCount++;
    const callId = this.callCount;

    try {
      console.log(`[AgentRunner] Call #${callId} — Evaluating context for ${context.transaction.id}`);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: formatContextForAgent(context),
        }],
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as any).text)
        .join('');

      // Strip markdown code fences if Claude wraps the response
      const clean = text.replace(/```json\s*|```\s*/g, '').trim();
      const decision = JSON.parse(clean) as AgentDecision;

      // Validate and apply safety overrides
      this.validateDecision(decision, context);

      console.log(`[AgentRunner] Call #${callId} — Decision: ${decision.action} (${decision.confidence}) — ${decision.reasoning.substring(0, 100)}`);
      return decision;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[AgentRunner] Call #${callId} — Evaluation error, using fallback: ${errMsg.substring(0, 120)}`);
      return this.buildFallbackDecision(context);
    }
  }

  /**
   * Validate an AI decision against safety constraints.
   * Applies overrides when the AI makes a dangerous choice.
   */
  private validateDecision(d: AgentDecision, ctx: AgentContext): void {
    if (!['SUBMIT', 'HOLD', 'EMERGENCY_SUBMIT'].includes(d.action)) {
      throw new Error(`Invalid action: ${d.action}`);
    }
    if (!['p50', 'p75', 'p90', 'p95'].includes(d.tipPercentile)) {
      throw new Error(`Invalid tip percentile: ${d.tipPercentile}`);
    }
    if (typeof d.reasoning !== 'string' || d.reasoning.length < 30) {
      throw new Error('Reasoning too short or missing');
    }
    if (typeof d.tipLamports !== 'number' || d.tipLamports < 0) {
      throw new Error('Invalid tipLamports');
    }

    // Safety: if blockhash critical and agent said HOLD, override to EMERGENCY_SUBMIT
    if (ctx.transaction.blockhashExpiresInSlots < 10 && d.action === 'HOLD') {
      d.action = 'EMERGENCY_SUBMIT';
      d.tipPercentile = 'p95';
      d.tipLamports = ctx.networkState.tipStats.p95;
      d.flags.push('SAFETY_OVERRIDE_BLOCKHASH_CRITICAL');
      console.log('[AgentRunner] ⚠ Safety override: HOLD → EMERGENCY_SUBMIT (blockhash critical)');
    }
  }

  /**
   * Build a safe fallback decision when AI evaluation fails.
   * Uses p75 tip with immediate submission — conservative but reliable.
   */
  private buildFallbackDecision(ctx: AgentContext): AgentDecision {
    const isExpiring = ctx.transaction.blockhashExpiresInSlots < 15;
    return {
      action: isExpiring ? 'EMERGENCY_SUBMIT' : 'SUBMIT',
      tipPercentile: 'p75',
      tipLamports: ctx.networkState.tipStats.p75,
      targetSlotOffset: 0,
      holdSlots: 0,
      confidence: 'LOW',
      reasoning: `Fallback decision: AI evaluation failed. Using p75 tip (${ctx.networkState.tipStats.p75} lamports) with immediate submission. Blockhash has ${ctx.transaction.blockhashExpiresInSlots} slots remaining. Manual review recommended.`,
      flags: ['FALLBACK_DECISION', 'AGENT_EVALUATION_FAILED'],
    };
  }

  /**
   * Get total number of AI calls made this session.
   */
  getCallCount(): number {
    return this.callCount;
  }
}
