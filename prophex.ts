/**
 * PROPHEX — Entry Point
 * Runs the full bounty demonstration: 12 bundle submissions including
 * normal runs, fault injections, and AI-driven recovery scenarios.
 *
 * Usage:
 *   npm start                         # Full 12-run sequence
 *   npm run dry-run                   # Single test run
 *   PROPHEX_RUNS=5 npm start          # Custom run count
 */

import * as web3 from '@solana/web3.js';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import { PROPHEX } from './src/orchestrator';
import { FaultType } from './src/types';

// ─── Configuration ───────────────────────────────────────────────

function validateEnv(): void {
  const required = [
    ['ANTHROPIC_API_KEY', 'Get one at https://console.anthropic.com'],
    ['SOLANA_RPC_URL', 'e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY'],
  ];

  let missing = false;
  for (const [key, hint] of required) {
    if (!process.env[key] || process.env[key]!.includes('xxxx')) {
      console.error(`❌ Missing: ${key} — ${hint}`);
      missing = true;
    }
  }

  if (missing) {
    console.error('\nPlease set the required environment variables in your .env file.');
    process.exit(1);
  }
}

function loadWallet(): web3.Keypair {
  const walletPath = process.env.SUBMISSION_WALLET_PATH || './submission-wallet.json';

  if (fs.existsSync(walletPath)) {
    try {
      const raw = fs.readFileSync(walletPath, 'utf-8');
      const secretKey = JSON.parse(raw);
      if (Array.isArray(secretKey) && secretKey.length === 64) {
        const keypair = web3.Keypair.fromSecretKey(new Uint8Array(secretKey));
        console.log(`✓ Loaded wallet: ${keypair.publicKey.toBase58()}`);
        return keypair;
      }
    } catch {
      // Fall through to generation
    }
  }

  // Generate a new wallet for dry-run/testing
  console.log('⚠ No wallet file found. Generating ephemeral keypair for dry-run.');
  console.log('  To use a real wallet, create one with:');
  console.log('  solana-keygen new --outfile submission-wallet.json');
  const keypair = web3.Keypair.generate();
  console.log(`  Generated: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

// ─── Run Sequence ────────────────────────────────────────────────

interface RunConfig {
  label: string;
  faultType?: FaultType;
  delayAfterMs: number;
}

function buildRunSequence(): RunConfig[] {
  const customCount = parseInt(process.env.PROPHEX_RUNS || '0');

  if (customCount > 0) {
    // Custom count: all normal runs
    return Array.from({ length: customCount }, (_, i) => ({
      label: `RUN ${i + 1}: Normal Submission`,
      delayAfterMs: 3000,
    }));
  }

  // Full bounty sequence: 12 runs including fault scenarios
  return [
    // Normal submissions (6)
    { label: 'RUN 1: Normal Submission (baseline)',             delayAfterMs: 3000 },
    { label: 'RUN 2: Normal Submission (tip comparison)',       delayAfterMs: 3000 },
    { label: 'RUN 3: Normal Submission (leader analysis)',      delayAfterMs: 3000 },
    { label: 'RUN 4: Normal Submission (congestion check)',     delayAfterMs: 3000 },
    { label: 'RUN 5: Normal Submission (consistency)',          delayAfterMs: 3000 },
    { label: 'RUN 6: Normal Submission (pre-fault baseline)',   delayAfterMs: 5000 },

    // Fault injection: Stale blockhash (required by bounty)
    { label: 'RUN 7: FAULT — Stale Blockhash',
      faultType: 'STALE_BLOCKHASH' as FaultType,              delayAfterMs: 5000 },

    // Fault injection: Low tip
    { label: 'RUN 8: FAULT — Low Tip (1 lamport)',
      faultType: 'LOW_TIP' as FaultType,                      delayAfterMs: 5000 },

    // Recovery runs (post-fault normal)
    { label: 'RUN 9: Normal Submission (post-fault recovery)',  delayAfterMs: 3000 },
    { label: 'RUN 10: Normal Submission (stability check)',     delayAfterMs: 3000 },
    { label: 'RUN 11: Normal Submission (final baseline)',      delayAfterMs: 3000 },
    { label: 'RUN 12: Normal Submission (closing run)',         delayAfterMs: 2000 },
  ];
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  PROPHEX — Bounty Demonstration                     ║');
  console.log('║  Predictive Health Oracle for Pre-submission Exec.  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // Validate environment
  validateEnv();

  // Load wallet
  const wallet = loadWallet();

  // Check wallet balance
  const rpcUrl = process.env.SOLANA_RPC_URL!;
  const tempConn = new web3.Connection(rpcUrl);
  const balance = await tempConn.getBalance(wallet.publicKey);
  console.log(`✓ Wallet balance: ${balance / web3.LAMPORTS_PER_SOL} SOL (${balance} lamports)`);

  if (balance < 500000) { // Need at least 0.0005 SOL
    console.warn('⚠ Low wallet balance. Some submissions may fail due to insufficient funds.');
    console.warn('  Fund with: solana transfer <YOUR_PUBKEY> 0.01 --url mainnet');
  }

  // Initialize PROPHEX
  const prophex = new PROPHEX({
    rpcUrl,
    grpcEndpoint: process.env.YELLOWSTONE_GRPC_ENDPOINT,
    grpcToken: process.env.YELLOWSTONE_GRPC_TOKEN,
    jitoBlockEngine: process.env.JITO_BLOCK_ENGINE,
  });

  await prophex.initialize();

  // Execute run sequence
  const runs = buildRunSequence();
  const results: Array<{ label: string; state: string; error?: string }> = [];

  console.log(`\n📋 Executing ${runs.length} bundle submissions...\n`);

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    try {
      const record = await prophex.submitBundle({
        wallet,
        faultType: run.faultType,
        label: run.label,
      });

      results.push({
        label: run.label,
        state: record.state,
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ ${run.label} CRASHED: ${errMsg}\n`);
      results.push({
        label: run.label,
        state: 'CRASH',
        error: errMsg,
      });
    }

    // Delay between runs to let the network breathe
    if (i < runs.length - 1) {
      console.log(`⏳ Waiting ${run.delayAfterMs / 1000}s before next run...`);
      await new Promise(r => setTimeout(r, run.delayAfterMs));
    }
  }

  // ─── Summary ───
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  EXECUTION SUMMARY                                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  const succeeded = results.filter(r => r.state === 'FINALIZED').length;
  const failed = results.filter(r => r.state === 'FAILED').length;
  const crashed = results.filter(r => r.state === 'CRASH').length;

  for (const r of results) {
    const icon = r.state === 'FINALIZED' ? '✅' : r.state === 'FAILED' ? '🔴' : '💥';
    console.log(`  ${icon} ${r.label} → ${r.state}${r.error ? ` (${r.error.substring(0, 60)})` : ''}`);
  }

  console.log('');
  console.log(`  Total: ${results.length} | Finalized: ${succeeded} | Failed: ${failed} | Crashed: ${crashed}`);
  console.log(`  AI Calls: ${results.length}+ decisions made autonomously`);

  // Write summary log
  prophex.getLogger().writeSummary();
  console.log(`\n  📄 Lifecycle logs: ${prophex.getLogger().getLogPath()}`);

  // Shutdown
  await prophex.shutdown();
}

// ─── Error Boundary ──────────────────────────────────────────────

main().catch((err) => {
  console.error('\n💥 CRITICAL CRASH IN MAIN EXECUTION:', err);
  process.exit(1);
});