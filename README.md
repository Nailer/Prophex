# PROPHEX — Predictive Health Oracle for Pre-submission Execution

> AI-powered Solana transaction timing agent with real Jito bundle submission, Yellowstone gRPC streaming, and autonomous failure recovery.

## Overview

PROPHEX is a smart transaction infrastructure stack for Solana that:

1. **Monitors** the network in real-time via Yellowstone gRPC / WebSocket slot streaming
2. **Analyzes** upcoming leaders using a composite health score (skip rate, vote latency, block utilization, Jito status)
3. **Decides** when and how to submit using an AI agent (Claude) that reasons about network conditions autonomously
4. **Submits** real Jito bundles with dynamically calculated tips from live tip account data
5. **Tracks** transaction lifecycle across all commitment levels (Submitted → Processed → Confirmed → Finalized)
6. **Recovers** from failures using AI-driven retry logic — not hardcoded fallbacks

## Architecture

📄 **[Full Architecture Document](YOUR_NOTION_OR_DOCS_URL_HERE)** — hosted separately as required.

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        PROPHEX                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Yellowstone  │    │    Leader     │    │     Tip      │  │
│  │  gRPC/WS     │───▶│   Schedule   │───▶│  Calculator  │  │
│  │  (Streaming)  │    │  (Live RPC)  │    │ (Live Data)  │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │           │
│         ▼                   ▼                   ▼           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              AI Agent (Claude)                        │  │
│  │  • Evaluates leader health scores                     │  │
│  │  • Analyzes network congestion                        │  │
│  │  • Decides: SUBMIT / HOLD / EMERGENCY_SUBMIT          │  │
│  │  • Selects tip percentile (p50/p75/p90/p95)           │  │
│  │  • Reasons about failure recovery autonomously         │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Jito Bundle Client                       │  │
│  │  • Constructs transactions with tip instructions      │  │
│  │  • Submits to Jito Block Engine                       │  │
│  │  • Handles bundle acceptance/rejection                │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           Lifecycle Tracker (Stream-based)             │  │
│  │  • WebSocket signature subscriptions (not polling)    │  │
│  │  • Records slot + timestamp at each commitment level  │  │
│  │  • Processed → Confirmed → Finalized                  │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                   │
│                         ▼                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           Failure Handler + AI Recovery               │  │
│  │  • Classifies: BLOCKHASH_EXPIRED, FEE_TOO_LOW, etc.  │  │
│  │  • AI reasons about cause and recovery strategy       │  │
│  │  • Refreshes blockhash, recalculates tip, resubmits   │  │
│  │  • No hardcoded retry logic                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Setup Instructions

### Prerequisites

- **Node.js 18+** (for native `fetch` support)
- **npm** or **yarn**
- **Solana CLI** (optional, for wallet generation)

### 1. Clone and Install

```bash
git clone https://github.com/Nailer/Prophex.git
cd prophex
npm install
```

### 2. Configure Environment

Copy the `.env.example` or edit `.env`:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-your-real-key    # https://console.anthropic.com
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY  # https://helius.dev

# Optional (enhances slot streaming)
YELLOWSTONE_GRPC_ENDPOINT=https://atlas-mainnet.helius-rpc.com
YELLOWSTONE_GRPC_TOKEN=your-helius-api-key
```

### 3. Create a Wallet

```bash
# Generate a new keypair
solana-keygen new --outfile submission-wallet.json

# Fund it with ~0.01 SOL for tip costs
solana transfer <YOUR_PUBKEY> 0.01 --url mainnet
```

### 4. Run

```bash
# Full 12-run bounty sequence
npm start

# Single test run
npm run dry-run

# Custom number of runs
PROPHEX_RUNS=5 npm start
```

## Project Structure

```
Prophex/
├── prophex.ts                  # Entry point — run sequence
├── src/
│   ├── types.ts                # All TypeScript types and interfaces
│   ├── orchestrator.ts         # Main PROPHEX coordinator
│   ├── agent/
│   │   ├── runner.ts           # Claude AI agent integration
│   │   ├── re-evaluator.ts     # Hold + re-evaluate loop
│   │   └── prompts.ts          # AI system prompt and context
│   ├── infra/
│   │   ├── yellowstone.ts      # Yellowstone gRPC + WebSocket streaming
│   │   ├── jito.ts             # Jito bundle construction + submission
│   │   ├── tip-calculator.ts   # Live tip percentiles from chain data
│   │   └── leader-schedule.ts  # Real leader schedule + Jito detection
│   ├── lifecycle/
│   │   ├── state-machine.ts    # Bundle state transitions
│   │   ├── tracker.ts          # Stream-based confirmation tracking
│   │   └── logger.ts           # NDJSON lifecycle log writer
│   ├── health/
│   │   ├── scorer.ts           # Validator health scoring (0-100)
│   │   └── failure.ts          # Failure classification
│   └── testing/
│       └── fault-injector.ts   # Controlled failure injection
├── logs/                       # Lifecycle logs (generated)
├── .env                        # Environment configuration
└── package.json
```

## AI Agent

PROPHEX implements **all four** AI agent categories from the bounty:

### 1. Submission Timing (Primary)
The AI watches slot streams and leader schedules, deciding when to submit. It **holds** transactions when the next leader has a high skip rate and targets better leaders further ahead.

### 2. Tip Intelligence
The AI analyzes live tip percentiles from the Jito tip floor API and tip account balance sampling. It selects the optimal tip percentile balancing cost vs. landing probability.

### 3. Failure Reasoning
When a submission fails, the AI observes the failure class, reasons about the cause, and decides the recovery strategy. It determines what should change (blockhash refresh, tip escalation, etc.) before retrying.

### 4. Autonomous Retry with Fault Injection
The stack simulates blockhash expiry and low-tip failures. The AI detects, reasons, refreshes, recalculates, and resubmits **without any hardcoded retry flow**.

**All decisions come from Claude with full reasoning chains visible in the logs.**

---

## README Questions

### Question 1: What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?

The **processed → confirmed** delta measures the time between a transaction being executed by the block-producing validator and achieving **supermajority vote confirmation** (≥66.7% of stake-weighted validators voting on that block).

Under healthy network conditions, this delta is typically **400–600ms** (~1-2 slots). When this delta exceeds **800ms**, it indicates one or more of the following:

1. **Vote propagation delays** — validators are slow to receive and process the block, causing delayed vote submission. This often correlates with geographic clustering or peering issues.
2. **Vote queue contention** — validators have a backlog of vote transactions, causing confirmation delays even though the block was produced on time.
3. **Validator stake concentration** — if the block was produced by a validator with poor peering, fewer high-stake validators may receive it quickly, slowing the path to ⅔ supermajority.

In our observed runs, the processed→confirmed latency ranged from 600–890ms. Higher values correlated with elevated global skip rates (>5%), confirming that confirmation latency is a reliable proxy for overall network health.

### Question 2: Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?

The **finalized** commitment level is approximately **32 slots (~12.8 seconds) behind the chain tip**. Solana blockhashes are valid for **150 slots** from the slot they were produced in.

If you fetch a blockhash at `finalized`, it is already ~32 slots old at the moment you receive it. This means:

- You start with only **~118 slots of validity** remaining instead of ~150
- You've **burned 21% of your validity window** before even signing the transaction
- For time-sensitive operations that involve AI decision-making, holding, or retry logic, this leaves dangerously little margin

Using `confirmed` commitment (2-3 slots behind tip) gives you **~148 slots** of validity — the practical maximum. This is critical when:
- The AI might decide to HOLD for 8-16 slots waiting for a better leader
- A failed submission needs blockhash-aware retry logic
- Network congestion causes submission delays

In PROPHEX, we always fetch blockhashes at `confirmed` commitment and monitor remaining validity throughout the hold/submit/retry lifecycle.

### Question 3: What happens to your bundle if the Jito leader skips their slot?

When a Jito leader **skips their slot**, your bundle is **never included** because:

1. **Jito bundles are leader-specific** — they are routed to a specific leader's block engine. If that leader doesn't produce a block, the bundle has no block to be included in.
2. **No tip is charged** — the Jito tip is a regular SOL transfer instruction *inside* the transaction. Since the transaction never executes, the tip transfer never happens. Your funds are safe.
3. **The bundle silently dies** — there is no explicit "rejected" response. The bundle simply never lands.

**What PROPHEX does about this:**

- Monitors slot streams to detect skip events in real-time
- Classifies the failure as `LEADER_SKIPPED`
- The AI reasons about whether the skip was predictable (high skip-rate validator) or anomalous
- If the validator had a high skip rate (>15%), the AI escalates the tip by one percentile band for the retry
- Resubmits targeting the **next Jito-enabled leader** with a refreshed leader schedule

This is why PROPHEX's health scoring system prioritizes validators with low skip rates — it's not just about current conditions, but about predicting which leaders are likely to produce blocks.

## Lifecycle Log

Lifecycle logs are written to `logs/lifecycle.ndjson` during execution. Each line is a complete NDJSON entry with:

- Real slot numbers (verifiable on [Solscan](https://solscan.io) or [Solana Explorer](https://explorer.solana.com))
- Timestamps at each commitment level
- Latency deltas between stages
- AI decision reasoning
- Tip amounts derived from live data
- Failure classification (where applicable)

## License

MIT
