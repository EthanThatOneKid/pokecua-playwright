/**
 * Decision loop: screenshot → parse → decide → act → repeat.
 *
 * Starts AFTER bootstrap has navigated past the title screen.
 * Handles dialogue, gender selection, name entry, overworld, battle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Emulator } from './emulator';
import { VisionProvider, GameState, Action, Decision, LoopConfig } from './types';
import { typeName } from './bootstrap';

export class DecisionLoop {
  private emulator: Emulator;
  private parser: VisionProvider;
  private config: LoopConfig;
  private stepCount = 0;
  private history: Decision[] = [];
  private lastPhase = 'unknown';

  // Name entry tracking
  private playerName: string;
  private rivalName: string;
  private namesEntered = 0; // 0=none, 1=player, 2=rival, 3=done

  constructor(emulator: Emulator, config: LoopConfig & { playerName?: string; rivalName?: string }) {
    this.emulator = emulator;
    this.config = config;
    this.parser = config.visionProvider;
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
    console.log(`${'='.repeat(60)}\n`);

    return this.history;
  }

  /** Execute a single decision cycle */
  private async step(): Promise<Decision> {
    this.stepCount++;

    const screenshotPath = await this.emulator.screenshot(`step_${String(this.stepCount).padStart(4, '0')}`);
    const state = await this.parser.parse(screenshotPath);

    if (!state || !state.phase) {
      return {
        timestamp: Date.now(),
        step: this.stepCount,
        state: { phase: 'unknown', location: '', badges: [], pokemonCount: 0, confidence: 0, description: 'Parser returned empty state' },
        action: { button: 'a', repeat: 1, delayMs: 500, reasoning: 'Empty parse — pressing A' },
        screenshotPath,
      };
    }

    const action = this.decide(state);

    // Execute action
    if (action.button === 'typeName') {
      // Special: type a name
      const nameToType = this.namesEntered === 0 ? this.playerName : this.rivalName;
      console.log(`  → Typing name: ${nameToType}`);
      await typeName(this.emulator, nameToType);
      this.namesEntered++;
      await this.sleep(2000);
    } else if (action.button === 'wait') {
      // Special: just wait
      await this.sleep(action.delayMs || 3000);
    } else {
      for (let i = 0; i < action.repeat; i++) {
        await this.emulator.pressButton(action.button);
        if (i < action.repeat - 1) {
          await this.sleep(action.delayMs);
        }
      }
    }

    this.lastPhase = state.phase;

    return {
      timestamp: Date.now(),
      step: this.stepCount,
      state,
      action,
      screenshotPath,
    };
  }

  /** Decide what action to take based on game state */
  private decide(state: GameState): Action {
    // Track stuck detection
    this._phaseHistory.push(state.phase);
    if (this._phaseHistory.length > 5) this._phaseHistory.shift();

    const isStuck = this._phaseHistory.length >= 4 &&
      this._phaseHistory.slice(-4).every((p) => p === state.phase);
    if (isStuck) this._stuckCount++;
    else this._stuckCount = 0;

    switch (state.phase) {
      case 'dialog':
        if (this._stuckCount > 5) {
          // Might be stuck — try START or B
          return { button: 'b', repeat: 1, delayMs: 1000, reasoning: 'Dialog stuck — trying B to skip' };
        }
        return { button: 'a', repeat: 1, delayMs: 1500, reasoning: 'Dialog — pressing A to advance text' };

      case 'gender_selection':
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Gender selection — pressing A to confirm default' };

      case 'name_entry':
        if (this.namesEntered === 0) {
          return { button: 'typeName', repeat: 1, delayMs: 0, reasoning: `Name entry — typing player name: ${this.playerName}` };
        } else if (this.namesEntered === 1) {
          return { button: 'typeName', repeat: 1, delayMs: 0, reasoning: `Name entry — typing rival name: ${this.rivalName}` };
        }
        // Already typed both names — confirm
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Name entry — confirming' };

      case 'intro':
        // Could be cutscene still playing or post-bootstrap dialogue
        // If we've already entered names, this is overworld-related
        if (this.namesEntered >= 2) {
          return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Post-name intro — advancing with A' };
        }
        // Otherwise wait — might be cutscene
        return { button: 'wait', repeat: 0, delayMs: 3000, reasoning: 'Intro playing — waiting' };

      case 'menu':
        // If bootstrap ran, menu shouldn't appear. If it does, select top option.
        return { button: 'a', repeat: 1, delayMs: 2000, reasoning: 'Menu — selecting top option' };

      case 'battle':
        return this.decideBattle(state);

      case 'overworld':
        return this.decideOverworld(state);

      case 'title':
        // Shouldn't happen after bootstrap. Press START as fallback.
        return { button: 'start', repeat: 1, delayMs: 3000, reasoning: 'Title screen (unexpected after bootstrap) — pressing START' };

      default:
        // Unknown: try A first, then cycle
        const buttons = ['a', 'start', 'b', 'a', 'a'] as const;
        const btn = buttons[this._unknownCount % buttons.length];
        this._unknownCount++;
        if (this._unknownCount > 8) this._unknownCount = 0;
        return { button: btn, repeat: 1, delayMs: 1500, reasoning: `Unknown — trying ${btn.toUpperCase()}` };
    }
  }

  private _unknownCount = 0;
  private _battleTurn = 0;
  private _phaseHistory: string[] = [];
  private _stuckCount = 0;
  private _exploreDir = 0;

  private decideBattle(state: GameState): Action {
    const pokemon = state.activePokemon;

    if (pokemon && pokemon.hpPercent < 20) {
      this._battleTurn = 0;
      return { button: 'right', repeat: 2, delayMs: 200, reasoning: `Low HP (${pokemon.hpPercent}%) — navigating to RUN` };
    }

    if (this._battleTurn === 0) {
      this._battleTurn++;
      return { button: 'a', repeat: 1, delayMs: 300, reasoning: 'Battle — selecting FIGHT' };
    }

    this._battleTurn++;
    if (this._battleTurn > 10) this._battleTurn = 0;
    return { button: 'a', repeat: 1, delayMs: 400, reasoning: 'Battle — selecting move' };
  }

  private decideOverworld(state: GameState): Action {
    const dirs: Array<'up' | 'right' | 'down' | 'left'> = ['up', 'right', 'down', 'left'];
    const dir = dirs[this._exploreDir % dirs.length];
    this._exploreDir++;
    const steps = 2 + Math.floor(Math.random() * 3);
    return { button: dir, repeat: steps, delayMs: 200, reasoning: `Overworld — exploring ${dir} (${steps} steps)` };
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
