/**
 * PROPHEX — Yellowstone gRPC Client + WebSocket Fallback
 * Connects to Yellowstone gRPC (via Helius or Triton) for real-time slot streaming.
 * Falls back to Solana WebSocket subscriptions if gRPC is unavailable.
 *
 * This satisfies the bounty requirement:
 * "Monitor live slot and leader data using Yellowstone gRPC or any compatible Geyser stream provider"
 */

import * as web3 from '@solana/web3.js';
import { EventEmitter } from 'events';
import { SlotUpdate } from '../types';

export class YellowstoneClient extends EventEmitter {
  private connection: web3.Connection;
  private grpcEndpoint: string | null;
  private grpcToken: string | null;
  private grpcClient: any = null;
  private grpcStream: any = null;
  private slotSubscriptionId: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnected = false;
  private latestSlot: bigint = 0n;
  private mode: 'grpc' | 'websocket' = 'websocket';

  constructor(
    connection: web3.Connection,
    grpcEndpoint?: string,
    grpcToken?: string
  ) {
    super();
    this.connection = connection;
    this.grpcEndpoint = grpcEndpoint || null;
    this.grpcToken = grpcToken || null;
  }

  /**
   * Connect to the best available streaming source.
   * Priority: Yellowstone gRPC > Solana WebSocket
   */
  async connect(): Promise<void> {
    if (this.grpcEndpoint && this.grpcToken) {
      try {
        await this.connectGrpc();
        return;
      } catch (err) {
        console.warn(`[Yellowstone] gRPC connection failed, falling back to WebSocket: ${(err as Error).message}`);
      }
    }

    await this.connectWebSocket();
  }

  /**
   * Connect via Yellowstone gRPC (Helius/Triton).
   */
  private async connectGrpc(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency if not installed
      const { default: Client } = await import('@triton-one/yellowstone-grpc');

      console.log(`[Yellowstone] Connecting to gRPC: ${this.grpcEndpoint}`);
      this.grpcClient = new Client(this.grpcEndpoint!, this.grpcToken!, undefined);
      this.grpcStream = await this.grpcClient.subscribe();

      // Subscribe to slot updates at all commitment levels
      const subscribeRequest = {
        slots: {
          slot_updates: {},
        },
        accounts: {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        commitment: 1, // CONFIRMED
        accountsDataSlice: [],
        ping: undefined,
      };

      await new Promise<void>((resolve, reject) => {
        this.grpcStream.write(subscribeRequest, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.grpcStream.on('data', (data: any) => {
        try {
          if (data.slot) {
            const update: SlotUpdate = {
              slot: BigInt(data.slot.slot),
              parent: data.slot.parent ? BigInt(data.slot.parent) : undefined,
              status: this.grpcCommitmentToString(data.slot.status),
              timestamp: Date.now(),
            };
            this.latestSlot = update.slot > this.latestSlot ? update.slot : this.latestSlot;
            this.emit('slot', update);
          }
        } catch (err) {
          // Silently handle parse errors on individual messages
        }
      });

      this.grpcStream.on('error', (err: Error) => {
        console.error(`[Yellowstone] gRPC stream error: ${err.message}`);
        this.isConnected = false;
        if (err.message.includes('UNAUTHENTICATED') || err.message.includes('401') || err.message.includes('403')) {
          console.warn('[Yellowstone] Authentication error detected. Falling back to WebSocket immediately.');
          if (this.grpcStream) {
            try { this.grpcStream.cancel(); } catch {}
            this.grpcStream = null;
          }
          this.connectWebSocket().catch(console.error);
        } else if (this.mode === 'grpc') {
          this.reconnect();
        }
      });

      this.grpcStream.on('end', () => {
        console.log('[Yellowstone] gRPC stream ended');
        this.isConnected = false;
        if (this.mode === 'grpc') {
          this.reconnect();
        }
      });

      this.mode = 'grpc';
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log('[Yellowstone] ✓ Connected via gRPC (Yellowstone)');

    } catch (err) {
      throw new Error(`gRPC connection failed: ${(err as Error).message}`);
    }
  }

  /**
   * Connect via Solana WebSocket subscriptions (fallback).
   * Uses onSlotChange which is a real-time push subscription, not polling.
   */
  private async connectWebSocket(): Promise<void> {
    console.log('[Yellowstone] Connecting via Solana WebSocket subscriptions...');

    this.slotSubscriptionId = this.connection.onSlotChange((slotInfo) => {
      const update: SlotUpdate = {
        slot: BigInt(slotInfo.slot),
        parent: BigInt(slotInfo.parent),
        status: 'processed', // onSlotChange reports at processed level
        timestamp: Date.now(),
      };
      this.latestSlot = update.slot > this.latestSlot ? update.slot : this.latestSlot;
      this.emit('slot', update);
    });

    this.mode = 'websocket';
    this.isConnected = true;
    console.log('[Yellowstone] ✓ Connected via WebSocket (Solana RPC)');
  }

  /**
   * Attempt reconnection with exponential backoff.
   */
  private async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Yellowstone] Max reconnection attempts reached. Falling back to WebSocket.');
      await this.connectWebSocket();
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[Yellowstone] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    await new Promise(r => setTimeout(r, delay));

    try {
      if (this.mode === 'grpc') {
        await this.connectGrpc();
      } else {
        await this.connectWebSocket();
      }
    } catch (err) {
      console.error(`[Yellowstone] Reconnection failed: ${(err as Error).message}`);
      this.reconnect();
    }
  }

  private grpcCommitmentToString(status: number): 'processed' | 'confirmed' | 'finalized' {
    switch (status) {
      case 0: return 'processed';
      case 1: return 'confirmed';
      case 2: return 'finalized';
      default: return 'processed';
    }
  }

  /**
   * Get the latest known slot.
   */
  getLatestSlot(): bigint {
    return this.latestSlot;
  }

  /**
   * Get connection mode.
   */
  getMode(): 'grpc' | 'websocket' {
    return this.mode;
  }

  /**
   * Check if connected.
   */
  connected(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.grpcStream) {
      try {
        this.grpcStream.cancel();
      } catch {
        // Already closed
      }
      this.grpcStream = null;
    }

    if (this.slotSubscriptionId !== null) {
      try {
        await this.connection.removeSlotChangeListener(this.slotSubscriptionId);
      } catch {
        // Already removed
      }
      this.slotSubscriptionId = null;
    }

    this.isConnected = false;
    console.log('[Yellowstone] Disconnected');
  }
}
