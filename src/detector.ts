/**
 * Screen change detector with rate-limit-aware vision parsing.
 * 
 * Combines three optimizations:
 * 1. Pixel diff detection — only parse when screen actually changes
 * 2. Rate-limit-aware backoff — exponential backoff on 429, parse retry-after
 * 3. Fallback state machine — estimated phase when vision is unavailable
 */

import { Emulator } from './emulator';
import { VisionProvider, GameState, ScreenHistoryEntry } from './types';

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
  private parser: VisionProvider;
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

  // Screen history for context-aware parsing
  private screenHistory: ScreenHistoryEntry[] = [];
  private maxHistory = 10;

  // Cache
  private cachedState: ScreenState | null = null;

  // Budget: max parses per session to prevent quota exhaustion
  private parseBudget: number;
  private parsesUsed = 0;

  constructor(emulator: Emulator, parser: VisionProvider, maxParses = 20) {
    this.emulator = emulator;
    this.parser = parser;
    this.parseBudget = maxParses;
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
    const fingerprint = await this.emulator.fingerprint();

    // Check if screen actually changed
    if (fingerprint === this.lastFingerprint && this.cachedState) {
      return { ...this.cachedState, fromCache: true };
    }

    // Screen changed — need to parse
    this.lastFingerprint = fingerprint;
    this.lastScreenshotPath = screenshotPath;

    // Check budget
    if (this.parsesUsed >= this.parseBudget) {
      return {
        phase: this.estimatedPhase,
        description: `Parse budget exhausted (${this.parseBudget}/${this.parseBudget})`,
        confidence: 0,
        path: screenshotPath,
        fromCache: false,
      };
    }

    // Check rate limit — minimum 30s between parses to conserve quota
    const now = Date.now();
    const minInterval = Math.max(5000, this.backoffMs); // At least 5s between parses (Nemotron is ~2s)
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

    // Try to parse with vision, passing history for context
    try {
      const state = await this.parser.parse(screenshotPath, this.screenHistory);
      this.lastParseTime = Date.now();
      this.consecutive429 = 0;
      this.backoffMs = 0; // Reset backoff on success
      this.parsesUsed++;
      console.log(`    [detector] Parse ${this.parsesUsed}/${this.parseBudget} used`);

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

  /** Add an entry to the screen history (called after an action is taken) */
  addHistoryEntry(phase: string, action: string, description: string): void {
    this.screenHistory.push({ phase, action, description });
    if (this.screenHistory.length > this.maxHistory) this.screenHistory.shift();
  }

  /** Get current screen history */
  getHistory(): ScreenHistoryEntry[] {
    return [...this.screenHistory];
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
      `parses=${this.parsesUsed}/${this.parseBudget}`,
      `backoff=${Math.round(this.backoffMs / 1000)}s`,
      `history=[${this.phaseHistory.join(',')}]`,
    ].join(', ');
  }
}
