/**
 * Screen change detector with rate-limit-aware vision parsing.
 * 
 * Combines three optimizations:
 * 1. Pixel diff detection — only parse when screen actually changes
 * 2. Rate-limit-aware backoff — exponential backoff on 429, parse retry-after
 * 3. Fallback state machine — estimated phase when vision is unavailable
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { Emulator } from './emulator';
import { VisionParser } from './vision';
import { GameState } from './types';

/** Sample pixels to create a cheap screen fingerprint */
function fingerprintImage(imagePath: string): string {
  try {
    // Read raw PNG and compute a hash of the first 4KB (fast, cheap)
    const buffer = fs.readFileSync(imagePath);
    const sample = buffer.subarray(0, Math.min(4096, buffer.length));
    return crypto.createHash('md5').update(sample).digest('hex');
  } catch {
    return '';
  }
}

/** Check if the error is a rate limit (429) and extract retry-after seconds */
function parseRetryAfter(errorMessage: string): number | null {
  // Groq returns: "try again in 12.5s"
  const match = errorMessage.match(/try again in (\d+(?:\.\d+)?)s/);
  if (match) return parseFloat(match[1]);
  // Or just a generic 429
  if (errorMessage.includes('429')) return 10;
  return null;
}

export interface ScreenState {
  phase: string;
  description: string;
  confidence: number;
  path: string;
  fromCache: boolean;
}

export class ChangeDetector {
  private parser: VisionParser;
  private emulator: Emulator;

  // Pixel diff tracking
  private lastFingerprint = '';
  private lastScreenshotPath = '';

  // Rate limit tracking
  private backoffMs = 0;
  private maxBackoffMs = 60000; // 1 minute max
  private lastParseTime = 0;
  private consecutive429 = 0;

  // Fallback state machine
  private estimatedPhase = 'unknown';
  private phaseHistory: string[] = [];
  private stuckCounter = 0;
  private lastAction = '';

  // Cache
  private cachedState: ScreenState | null = null;

  constructor(emulator: Emulator, parser: VisionParser) {
    this.emulator = emulator;
    this.parser = parser;
  }

  /** Get current estimated phase (for fallback decisions) */
  getEstimatedPhase(): string {
    return this.estimatedPhase;
  }

  /** Check if we're stuck on the same phase */
  isStuck(): boolean {
    return this.stuckCounter > 5;
  }

  /** Get suggested fallback action when vision is unavailable */
  getFallbackAction(): { button: string; reasoning: string } {
    switch (this.estimatedPhase) {
      case 'title':
        return { button: 'start', reasoning: 'Title screen — pressing START (fallback)' };
      case 'intro':
        return { button: 'a', reasoning: 'Intro — waiting (no input needed)' };
      case 'dialog':
        return { button: 'a', reasoning: 'Dialog — advancing text (fallback)' };
      case 'name_entry':
        return { button: 'a', reasoning: 'Name entry — confirming (fallback)' };
      case 'gender_selection':
        return { button: 'a', reasoning: 'Gender — confirming default (fallback)' };
      default:
        // Cycle through buttons when completely lost
        const buttons = ['start', 'a', 'b', 'up', 'down'];
        const idx = this.stuckCounter % buttons.length;
        return { button: buttons[idx], reasoning: `Unknown — trying ${buttons[idx]} (fallback)` };
    }
  }

  /** Take screenshot and detect if screen changed */
  async detect(label: string): Promise<ScreenState> {
    const screenshotPath = await this.emulator.screenshot(label);
    const fingerprint = fingerprintImage(screenshotPath);

    // Check if screen actually changed
    if (fingerprint === this.lastFingerprint && this.cachedState) {
      return { ...this.cachedState, fromCache: true };
    }

    // Screen changed — need to parse
    this.lastFingerprint = fingerprint;
    this.lastScreenshotPath = screenshotPath;

    // Check rate limit
    const now = Date.now();
    const minInterval = Math.max(15000, this.backoffMs); // At least 15s between parses
    const timeSinceLastParse = now - this.lastParseTime;

    if (timeSinceLastParse < minInterval) {
      // Too soon to parse — use fallback
      return {
        phase: this.estimatedPhase,
        description: `Rate limited, using fallback (next parse in ${Math.ceil((minInterval - timeSinceLastParse) / 1000)}s)`,
        confidence: 0,
        path: screenshotPath,
        fromCache: false,
      };
    }

    // Try to parse with vision
    try {
      const state = await this.parser.parse(screenshotPath);
      this.lastParseTime = Date.now();
      this.consecutive429 = 0;
      this.backoffMs = 0; // Reset backoff on success

      // Update estimated phase
      this.updatePhase(state.phase);

      const result: ScreenState = {
        phase: state.phase,
        description: state.description,
        confidence: state.confidence,
        path: screenshotPath,
        fromCache: false,
      };
      this.cachedState = result;
      return result;

    } catch (e: any) {
      const msg = e.message || '';

      // Check for rate limit
      const retryAfter = parseRetryAfter(msg);
      if (retryAfter !== null) {
        this.consecutive429++;
        this.backoffMs = Math.min(
          this.maxBackoffMs,
          Math.max(retryAfter * 1000, this.backoffMs * 2) // Exponential backoff
        );
        console.log(`    [detector] Rate limited, backing off ${Math.round(this.backoffMs / 1000)}s`);
      }

      // Use fallback
      return {
        phase: this.estimatedPhase,
        description: `Vision failed: ${msg.substring(0, 60)}`,
        confidence: 0,
        path: screenshotPath,
        fromCache: false,
      };
    }
  }

  /** Update estimated phase and track stuck states */
  private updatePhase(newPhase: string): void {
    if (newPhase !== 'unknown' && newPhase !== this.estimatedPhase) {
      this.stuckCounter = 0;
    }

    if (newPhase === this.estimatedPhase && newPhase !== 'unknown') {
      this.stuckCounter++;
    } else {
      this.stuckCounter = 0;
    }

    this.estimatedPhase = newPhase;
    this.phaseHistory.push(newPhase);
    if (this.phaseHistory.length > 10) this.phaseHistory.shift();
  }

  /** Record what action was taken (for stuck detection) */
  recordAction(action: string): void {
    this.lastAction = action;
  }

  /** Get debug info about detector state */
  debug(): string {
    return [
      `phase=${this.estimatedPhase}`,
      `stuck=${this.stuckCounter}`,
      `backoff=${Math.round(this.backoffMs / 1000)}s`,
      `429s=${this.consecutive429}`,
      `history=[${this.phaseHistory.join(',')}]`,
    ].join(', ');
  }
}
