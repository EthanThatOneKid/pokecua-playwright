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
        await this.sleep(this.config.cycleDelayMs);

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
    switch (state.phase) {
      case 'title':
        // Press A to advance from title screen
        return { button: 'a', repeat: 3, delayMs: 400, reasoning: 'Title screen — pressing A to advance' };

      case 'intro':
        // Skip intro cutscenes with A + Start
        return { button: 'a', repeat: 2, delayMs: 300, reasoning: 'Intro cutscene — pressing A to skip' };

      case 'name_entry':
        // This is handled by a specialized name entry routine
        // For now, press A to confirm
        return { button: 'a', repeat: 1, delayMs: 200, reasoning: 'Name entry — pressing A to confirm' };

      case 'dialog':
        // Advance dialog text
        return { button: 'a', repeat: 1, delayMs: 300, reasoning: 'Dialog — pressing A to advance text' };

      case 'battle':
        // Basic battle strategy
        if (state.activePokemon && state.activePokemon.hpPercent < 20) {
          return { button: 'run', repeat: 1, delayMs: 500, reasoning: 'Low HP — trying to run' } as any;
        }
        return { button: 'a', repeat: 1, delayMs: 300, reasoning: 'Battle — selecting FIGHT' };

      case 'menu':
        // Close menu
        return { button: 'b', repeat: 1, delayMs: 200, reasoning: 'Menu open — closing with B' };

      case 'overworld':
        // Explore: move in a direction
        const directions = ['up', 'down', 'left', 'right'] as const;
        const dir = directions[Math.floor(Math.random() * directions.length)];
        return { button: dir, repeat: 3, delayMs: 200, reasoning: `Overworld — walking ${dir}` };

      default:
        // Unknown state: press A and hope for the best
        return { button: 'a', repeat: 1, delayMs: 500, reasoning: 'Unknown state — pressing A' };
    }
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
