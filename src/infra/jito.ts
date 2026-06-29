/**
 * PROPHEX — Jito Bundle Client
 * Constructs and submits real Jito bundles via the Block Engine API.
 * Uses direct HTTP to the Jito JSON-RPC endpoint for maximum reliability.
 *
 * Bundle structure:
 *   Transaction 1: SOL self-transfer (the "payload") + Jito tip transfer
 *   Packed into a single-transaction bundle for submission.
 */

import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';
import { JitoBundleResult } from '../types';

// Jito Block Engine endpoints
const JITO_MAINNET_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const JITO_MAINNET_TIP_STREAM = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

// 8 official Jito tip accounts
export const JITO_TIP_ACCOUNTS = [
  'HFqU5x63VTqvN7XZ6EcDrLCjFwjBkKaHLdBBSRBBQKT',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6Zj',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1IfygL5kd26',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];

export class JitoClient {
  private blockEngineUrl: string;

  constructor(blockEngineUrl?: string) {
    this.blockEngineUrl = blockEngineUrl || JITO_MAINNET_BLOCK_ENGINE;
  }

  /**
   * Build a transaction with a Jito tip instruction.
   *
   * Structure:
   *   1. SOL self-transfer (1000 lamports) — the "payload" instruction
   *   2. Jito tip transfer — pays the Jito auction fee
   *
   * @param wallet - The wallet keypair to sign with
   * @param blockhash - Recent blockhash (must be from confirmed commitment)
   * @param tipLamports - Tip amount in lamports
   * @param tipAccount - Jito tip account to pay
   */
  buildBundleTransaction(
    wallet: web3.Keypair,
    blockhash: string,
    tipLamports: number,
    tipAccount: string
  ): web3.Transaction {
    const tx = new web3.Transaction();

    // Instruction 1: Self-transfer (the payload)
    // This is the "real" transaction that demonstrates the bundle works.
    // In production, this would be a swap, mint, or other DeFi operation.
    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wallet.publicKey,
        lamports: 1000, // Tiny self-transfer
      })
    );

    // Instruction 2: Jito tip transfer
    // This pays the Jito validator for block inclusion priority.
    tx.add(
      web3.SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new web3.PublicKey(tipAccount),
        lamports: tipLamports,
      })
    );

    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    return tx;
  }

  /**
   * Submit a bundle to the Jito Block Engine.
   * Uses the sendBundle JSON-RPC method.
   *
   * @param transactions - Array of signed, serialized transactions
   * @returns Bundle result with ID and acceptance status
   */
  async sendBundle(transactions: web3.Transaction[]): Promise<JitoBundleResult> {
    // Serialize transactions to base58
    const serialized = transactions.map(tx => {
      const raw = tx.serialize();
      return bs58.encode(raw);
    });

    console.log(`[Jito] Submitting bundle with ${serialized.length} transaction(s) to Block Engine...`);

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serialized],
    };

    try {
      const response = await fetch(this.blockEngineUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jito Block Engine HTTP ${response.status}: ${text}`);
      }

      const result = await response.json() as any;

      if (result.error) {
        const errorMsg = typeof result.error === 'string'
          ? result.error
          : result.error.message || JSON.stringify(result.error);
        throw new Error(`Jito bundle rejected: ${errorMsg}`);
      }

      const bundleId = result.result;
      console.log(`[Jito] ✓ Bundle accepted: ${bundleId}`);

      return {
        bundleId,
        accepted: true,
      };

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Jito] ✗ Bundle submission failed: ${errMsg}`);

      // Classify the error for the failure handler
      if (errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED')) {
        throw new Error(`Jito unavailable: ${errMsg}`);
      }
      if (errMsg.includes('tip') || errMsg.includes('fee') || errMsg.includes('below minimum')) {
        throw new Error(`Fee too low: ${errMsg}`);
      }
      if (errMsg.includes('blockhash') || errMsg.includes('expired')) {
        throw new Error(`Blockhash expired: ${errMsg}`);
      }

      throw err;
    }
  }

  /**
   * Get the bundle status from Jito.
   */
  async getBundleStatus(bundleId: string): Promise<any> {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBundleStatuses',
      params: [[bundleId]],
    };

    try {
      const response = await fetch(this.blockEngineUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await response.json() as any;
      return result.result?.value?.[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch current Jito tip floor data.
   * Returns real-time tip percentiles from the Jito API.
   */
  static async fetchTipFloor(): Promise<{
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
  } | null> {
    try {
      const response = await fetch(JITO_MAINNET_TIP_STREAM);
      if (!response.ok) return null;

      const data = await response.json() as any[];
      if (!data || data.length === 0) return null;

      const latest = data[0];
      return {
        p25: Math.round(latest.landed_tips_25th_percentile * 1e9), // Convert SOL to lamports
        p50: Math.round(latest.landed_tips_50th_percentile * 1e9),
        p75: Math.round(latest.landed_tips_75th_percentile * 1e9),
        p95: Math.round(latest.landed_tips_95th_percentile * 1e9),
        p99: Math.round(latest.landed_tips_99th_percentile * 1e9),
      };
    } catch (err) {
      console.warn(`[Jito] Could not fetch tip floor: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Get a random Jito tip account for load balancing.
   */
  static getRandomTipAccount(): string {
    return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  }

  /**
   * Extract the transaction signature from a signed transaction.
   */
  static getSignature(tx: web3.Transaction): string {
    const sig = tx.signature;
    if (!sig) throw new Error('Transaction is not signed');
    return bs58.encode(sig);
  }
}
