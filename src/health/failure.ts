/**
 * PROPHEX — Failure Classifier
 * Classifies transaction/bundle failures into actionable categories
 * so the AI agent can reason about appropriate recovery strategies.
 */

import { FailureClass } from '../types';

interface FailureContext {
  targetSlot?: bigint;
  skippedSlots?: bigint[];
  tipLamports?: number;
  blockhashAge?: number;
}

/**
 * Classify a transaction or bundle failure into a known failure category.
 * Returns an actionable FailureClass that the AI agent uses to determine
 * recovery strategy.
 */
export function classifyFailure(
  error: unknown,
  context?: FailureContext
): FailureClass {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // Blockhash expired — need to refresh and resubmit
  if (
    msg.includes('blockhash not found') ||
    msg.includes('expired') ||
    msg.includes('too old') ||
    msg.includes('blockhash_not_found')
  ) {
    return 'BLOCKHASH_EXPIRED';
  }

  // Fee/tip too low — need to escalate tip percentile
  if (
    msg.includes('insufficient') ||
    msg.includes('fee too low') ||
    msg.includes('below minimum') ||
    msg.includes('tip too low') ||
    msg.includes('auction lost')
  ) {
    return 'FEE_TOO_LOW';
  }

  // Compute budget exceeded — transaction too expensive
  if (
    msg.includes('exceeded cus') ||
    msg.includes('compute budget') ||
    msg.includes('compute limit') ||
    msg.includes('computational budget')
  ) {
    return 'COMPUTE_EXCEEDED';
  }

  // Jito bundle explicitly rejected
  if (
    msg.includes('bundle') && (msg.includes('reject') || msg.includes('fail') || msg.includes('dropped'))
  ) {
    return 'BUNDLE_REJECTED';
  }

  // Jito infrastructure unavailable
  if (
    msg.includes('unavailable') ||
    msg.includes('connection refused') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('block engine')
  ) {
    return 'JITO_UNAVAILABLE';
  }

  // Transaction simulation failed
  if (msg.includes('simulation') || msg.includes('preflight')) {
    return 'SIMULATION_FAILED';
  }

  // Leader skipped their slot — bundle never had a chance
  if (context?.targetSlot && context?.skippedSlots) {
    const targetSlotBig = BigInt(context.targetSlot);
    if (context.skippedSlots.some(s => BigInt(s) === targetSlotBig)) {
      return 'LEADER_SKIPPED';
    }
  }

  return 'UNKNOWN';
}

/**
 * Returns a human-readable explanation of a failure class
 * for logging and AI context.
 */
export function explainFailure(fc: FailureClass): string {
  const explanations: Record<FailureClass, string> = {
    BLOCKHASH_EXPIRED: 'The blockhash used in the transaction has expired (>150 slots old). A fresh blockhash must be fetched and the transaction re-signed.',
    FEE_TOO_LOW: 'The Jito tip was too low to win the block space auction. The tip percentile should be escalated.',
    COMPUTE_EXCEEDED: 'The transaction exceeded its compute budget. Instructions may need optimization.',
    BUNDLE_REJECTED: 'The Jito block engine rejected the bundle. May be due to conflicting transactions or invalid bundle structure.',
    LEADER_SKIPPED: 'The targeted Jito leader skipped their slot. The bundle must be resubmitted targeting the next Jito-enabled leader.',
    JITO_UNAVAILABLE: 'The Jito block engine is unreachable. May need to retry after a delay or use a different endpoint.',
    SIMULATION_FAILED: 'Transaction simulation failed. The transaction may have invalid instructions or insufficient funds.',
    UNKNOWN: 'An unrecognized error occurred. Manual investigation is recommended.',
  };
  return explanations[fc];
}
