/**
 * Decision loop: screenshot → parse → decide → act → repeat.
 * 
 * This is the core agent loop. It uses vision to detect game state,
 * decides what action to take, and executes it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Emulator } from './emulator';
import { VisionParser } from './vision';
import { GameState, Action, Decision, LoopConfig } from './types';

export class DecisionLoop {
  private emulator: Emulator;
  private parser: VisionParser;
  private config: LoopConfig;
  private stepCount = 0;
  private history: Decision[] = [];
  private lastPhase = 'unknown';

  constructor(emulator: Emulator, config: LoopConfig) {
    this.emulator = emulator;
    this.config = config;
    this.parser = new VisionParser(
      config.groqApiKey,
      config.groqModel || 'qwen/qwen3.8-27b',
    );
  }

  /** Run the decision loop */
  async run(): Promise<Decision[]> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Decision Loop — max ${this.config.maxSteps} steps`);
    console.log(`${'='.repeat(60)}\n`);

    // Default 3s delay to stay under Groq 8000 TPM limit
    const cycleDelay = this.config.cycleDelayMs || 3000;

    while (this.stepCount < this.config.maxSteps) {
      try {
        const decision = await this.step();
        this.history.push(decision);

        // Log progress
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

        // Check for terminal states
        if (state.phase === 'save_screen') {
          console.log('\n[DecisionLoop] Save screen reached — saving game...');
          await this.saveGame();
          break;
        }

        // Delay between cycles
        await this.sleep(cycleDelay);

      } catch (err: any) {
        console.error(`[Step ${this.stepCount}] Error: ${err.message}`);
        // Take a screenshot on error for debugging
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

    // 1. Capture screenshot
    const screenshotPath = await this.emulator.screenshot(`step_${String(this.stepCount).padStart(4, '0')}`);

    // 2. Parse game state
    const state = await this.parser.parse(screenshotPath);

    // Safety: ensure phase is a valid string
    if (!state || !state.phase) {
      return {
        timestamp: Date.now(),
        step: this.stepCount,
        state: { phase: 'unknown', location: '', badges: [], pokemonCount: 0, activePokemon: undefined, opponent: undefined, confidence: 0, description: 'Parser returned empty state' },
        action: { button: 'a', repeat: 1, delayMs: 500, reasoning: 'Empty parse result — pressing A' },
        screenshotPath,
      };
    }

    // 3. Decide action based on state
    const action = this.decide(state);

    // 4. Execute action
    for (let i = 0; i < action.repeat; i++) {
      await this.emulator.pressButton(action.button);
      if (i < action.repeat - 1) {
        await this.sleep(action.delayMs);
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
    // Track exploration direction for overworld movement
    if (!this._exploreDir) {
      this._exploreDir = ['up', 'right', 'down', 'left'];
      this._exploreIdx = 0;
    }

    // Track phase history for stuck detection
    this._phaseHistory.push(state.phase);
    if (this._phaseHistory.length > 5) this._phaseHistory.shift();

    // Detect if stuck on same phase
    const isStuck = this._phaseHistory.length >= 4 &&
      this._phaseHistory.slice(-4).every((p) => p === state.phase);
    if (isStuck) this._stuckCount++;
    else this._stuckCount = 0;

    switch (state.phase) {
      case 'title':
        // Title screen needs multiple START presses with long delays
        // First press triggers intro, second press (after animation) starts game
        if (this._stuckCount > 4) {
          return { button: 'a', repeat: 1, delayMs: 1000, reasoning: 'Title stuck after many STARTs — trying A' };
        }
        return { button: 'start', repeat: 2, delayMs: 3000, reasoning: 'Title screen — pressing START twice with 3s delay' };

      case 'intro':
        // Intro cutscene: do NOT press A — it skips back to title.
        // Just wait for the animation to finish naturally.
        return { button: 'a', repeat: 0, delayMs: 0, reasoning: 'Intro cutscene — waiting for animation to finish (no input)' };

      case 'name_entry':
        return { button: 'a', repeat: 1, delayMs: 200, reasoning: 'Name entry — pressing A to confirm' };

      case 'dialog':
        // Advance dialog — press A repeatedly for text boxes
        if (this._stuckCount > 3) {
          return { button: 'start', repeat: 1, delayMs: 500, reasoning: 'Dialog stuck — trying START' };
        }
        return { button: 'a', repeat: 2, delayMs: 250, reasoning: 'Dialog — pressing A to advance text' };

      case 'battle':
        return this.decideBattle(state);

      case 'menu':
        return { button: 'b', repeat: 1, delayMs: 200, reasoning: 'Menu open — closing with B' };

      case 'overworld':
        return this.decideOverworld(state);

      default:
        // Unknown: cycle through A, START, B, D-pad
        const unknownButtons = ['a', 'start', 'b', 'up'] as const;
        const btn = unknownButtons[this._unknownCount % unknownButtons.length];
        this._unknownCount++;
        if (this._unknownCount > 8) this._unknownCount = 0;
        return { button: btn, repeat: 1, delayMs: 500, reasoning: `Unknown state — trying ${btn.toUpperCase()}` };
    }
  }

  private _exploreDir: readonly string[] = [];
  private _exploreIdx = 0;
  private _unknownCount = 0;
  private _battleTurn = 0;
  private _phaseHistory: string[] = [];
  private _stuckCount = 0;

  /** Battle decision strategy */
  private decideBattle(state: GameState): Action {
    const pokemon = state.activePokemon;

    // Critical HP: try to run
    if (pokemon && pokemon.hpPercent < 20) {
      this._battleTurn = 0;
      return { button: 'right', repeat: 2, delayMs: 200, reasoning: `Low HP (${pokemon.hpPercent}%) — navigating to RUN` };
    }

    // First turn: select FIGHT
    if (this._battleTurn === 0) {
      this._battleTurn++;
      return { button: 'a', repeat: 1, delayMs: 300, reasoning: 'Battle — selecting FIGHT' };
    }

    // Subsequent turns: select first move
    this._battleTurn++;
    if (this._battleTurn > 10) this._battleTurn = 0; // safety reset
    return { button: 'a', repeat: 1, delayMs: 400, reasoning: 'Battle — selecting first available move' };
  }

  /** Overworld exploration strategy */
  private decideOverworld(state: GameState): Action {
    // If we have a location, try to move toward something interesting
    if (state.location) {
      // Talk to nearby NPCs
      return { button: 'a', repeat: 1, delayMs: 300, reasoning: `Overworld (${state.location}) — pressing A to interact` };
    }

    // Systematic exploration: walk in a rotating pattern
    const dir = this._exploreDir[this._exploreIdx % this._exploreDir.length];
    this._exploreIdx++;

    // Walk a few steps in this direction
    const steps = 2 + Math.floor(Math.random() * 3);
    return { button: dir as any, repeat: steps, delayMs: 200, reasoning: `Overworld — exploring ${dir} (${steps} steps)` };
  }

  /** Save the game via in-game menu */
  private async saveGame(): Promise<void> {
    // Open menu
    await this.emulator.pressButton('start');
    await this.sleep(500);

    // Navigate to Save (down 3 times)
    for (let i = 0; i < 3; i++) {
      await this.emulator.pressButton('down');
      await this.sleep(200);
    }

    // Select Save
    await this.emulator.pressButton('a');
    await this.sleep(1000);

    // Confirm save
    await this.emulator.pressButton('a');
    await this.sleep(1500);

    // Close menu
    await this.emulator.pressButton('b');
    await this.sleep(300);

    console.log('[DecisionLoop] Game saved via in-game menu');
  }

  /** Save decision history to disk */
  saveHistory(): void {
    const outPath = path.join(this.config.outputDir, 'decisions.json');
    fs.writeFileSync(outPath, JSON.stringify(this.history, null, 2));
    console.log(`[DecisionLoop] History saved to ${outPath}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
