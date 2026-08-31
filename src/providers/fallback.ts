/**
 * Fallback vision provider — tries primary, falls back to secondary.
 *
 * Handles rate limits gracefully: when primary gets 429, switch to fallback.
 * Periodically retries primary to detect when quota resets.
 */

import { VisionProvider, GameState } from '../types';

export class FallbackVisionProvider implements VisionProvider {
  readonly name: string;
  private primary: VisionProvider;
  private fallback: VisionProvider;
  private usingFallback = false;
  private fallbackSince = 0;
  private retryIntervalMs = 60_000; // Try primary again every 60s

  constructor(primary: VisionProvider, fallback: VisionProvider) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}→${fallback.name}`;
  }

  isAvailable(): boolean {
    return this.primary.isAvailable() || this.fallback.isAvailable();
  }

  /** Get the currently active provider */
  getActiveProvider(): VisionProvider {
    if (this.usingFallback) {
      // Periodically retry primary
      if (Date.now() - this.fallbackSince > this.retryIntervalMs) {
        this.usingFallback = false;
        return this.primary;
      }
      return this.fallback;
    }
    return this.primary;
  }

  async parse(screenshotPath: string): Promise<GameState> {
    const provider = this.getActiveProvider();

    try {
      const result = await provider.parse(screenshotPath);

      // If we were on fallback and primary succeeded, switch back
      if (this.usingFallback && provider === this.primary) {
        console.log(`    [fallback] Primary (${this.primary.name}) is back! Switching back.`);
        this.usingFallback = false;
      }

      return result;
    } catch (e: any) {
      const msg = e.message || '';

      // Check if it's a rate limit (429)
      const isRateLimited =
        msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('limit');

      if (isRateLimited && provider === this.primary && this.fallback.isAvailable()) {
        console.log(`    [fallback] Primary (${this.primary.name}) rate-limited, switching to ${this.fallback.name}`);
        this.usingFallback = true;
        this.fallbackSince = Date.now();

        // Try fallback
        return await this.fallback.parse(screenshotPath);
      }

      // If fallback also fails, or it's not a rate limit, rethrow
      throw e;
    }
  }
}
