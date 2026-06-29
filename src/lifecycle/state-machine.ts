/**
 * PROPHEX — Lifecycle State Machine
 * Tracks bundle state transitions: PENDING → HELD → SUBMITTED → PROCESSED → CONFIRMED → FINALIZED
 * Records timestamps and slot numbers at each transition for the lifecycle log.
 */

import { BundleState, BundleRecord, StateTransition, AgentDecision, FailureClass } from '../types';

export class LifecycleStateMachine {
  private records = new Map<string, BundleRecord>();

  /**
   * Create a new bundle record in PENDING_DECISION state.
   */
  create(
    id: string,
    tipLamports: number,
    tipAccount: string,
    blockhash: string,
    blockhashFetchSlot: bigint,
    aiDecision: AgentDecision
  ): BundleRecord {
    const record: BundleRecord = {
      id,
      createdAt: Date.now(),
      tipLamports,
      tipAccount,
      blockhash,
      blockhashFetchSlot,
      aiDecision,
      state: 'PENDING_DECISION',
      transitions: [],
    };
    this.records.set(id, record);
    return record;
  }

  /**
   * Transition a bundle to a new state.
   * Records the slot, timestamp, and latency since the last transition.
   */
  transition(id: string, to: BundleState, slot: bigint, note?: string): BundleRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown bundle: ${id}`);

    const from = record.state;
    const now = Date.now();
    const prev = record.transitions[record.transitions.length - 1];
    const latencyMs = prev ? now - prev.timestamp : undefined;

    record.transitions.push({
      from,
      to,
      slot,
      timestamp: now,
      latencyMs,
      note,
    });
    record.state = to;

    console.log(`[Lifecycle] ${id}: ${from} → ${to} at slot ${slot}${latencyMs ? ` (+${latencyMs}ms)` : ''}${note ? ` — ${note}` : ''}`);
    return record;
  }

  /**
   * Mark a bundle as failed with a specific failure class.
   */
  fail(id: string, failureClass: FailureClass, slot: bigint): BundleRecord {
    const record = this.transition(id, 'FAILED', slot, `FailureClass: ${failureClass}`);
    record.failureClass = failureClass;
    return record;
  }

  /**
   * Get a bundle record by ID.
   */
  get(id: string): BundleRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Get all bundle records.
   */
  getAll(): BundleRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Get the timestamp for a specific state transition.
   */
  getTransitionTimestamp(id: string, state: BundleState): number | null {
    const record = this.records.get(id);
    if (!record) return null;
    const transition = record.transitions.find(t => t.to === state);
    return transition?.timestamp ?? null;
  }

  /**
   * Get the slot for a specific state transition.
   */
  getTransitionSlot(id: string, state: BundleState): bigint | null {
    const record = this.records.get(id);
    if (!record) return null;
    const transition = record.transitions.find(t => t.to === state);
    return transition?.slot ?? null;
  }
}
