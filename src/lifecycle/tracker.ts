/**
 * PROPHEX — Stream-Based Lifecycle Tracker
 * Tracks transaction confirmation progression using Solana WebSocket subscriptions.
 * NOT RPC polling — this uses real-time push notifications from the validator.
 *
 * Tracks: Submitted → Processed → Confirmed → Finalized
 * Records real slot numbers and timestamps at each commitment level.
 */

import * as web3 from '@solana/web3.js';
import { EventEmitter } from 'events';

export interface ConfirmationEvent {
  signature: string;
  commitment: 'processed' | 'confirmed' | 'finalized';
  slot: bigint;
  timestamp: number;
  error?: string;
}

export class LifecycleTracker extends EventEmitter {
  private connection: web3.Connection;
  private activeSubscriptions = new Map<string, number[]>(); // signature → subscription IDs

  constructor(connection: web3.Connection) {
    super();
    this.connection = connection;
  }

  /**
   * Begin tracking a transaction signature across all commitment levels.
   * Uses WebSocket subscriptions (stream-based, not polling).
   *
   * Emits 'confirmation' events as each commitment level is reached.
   */
  async trackSignature(signature: string): Promise<void> {
    const subIds: number[] = [];

    console.log(`[Tracker] Subscribing to signature ${signature.substring(0, 16)}...`);

    // Track processed commitment
    try {
      const processedSubId = this.connection.onSignature(
        signature,
        (result, context) => {
          const event: ConfirmationEvent = {
            signature,
            commitment: 'processed',
            slot: BigInt(context.slot),
            timestamp: Date.now(),
            error: result.err ? JSON.stringify(result.err) : undefined,
          };
          console.log(`[Tracker] ${signature.substring(0, 12)}... → PROCESSED at slot ${context.slot}`);
          this.emit('confirmation', event);
        },
        'processed'
      );
      subIds.push(processedSubId);
    } catch (err) {
      console.warn('[Tracker] Could not subscribe at processed level:', (err as Error).message);
    }

    // Track confirmed commitment
    try {
      const confirmedSubId = this.connection.onSignature(
        signature,
        (result, context) => {
          const event: ConfirmationEvent = {
            signature,
            commitment: 'confirmed',
            slot: BigInt(context.slot),
            timestamp: Date.now(),
            error: result.err ? JSON.stringify(result.err) : undefined,
          };
          console.log(`[Tracker] ${signature.substring(0, 12)}... → CONFIRMED at slot ${context.slot}`);
          this.emit('confirmation', event);
        },
        'confirmed'
      );
      subIds.push(confirmedSubId);
    } catch (err) {
      console.warn('[Tracker] Could not subscribe at confirmed level:', (err as Error).message);
    }

    // Track finalized commitment
    try {
      const finalizedSubId = this.connection.onSignature(
        signature,
        (result, context) => {
          const event: ConfirmationEvent = {
            signature,
            commitment: 'finalized',
            slot: BigInt(context.slot),
            timestamp: Date.now(),
            error: result.err ? JSON.stringify(result.err) : undefined,
          };
          console.log(`[Tracker] ${signature.substring(0, 12)}... → FINALIZED at slot ${context.slot}`);
          this.emit('confirmation', event);
        },
        'finalized'
      );
      subIds.push(finalizedSubId);
    } catch (err) {
      console.warn('[Tracker] Could not subscribe at finalized level:', (err as Error).message);
    }

    this.activeSubscriptions.set(signature, subIds);
  }

  /**
   * Wait for a specific commitment level for a signature.
   * Returns the confirmation event with real slot + timestamp.
   */
  waitForCommitment(
    signature: string,
    commitment: 'processed' | 'confirmed' | 'finalized',
    timeoutMs = 60000
  ): Promise<ConfirmationEvent> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeAllListeners('confirmation');
        reject(new Error(`Timeout waiting for ${commitment} confirmation of ${signature.substring(0, 12)}... after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event: ConfirmationEvent) => {
        if (event.signature === signature && event.commitment === commitment) {
          clearTimeout(timeout);
          this.removeListener('confirmation', handler);
          resolve(event);
        }
      };

      this.on('confirmation', handler);
    });
  }

  /**
   * Track a signature and collect all confirmation events up to finalized.
   * Returns an object with slot/timestamp at each commitment level.
   */
  async trackToFinalization(
    signature: string,
    timeoutMs = 90000 // finalization takes ~13 seconds
  ): Promise<{
    processed?: ConfirmationEvent;
    confirmed?: ConfirmationEvent;
    finalized?: ConfirmationEvent;
    error?: string;
  }> {
    const result: {
      processed?: ConfirmationEvent;
      confirmed?: ConfirmationEvent;
      finalized?: ConfirmationEvent;
      error?: string;
    } = {};

    await this.trackSignature(signature);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[Tracker] Timeout waiting for full finalization of ${signature.substring(0, 12)}...`);
        this.cleanup(signature);
        resolve(result);
      }, timeoutMs);

      const handler = (event: ConfirmationEvent) => {
        if (event.signature !== signature) return;

        if (event.error) {
          result.error = event.error;
          clearTimeout(timeout);
          this.cleanup(signature);
          this.removeListener('confirmation', handler);
          resolve(result);
          return;
        }

        switch (event.commitment) {
          case 'processed':
            result.processed = event;
            break;
          case 'confirmed':
            result.confirmed = event;
            break;
          case 'finalized':
            result.finalized = event;
            clearTimeout(timeout);
            this.cleanup(signature);
            this.removeListener('confirmation', handler);
            resolve(result);
            break;
        }
      };

      this.on('confirmation', handler);
    });
  }

  /**
   * Clean up WebSocket subscriptions for a signature.
   */
  private cleanup(signature: string): void {
    const subIds = this.activeSubscriptions.get(signature);
    if (subIds) {
      for (const id of subIds) {
        try {
          this.connection.removeSignatureListener(id);
        } catch {
          // Already removed or connection closed
        }
      }
      this.activeSubscriptions.delete(signature);
    }
  }

  /**
   * Clean up all active subscriptions.
   */
  async shutdown(): Promise<void> {
    for (const [sig] of this.activeSubscriptions) {
      this.cleanup(sig);
    }
    console.log('[Tracker] All subscriptions cleaned up.');
  }
}
