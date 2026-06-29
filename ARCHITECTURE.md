# PROPHEX Architecture Document

> Copy this content into your Notion page, Google Doc, or Figma board for the bounty submission.
> The bounty requires this to be hosted separately from GitHub.

---

## 1. System Overview

PROPHEX (Predictive Health Oracle for Pre-submission Execution) is an AI-powered transaction infrastructure stack for Solana. It makes autonomous decisions about *when*, *how*, and *at what cost* to submit Jito bundles, using real-time network data and Claude AI reasoning.

The system operates in a continuous loop:
1. **Observe** — Stream slot data, leader schedules, and tip account activity
2. **Score** — Compute health scores for upcoming validators
3. **Decide** — AI evaluates conditions and chooses action (SUBMIT / HOLD / EMERGENCY_SUBMIT)
4. **Execute** — Build and submit Jito bundles with dynamically calculated tips
5. **Track** — Monitor lifecycle progression via stream subscriptions
6. **Recover** — AI-driven failure analysis and autonomous retry

---

## 2. Architecture Diagram

```
                    ┌─────────────────────┐
                    │   Solana Cluster     │
                    │   (Mainnet)          │
                    └──┬──────┬──────┬────┘
                       │      │      │
            ┌──────────┘      │      └──────────┐
            ▼                 ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
  │ Yellowstone  │  │  Solana RPC  │  │ Jito Block       │
  │ gRPC Stream  │  │  (Helius)    │  │ Engine           │
  │              │  │              │  │                    │
  │ • Slot events│  │ • Blockhash  │  │ • sendBundle      │
  │ • Tx status  │  │ • Leaders    │  │ • getBundleStatus │
  │ • Blocks     │  │ • Balances   │  │ • Tip floor API   │
  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
         │                 │                    │
         └────────┬────────┘                    │
                  ▼                             │
  ┌───────────────────────────────────┐         │
  │      DATA INGESTION LAYER         │         │
  │                                   │         │
  │  ┌─────────────┐ ┌────────────┐  │         │
  │  │ Yellowstone  │ │   Leader   │  │         │
  │  │ Client       │ │  Schedule  │  │         │
  │  │ (WS fallback)│ │  (Live)    │  │         │
  │  └──────┬──────┘ └─────┬──────┘  │         │
  │         │               │         │         │
  │  ┌──────┴──────┐ ┌─────┴──────┐  │         │
  │  │  Validator   │ │    Tip     │  │         │
  │  │  Health      │ │ Calculator │  │         │
  │  │  Scorer      │ │  (Live)    │  │         │
  │  └──────┬──────┘ └─────┬──────┘  │         │
  └─────────┼───────────────┼─────────┘         │
            │               │                   │
            ▼               ▼                   │
  ┌───────────────────────────────────┐         │
  │        AI DECISION LAYER          │         │
  │                                   │         │
  │  ┌─────────────────────────────┐  │         │
  │  │      Claude AI Agent        │  │         │
  │  │                             │  │         │
  │  │  Input:                     │  │         │
  │  │  • Leader health scores     │  │         │
  │  │  • Network skip rate        │  │         │
  │  │  • Tip percentiles          │  │         │
  │  │  • Blockhash age            │  │         │
  │  │  • Previous failure context │  │         │
  │  │                             │  │         │
  │  │  Output:                    │  │         │
  │  │  • Action (SUBMIT/HOLD)     │  │         │
  │  │  • Tip percentile           │  │         │
  │  │  • Confidence level         │  │         │
  │  │  • Reasoning chain          │  │         │
  │  └─────────────┬───────────────┘  │         │
  │                │                   │         │
  │  ┌─────────────┴───────────────┐  │         │
  │  │   Re-Evaluation Loop        │  │         │
  │  │   (if HOLD: re-evaluate     │  │         │
  │  │    every ~400ms until       │  │         │
  │  │    SUBMIT or blockhash      │  │         │
  │  │    critical)                │  │         │
  │  └─────────────┬───────────────┘  │         │
  └────────────────┼──────────────────┘         │
                   │                            │
                   ▼                            │
  ┌───────────────────────────────────┐         │
  │      EXECUTION LAYER              │         │
  │                                   │         │
  │  ┌─────────────────────────────┐  │         │
  │  │    Jito Bundle Client       │◄─┼─────────┘
  │  │                             │  │
  │  │  • Build tx with tip instr. │  │
  │  │  • Sign with wallet         │  │
  │  │  • Submit to Block Engine   │  │
  │  │  • Handle rejection         │  │
  │  └─────────────┬───────────────┘  │
  └────────────────┼──────────────────┘
                   │
                   ▼
  ┌───────────────────────────────────┐
  │     LIFECYCLE TRACKING LAYER      │
  │                                   │
  │  ┌──────────────┐ ┌───────────┐  │
  │  │   Stream      │ │  State    │  │
  │  │   Tracker     │ │  Machine  │  │
  │  │ (WebSocket    │ │           │  │
  │  │  signatures)  │ │ PENDING   │  │
  │  │              │──▶ HELD      │  │
  │  │  NOT polling │ │ SUBMITTED  │  │
  │  │              │ │ PROCESSED  │  │
  │  │  Real-time   │ │ CONFIRMED  │  │
  │  │  push events │ │ FINALIZED  │  │
  │  └──────────────┘ │ FAILED     │  │
  │                    └─────┬─────┘  │
  └──────────────────────────┼────────┘
                             │
                             ▼
  ┌───────────────────────────────────┐
  │     FAILURE HANDLING LAYER        │
  │                                   │
  │  ┌──────────────┐ ┌───────────┐  │
  │  │  Classifier   │ │ AI-Driven │  │
  │  │               │ │ Recovery  │  │
  │  │ BLOCKHASH_EXP │ │           │  │
  │  │ FEE_TOO_LOW   │ │ • Analyze │  │
  │  │ LEADER_SKIPPED│ │ • Reason  │  │
  │  │ BUNDLE_REJECT │ │ • Refresh │  │
  │  │ COMPUTE_EXCEED│ │ • Recalc  │  │
  │  │ JITO_UNAVAIL  │ │ • Resubmit│  │
  │  └──────────────┘ └───────────┘  │
  │                                   │
  │  ┌──────────────────────────────┐ │
  │  │   Fault Injector (Testing)   │ │
  │  │   • Stale blockhash          │ │
  │  │   • Low tip (1 lamport)      │ │
  │  │   • Degraded leaders         │ │
  │  └──────────────────────────────┘ │
  └───────────────────────────────────┘
                   │
                   ▼
  ┌───────────────────────────────────┐
  │     OUTPUT: LIFECYCLE LOG         │
  │                                   │
  │  logs/lifecycle.ndjson            │
  │                                   │
  │  Each entry contains:             │
  │  • Bundle ID                      │
  │  • Real slot numbers              │
  │  • Timestamps at each level       │
  │  • Latency deltas                 │
  │  • AI decision + reasoning        │
  │  • Tip amount (from live data)    │
  │  • Failure class (if any)         │
  │  • Solscan explorer URL           │
  └───────────────────────────────────┘
```

---

## 3. Key Components

### 3.1 Yellowstone gRPC Client (`src/infra/yellowstone.ts`)
- Primary: Connects to Helius Yellowstone gRPC for real-time slot streaming
- Fallback: Solana WebSocket `onSlotChange` subscriptions
- Handles reconnection with exponential backoff (up to 5 attempts)
- Reports connection mode (gRPC vs WebSocket) for transparency

### 3.2 Leader Schedule (`src/infra/leader-schedule.ts`)
- Fetches epoch leader schedule via `getLeaderSchedule()` RPC
- Detects Jito-enabled validators by analyzing tip account transaction history
- Provides upcoming leader analysis with health scores
- Caches per-epoch to minimize RPC calls

### 3.3 Tip Calculator (`src/infra/tip-calculator.ts`)
- **Source 1:** Jito tip floor API (`bundles.jito.wtf/api/v1/bundles/tip_floor`)
- **Source 2:** On-chain balance sampling of all 8 Jito tip accounts
- Computes p50/p75/p90/p95 percentiles from live data
- Caches for 10 seconds to avoid excessive RPC calls
- **No hardcoded tip values** — all derived from real data

### 3.4 Validator Health Scorer (`src/health/scorer.ts`)
Composite 0-100 score with weighted components:
| Component | Weight | Measures |
|---|---|---|
| Skip rate (last 50 slots) | 40 pts | Block production reliability |
| Vote latency | 30 pts | Network peering quality |
| Block utilization | 20 pts | Transaction packing efficiency |
| Jito enabled | 10 pts | Bundle processing capability |

### 3.5 AI Agent (`src/agent/runner.ts`)
- Uses Claude (claude-sonnet-4-6) for every decision
- System prompt defines decision rules but allows AI to reason beyond them
- Safety overrides prevent dangerous AI decisions (e.g., HOLD when blockhash critical)
- Fallback decision if API call fails (p75 tip, immediate submit)
- Full reasoning chains logged for every decision

### 3.6 Lifecycle Tracker (`src/lifecycle/tracker.ts`)
- Uses WebSocket `onSignature` subscriptions — **NOT RPC polling**
- Subscribes at processed, confirmed, and finalized levels simultaneously
- Records real slot numbers and timestamps at each commitment level
- Falls back to polling only if stream subscription doesn't fire

### 3.7 Failure Classifier (`src/health/failure.ts`)
Classifies errors into actionable categories:
| Class | Trigger | Recovery |
|---|---|---|
| `BLOCKHASH_EXPIRED` | Blockhash >150 slots old | Fetch fresh, re-sign, resubmit |
| `FEE_TOO_LOW` | Tip lost Jito auction | Escalate tip percentile |
| `LEADER_SKIPPED` | Target leader skipped slot | Resubmit to next Jito leader |
| `COMPUTE_EXCEEDED` | Compute budget overflow | Reduce instructions |
| `BUNDLE_REJECTED` | Block engine rejected | Restructure bundle |
| `JITO_UNAVAILABLE` | Block engine unreachable | Retry with backoff |

---

## 4. Data Flow

```
[Solana Cluster] ──slot events──▶ [Yellowstone Client] ──▶ [Health Scorer]
                                                               │
[Solana RPC] ──leader schedule──▶ [Leader Schedule] ───────────┤
                                                               │
[Jito API] ──tip percentiles───▶ [Tip Calculator] ────────────┤
                                                               │
                                                               ▼
                                                      [Agent Context]
                                                               │
                                                               ▼
                                                      [Claude AI Agent]
                                                               │
                                                      ┌────────┴────────┐
                                                      │                 │
                                                   SUBMIT            HOLD
                                                      │                 │
                                                      │          [Re-Evaluate]
                                                      │            │    │
                                                      │         SUBMIT  HOLD
                                                      │            │   (loop)
                                                      ▼            ▼
                                               [Build + Submit Jito Bundle]
                                                      │
                                              ┌───────┴───────┐
                                              │               │
                                           SUCCESS          FAILURE
                                              │               │
                                    [Stream Track]    [Classify Failure]
                                              │               │
                                    FINALIZED        [AI Recovery]
                                              │               │
                                              ▼               ▼
                                       [Lifecycle Log Entry]
```

---

## 5. Infrastructure Decisions

| Decision | Choice | Rationale |
|---|---|---|
| AI Provider | Anthropic Claude | Best reasoning quality for complex network analysis |
| Streaming | Yellowstone gRPC + WS fallback | gRPC is ideal but not always available; WS ensures universal compatibility |
| Jito Integration | Direct HTTP to Block Engine | More reliable than jito-ts SDK; fewer dependency issues |
| Tip Calculation | Jito API + balance sampling | Dual-source validation ensures accuracy |
| Commitment for Blockhash | `confirmed` | Maximizes validity window (~148 slots vs ~118 for finalized) |
| Lifecycle Tracking | WebSocket subscriptions | Satisfies "not RPC polling" requirement; real-time push events |
| Failure Handling | AI-driven, not hardcoded | AI reasons about each failure uniquely; no predetermined retry paths |

---

## 6. AI Agent Responsibilities

The AI agent (Claude) owns **four operational decisions**:

1. **Submission Timing** — Should we submit now or hold for a better leader?
2. **Tip Selection** — Which tip percentile balances cost vs. landing probability?
3. **Failure Reasoning** — What caused this failure and what should change?
4. **Recovery Execution** — How should we retry (new blockhash? higher tip? different leader?)

The agent receives structured context (JSON) with live network data and returns a structured decision with reasoning. Safety overrides prevent dangerous AI choices (e.g., holding when blockhash is about to expire).

---

## 7. Failure Handling Strategy

```
FAILURE DETECTED
       │
       ▼
[Classify Error] ──▶ FailureClass
       │
       ▼
[Build Recovery Context]
  • Previous decision + reasoning
  • Fresh blockhash + tip data
  • Updated leader schedule
       │
       ▼
[AI Evaluates Recovery]
  • Reasons about cause
  • Decides recovery action
  • Selects new tip percentile
       │
       ▼
[Execute Recovery]
  • Refresh blockhash (if expired)
  • Recalculate tip (if too low)
  • Target new leader (if skipped)
  • Resubmit bundle
       │
       ▼
[Track Recovery Lifecycle]
  • Same stream-based tracking
  • Log as FINALIZED_AFTER_RETRY or FAILED
```

No part of this flow is hardcoded. The AI makes real decisions at every step.
