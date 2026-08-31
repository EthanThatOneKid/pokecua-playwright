/**
 * Decision loop: screenshot → detect → decide → act → repeat.
 *
 * Starts AFTER bootstrap has navigated past the title screen.
 * Uses ChangeDetector for fingerprint caching, rate limiting, and history context.
 * Handles dialogue, gender selection, name entry, overworld, battle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Emulator } from './emulator';
import { ChangeDetector, ScreenState } from './detector';
import { Action, Decision, GameState, LoopConfig } from './types';
import { typeName } from './bootstrap';

export class DecisionLoop {
  private emulator: Emulator;
  private detector: ChangeDetector;
  private config: LoopConfig;
  private stepCount = 0;
  private history: Decision[] = [];

  // Name entry tracking — by action count, not parser output
  private playerName: string;
  private rivalName: string;
  private namesEntered = 0; // 0=none, 1=player, 2=rival, 3=done

  constructor(emulator: Emulator, detector: ChangeDetector, config: LoopConfig & { playerName?: string; rivalName?: string }) {
    this.emulator = emulator;
    this.detector = detector;
    this.config = config;
    this.playerName = config.playerName || 'ASH';
    this.rivalName = config.rivalName || 'GARY';
  }

  /** Run the decision loop */
  async run(): Promise<Decision[]> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Decision Loop — max ${this.config.maxSteps} steps`);
    console.log(`Player: ${this.playerName}, Rival: ${this.rivalName}`);
    console.log(`${'='.repeat(60)}\n`);

    const cycleDelay = this.config.cycleDelayMs || 2000;

    while (this.stepCount < this.config.maxSteps) {
      try {
        const decision = await this.step();
        this.history.push(decision);

        const state = decision.state;
        console.log(
          `[Step ${String(decision.step).padStart(3)}] ` +
          `${state.phase.padEnd(12)} | ` +
          `${state.description.slice(0, 60)}`
        );
        console.log(
          `  Action: ${decision.action.button}×${decision.action.repeat} — ` +
          `${decision.action.reasoning}`
        );

        // Terminal states
        if (state.phase === 'save_screen') {
          console.log('\n[Loop] Save screen reached — saving game...');
          await this.saveGame();
          break;
        }

        if (state.phase === 'overworld' && this.namesEntered >= 2) {
          console.log('\n[Loop] Overworld reached after name entry — saving game...');
          await this.saveGame();
          break;
        }

        await this.sleep(cycleDelay);

      } catch (err: any) {
        console.error(`[Step ${this.stepCount}] Error: ${err.message}`);
        await this.emulator.screenshot(`error_step${this.stepCount}`);
        await this.sleep(2000);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Completed ${this.history.length} decision cycles`);
    console.log(`Parses used: ${this.detector.debug()}`);
    console.log(`${'='.repeat(60)}\n`);

    return this.history;
  }

  /** Execute a single decision cycle */
  private async step(): Promise<Decision> {
    this.stepCount++;

    // Detect: fingerprint + vision parse (with caching, rate limiting, history)
    const screen = await this.detector.detect(`step_${String(this.stepCount).padStart(4, '0')}`);

    const action = this.decide(screen);

    // Execute action
    if (action.button === 'typeName') {
      const nameToType = this.namesEntered === 0 ? this.playerName : this.rivalName;
      console.log(`  → Typing name: ${nameToType}`);
      await typeName(this.emulator, nameToType);
      this.namesEntered++;
      this.detector.recordAction('typeName');
      this.detector.addHistoryEntry(screen.phase, 'typeName', `Typed ${nameToType}`);
      await this.sleep(2000);
    } else if (action.button === 'wait') {
      this.detector.recordAction('wait');
      this.detector.addHistoryEntry(screen.phase, 'wait', 'Waiting');
      await this.sleep(action.delayMs || 3000);
    } else {
      for (let i = 0; i < action.repeat; i++) {
        await this.emulator.pressButton(action.button);
        if (i < action.repeat - 1) {
          await this.sleep(action.delayMs);
        }
      }
      this.detector.recordAction(action.button);
      this.detector.addHistoryEntry(screen.phase, action.button, action.reasoning);
    }

    return {
      timestamp: Date.now(),
      step: this.stepCount,
      state: {
        phase: screen.phase as GameState['phase'],
        location: '',
        badges: [],
        pokemonCount: 0,
        confidence: screen.confidence,
        description: screen.description,
      },
      action,
      screenshotPath: screen.path,
    };
  }

  /** Decide what action to take based on detected screen state */
  private decide(screen: ScreenState): Action {
    const phase = screen.phase;
    const confidence = screen.confidence;

    // Low confidence — use conservative fallback
    if (confidence < 0.3) {
      return { button: 'a', repeat: 1, delayMs: 1500, reasoning: 'Low confidence — pressing A' };
    }

    // Track stuck detection
    this._phaseHistory.push(phase);
    if (this._phaseHistory.length > 5) this._phaseHistory.shift();

    const isStuck = this._phaseHistory.length >= 4 &&
      this._phaseHistory.slice(-4).every((p) => p === phase);
    if (isStuck) this._stuckCount++;
    else this._stuckCount = 0;

    switch (phase) {
      case 'dialog':
        if (this._stuckCount > 5) {
          return { button: 'b', repeat: 1, delayMs: 1000, reasoning: 'Dialog stuck — trying B' };
        }
        return { button: 'a', repeat: 1, delayMs: 1500, reasoning: 'Dialog — advancing text' };

      case 'gender_selection':
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Gender — confirming default' };

      case 'name_entry':
        if (this.namesEntered === 0) {
          return { button: 'typeName', repeat: 1, delayMs: 0, reasoning: `Typing player name: ${this.playerName}` };
        } else if (this.namesEntered === 1) {
          return { button: 'typeName', repeat: 1, delayMs: 0, reasoning: `Typing rival name: ${this.rivalName}` };
        }
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Name entry — confirming' };

      case 'intro':
        if (this.namesEntered >= 2) {
          return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Post-name intro — advancing' };
        }
        return { button: 'wait', repeat: 0, delayMs: 3000, reasoning: 'Intro playing — waiting' };

      case 'menu':
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Menu — selecting top option' };

      case 'battle':
        return this.decideBattle();

      case 'overworld':
        return this.decideOverworld();

      case 'title':
        return { button: 'start', repeat: 1, delayMs: 3000, reasoning: 'Title (unexpected) — pressing START' };

      default:
        const buttons = ['a', 'start', 'b'] as const;
        const btn = buttons[this._unknownCount % buttons.length];
        this._unknownCount++;
        if (this._unknownCount > 6) this._unknownCount = 0;
        return { button: btn, repeat: 1, delayMs: 1500, reasoning: `Unknown — trying ${btn.toUpperCase()}` };
    }
  }

  private _unknownCount = 0;
  private _battleTurn = 0;
  private _phaseHistory: string[] = [];
  private _stuckCount = 0;
  private _exploreDir = 0;

  private decideBattle(): Action {
    if (this._battleTurn === 0) {
      this._battleTurn++;
      return { button: 'a', repeat: 1, delayMs: 300, reasoning: 'Battle — selecting FIGHT' };
    }
    this._battleTurn++;
    if (this._battleTurn > 10) this._battleTurn = 0;
    return { button: 'a', repeat: 1, delayMs: 400, reasoning: 'Battle — selecting move' };
  }

  private decideOverworld(): Action {
    const dirs: Array<'up' | 'right' | 'down' | 'left'> = ['up', 'right', 'down', 'left'];
    const dir = dirs[this._exploreDir % dirs.length];
    this._exploreDir++;
    const steps = 2 + Math.floor(Math.random() * 3);
    return { button: dir, repeat: steps, delayMs: 200, reasoning: `Exploring ${dir} (${steps} steps)` };
  }

  private async saveGame(): Promise<void> {
    await this.emulator.pressButton('start');
    await this.sleep(500);
    for (let i = 0; i < 3; i++) {
      await this.emulator.pressButton('down');
      await this.sleep(200);
    }
    await this.emulator.pressButton('a');
    await this.sleep(1000);
    await this.emulator.pressButton('a');
    await this.sleep(1500);
    await this.emulator.pressButton('b');
    await this.sleep(300);
    console.log('[Loop] Game saved');
  }

  saveHistory(): void {
    const outPath = path.join(this.config.outputDir, 'decisions.json');
    fs.writeFileSync(outPath, JSON.stringify(this.history, null, 2));
    console.log(`[Loop] History saved to ${outPath}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
