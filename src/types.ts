/**
 * PROPHEX — Core Type Definitions
 * Shared types, interfaces, and unions used across the entire stack.
 */

// ═══════════════════════════════════════════════════════════════════
// ENUMS & UNION TYPES
// ═══════════════════════════════════════════════════════════════════

export type BundleState =
  | 'PENDING_DECISION' | 'HELD' | 'SUBMITTED'
  | 'PROCESSED' | 'CONFIRMED' | 'FINALIZED'
  | 'FAILED' | 'EXPIRED';

export type FailureClass =
  | 'BLOCKHASH_EXPIRED' | 'FEE_TOO_LOW' | 'COMPUTE_EXCEEDED'
  | 'BUNDLE_REJECTED' | 'LEADER_SKIPPED' | 'JITO_UNAVAILABLE'
  | 'SIMULATION_FAILED' | 'UNKNOWN';

export type AIAction = 'SUBMIT' | 'HOLD' | 'EMERGENCY_SUBMIT';
export type TipPercentile = 'p50' | 'p75' | 'p90' | 'p95';
export type CongestionLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type FaultType = 'STALE_BLOCKHASH' | 'LOW_TIP' | 'DEGRADED_LEADERS' | 'COMPUTE_OVERRUN';

// ═══════════════════════════════════════════════════════════════════
// VALIDATOR TYPES
// ═══════════════════════════════════════════════════════════════════

export interface ValidatorMetrics {
  pubkey: string;
  skipRateLast50: number;
  voteLatencyMs: number;
  blockUtilization: number;
  isJitoEnabled: boolean;
  slotsAssigned: number;
  slotsProduced: number;
}

export interface HealthScore {
  pubkey: string;
  score: number;               // 0-100
  skipRateComponent: number;
  voteLatencyComponent: number;
  blockUtilComponent: number;
  jitoBonus: number;
  computedAt: number;
}

export interface ScoredLeaderSlot {
  slot: bigint;
  slotsFromNow: number;
  validatorPubkey: string;
  isJitoEnabled: boolean;
  healthScore: number;
  skipRateLast50: number;
  voteLatencyMs: number;
  blockUtilization: number;
}

// ═══════════════════════════════════════════════════════════════════
// TIP TYPES
// ═══════════════════════════════════════════════════════════════════

export interface TipStats {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  sampledAt: number;
  slotsAnalyzed: number;
}

// ═══════════════════════════════════════════════════════════════════
// AI AGENT TYPES
// ═══════════════════════════════════════════════════════════════════

export interface AgentContext {
  transaction: {
    id: string;
    blockhashAgeSlots: number;
    blockhashExpiresInSlots: number;
    isBlockhashFresh: boolean;
  };
  upcomingLeaders: Array<{
    slotsFromNow: number;
    slot: string;
    validatorId: string;
    isJitoEnabled: boolean;
    healthScore: number;
    skipRateLast50: number;
    voteLatencyMs: number;
    blockUtilization: number;
  }>;
  networkState: {
    currentSlot: string;
    globalSkipRateLast100: number;
    congestionLevel: CongestionLevel;
    tipStats: { p50: number; p75: number; p90: number; p95: number };
  };
  previousDecision?: {
    action: string;
    reasoning: string;
    outcome?: string;
    failureClass?: string;
  };
}

export interface AgentDecision {
  action: AIAction;
  tipPercentile: TipPercentile;
  tipLamports: number;
  targetSlotOffset: number;
  holdSlots?: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
  flags: string[];
}

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE TYPES
// ═══════════════════════════════════════════════════════════════════

export interface BundleRecord {
  id: string;
  createdAt: number;
  tipLamports: number;
  tipAccount: string;
  blockhash: string;
  blockhashFetchSlot: bigint;
  aiDecision: AgentDecision;
  state: BundleState;
  transitions: StateTransition[];
  failureClass?: FailureClass;
  bundleId?: string;
  targetSlot?: bigint;
  signature?: string;
  retryOf?: string;
  retryDecision?: AgentDecision;
}

export interface StateTransition {
  from: BundleState;
  to: BundleState;
  slot: bigint;
  timestamp: number;
  latencyMs?: number;
  note?: string;
}

// ═══════════════════════════════════════════════════════════════════
// INFRASTRUCTURE TYPES
// ═══════════════════════════════════════════════════════════════════

export interface SlotUpdate {
  slot: bigint;
  parent?: bigint;
  status: 'processed' | 'confirmed' | 'finalized';
  timestamp: number;
}

export interface TransactionUpdate {
  signature: string;
  slot: bigint;
  status: 'processed' | 'confirmed' | 'finalized';
  error?: string;
  timestamp: number;
}

export interface JitoBundleResult {
  bundleId: string;
  accepted: boolean;
  error?: string;
  slot?: bigint;
}

export interface LeaderSlotInfo {
  slot: bigint;
  leader: string;
  isJitoEnabled: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE LOG OUTPUT TYPES
// ═══════════════════════════════════════════════════════════════════

export interface LifecycleLogEntry {
  bundleId: string;
  runId: string;
  mode: string;
  timestamps: {
    created: number;
    aiDecisionAt: number;
    heldUntil: number | null;
    submitted: number | null;
    processed: number | null;
    confirmed: number | null;
    finalized: number | null;
  };
  slots: {
    blockhashFetchedAt: string;
    blockhashCommitment: string;
    blockhashAgeAtSubmit: number;
    submitted: string | null;
    processed: string | null;
    confirmed: string | null;
    finalized: string | null;
  };
  tip: {
    lamports: number;
    account: string;
    percentile: string;
    derivedFromLiveTipData: boolean;
  };
  aiDecision: {
    action: string;
    tipPercentile: string;
    targetLeaderScore: number | null;
    targetLeaderSkipRate: number | null;
    holdSlots: number;
    confidence: string;
    reasoning: string;
    flags: string[];
  };
  outcome: string;
  failureClass: string | null;
  latencies: {
    submittedToProcessed: number | null;
    processedToConfirmed: number | null;
    confirmedToFinalized: number | null;
  };
  slotDeltas: {
    submittedToProcessed: number | null;
    processedToConfirmed: number | null;
    confirmedToFinalized: number | null;
  };
  signature: string | null;
  explorerUrl: string | null;
}
