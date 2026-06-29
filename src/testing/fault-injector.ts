/**
 * PROPHEX — Fault Injector
 * Controlled failure injection for testing AI-driven recovery.
 * Supports: stale blockhash, low tip, degraded leaders, compute overrun.
 */

import { FaultType } from '../types';

export class FaultInjector {
  private active: FaultType | null = null;
  private staleBlockhashBuffer: string[] = [];
  public scoreOverride: number | null = null;

  activate(fault: FaultType): void {
    this.active = fault;
    console.log(`[FaultInjector] ⚠ ACTIVATED: ${fault}`);
  }

  deactivate(): void {
    this.active = null;
    this.scoreOverride = null;
    console.log('[FaultInjector] ✓ Deactivated');
  }

  /**
   * Buffer real blockhashes so we can inject a stale one later.
   */
  pushBlockhash(bh: string): void {
    this.staleBlockhashBuffer.push(bh);
    if (this.staleBlockhashBuffer.length > 200) this.staleBlockhashBuffer.shift();
  }

  /**
   * If STALE_BLOCKHASH fault is active, return the oldest buffered blockhash
   * instead of the current one. This forces a BLOCKHASH_EXPIRED failure.
   */
  applyToBlockhash(current: string): string {
    if (this.active === 'STALE_BLOCKHASH' && this.staleBlockhashBuffer.length > 0) {
      const stale = this.staleBlockhashBuffer[0]; // oldest known
      console.log('[FaultInjector] Injecting stale blockhash (oldest in buffer)');
      return stale;
    }
    return current;
  }

  /**
   * If LOW_TIP fault is active, return 1 lamport instead of the calculated tip.
   * This forces a FEE_TOO_LOW rejection from the Jito block engine.
   */
  applyToTip(normal: number): number {
    if (this.active === 'LOW_TIP') {
      console.log('[FaultInjector] Injecting low tip: 1 lamport');
      return 1;
    }
    return normal;
  }

  /**
   * If DEGRADED_LEADERS fault is active, return a low score override.
   */
  getScoreOverride(): number | null {
    if (this.active === 'DEGRADED_LEADERS') return 22;
    return null;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  getActive(): FaultType | null {
    return this.active;
  }

  /**
   * Describe what the active fault does, for logging.
   */
  describe(): string {
    switch (this.active) {
      case 'STALE_BLOCKHASH': return 'Injecting expired blockhash to trigger BLOCKHASH_EXPIRED';
      case 'LOW_TIP': return 'Injecting 1-lamport tip to trigger FEE_TOO_LOW';
      case 'DEGRADED_LEADERS': return 'Overriding leader scores to 22/100 to trigger HOLD behavior';
      case 'COMPUTE_OVERRUN': return 'Injecting excessive compute to trigger COMPUTE_EXCEEDED';
      default: return 'No fault active';
    }
  }
}
