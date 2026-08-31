/**
 * Bootstrap: plays Pokemon Platinum through intro to starter selection.
 * 
 * Uses vision parser at each decision point to detect what's on screen,
 * instead of guessing from color counts.
 * 
 * Usage:
 *   npx tsx src/bootstrap.ts roms/pokemon-platinum.nds --player-name ASH --rival-name GARY
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
dotenv.config();
import { Emulator } from './emulator';
import { VisionParser } from './vision';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Take a screenshot and parse it with the vision model */
async function see(
  emulator: Emulator,
  parser: VisionParser,
  label: string,
): Promise<{ phase: string; description: string; confidence: number; path: string }> {
  const screenshotPath = await emulator.screenshot(label);
  try {
    const state = await parser.parse(screenshotPath);
    return {
      phase: state.phase,
      description: state.description,
      confidence: state.confidence,
      path: screenshotPath,
    };
  } catch (e: any) {
    // If parser fails (rate limit etc), return unknown
    console.log(`    [vision] Parse failed: ${e.message?.substring(0, 80)}`);
    return {
      phase: 'unknown',
      description: 'parse failed',
      confidence: 0,
      path: screenshotPath,
    };
  }
}

/** Type a name using D-pad navigation on the NDS keyboard grid */
async function typeName(emulator: Emulator, name: string): Promise<void> {
  const keyboard = [
    ['A', 'B', 'C', 'D', 'E', 'F'],
    ['G', 'H', 'I', 'J', 'K', 'L'],
    ['M', 'N', 'O', 'P', 'Q', 'R'],
    ['S', 'T', 'U', 'V', 'W', 'X'],
    ['Y', 'Z', ' ', 'DEL', 'END', ''],
  ];

  let currentRow = 0;
  let currentCol = 0;

  for (const char of name.toUpperCase()) {
    let targetRow = -1;
    let targetCol = -1;
    for (let r = 0; r < keyboard.length; r++) {
      for (let c = 0; c < keyboard[r].length; c++) {
        if (keyboard[r][c] === char) {
          targetRow = r;
          targetCol = c;
          break;
        }
      }
      if (targetRow >= 0) break;
    }
    if (targetRow < 0) continue;

    const rowDiff = targetRow - currentRow;
    const colDiff = targetCol - currentCol;

    for (let i = 0; i < Math.abs(rowDiff); i++) {
      await emulator.pressButton(rowDiff > 0 ? 'down' : 'up');
      await sleep(100);
    }
    for (let i = 0; i < Math.abs(colDiff); i++) {
      await emulator.pressButton(colDiff > 0 ? 'right' : 'left');
      await sleep(100);
    }
    await emulator.pressButton('a');
    await sleep(300);

    currentRow = targetRow;
    currentCol = targetCol;
    console.log(`    Typed: ${char}`);
  }

  // Navigate to END (row 4, col 4) and confirm
  for (let i = 0; i < 4 - currentRow; i++) { await emulator.pressButton('down'); await sleep(100); }
  for (let i = 0; i < currentCol - 4; i++) { await emulator.pressButton('left'); await sleep(100); }
  for (let i = 0; i < 4 - currentCol; i++) { await emulator.pressButton('right'); await sleep(100); }
  await emulator.pressButton('a');
  await sleep(500);
  console.log('    Name confirmed!');
}

async function main() {
  const args = process.argv.slice(2);
  const romPath = args.find((a) => !a.startsWith('--'));
  if (!romPath) {
    console.error('Usage: npx tsx src/bootstrap.ts <rom.nds> [--player-name ASH] [--rival-name GARY]');
    process.exit(1);
  }

  const nameIdx = args.indexOf('--player-name');
  const playerName = nameIdx >= 0 ? args[nameIdx + 1] : 'ASH';
  const rivalIdx = args.indexOf('--rival-name');
  const rivalName = rivalIdx >= 0 ? args[rivalIdx + 1] : 'GARY';
  const outputDir = path.join(process.cwd(), 'captures', 'bootstrap');

  console.log('PokeCUA Bootstrap — Vision-guided intro');
  console.log(`ROM: ${romPath}`);
  console.log(`Player: ${playerName}, Rival: ${rivalName}\n`);

  const emulator = new Emulator(outputDir);
  const parser = new VisionParser(process.env.GROQ_API_KEY!);

  try {
    await emulator.start({ romPath });
    console.log('[bootstrap] ROM loaded, waiting for init...\n');
    await sleep(5000);

    // ============================================================
    // LOOP: See → Decide → Act → Repeat
    // ============================================================
    let step = 0;
    const maxSteps = 80;
    let consecutiveSame = 0;
    let lastPhase = '';

    while (step < maxSteps) {
      step++;
      console.log(`\n--- Step ${step} ---`);

      // SEE: What's on screen?
      const screen = await see(emulator, parser, `step_${step}`);
      console.log(`  Vision: ${screen.phase} (${screen.confidence}) — ${screen.description.substring(0, 80)}`);

      // Track stuck states
      if (screen.phase === lastPhase && screen.phase !== 'unknown') {
        consecutiveSame++;
      } else {
        consecutiveSame = 0;
      }
      lastPhase = screen.phase;

      // DECIDE + ACT
      switch (screen.phase) {
        case 'title':
          if (consecutiveSame > 5) {
            console.log('  → Stuck on title, trying A...');
            await emulator.pressButton('a');
          } else {
            console.log('  → Pressing START');
            await emulator.pressButton('start');
          }
          await sleep(3000);
          break;

        case 'intro':
          console.log('  → Intro playing, waiting...');
          await sleep(5000);
          break;

        case 'dialog':
          console.log('  → Advancing dialog (A)');
          await emulator.pressButton('a');
          await sleep(2000);
          break;

        case 'gender_selection':
          console.log('  → Confirming default gender (A)');
          await emulator.pressButton('a');
          await sleep(3000);
          break;

        case 'name_entry':
          console.log(`  → Typing player name: ${playerName}`);
          await typeName(emulator, playerName);
          await sleep(3000);
          break;

        case 'menu':
          console.log('  → Selecting New Game (A)');
          await emulator.pressButton('a');
          await sleep(3000);
          break;

        case 'overworld':
          console.log('  → In overworld! Game started!');
          await emulator.screenshot('overworld_reached');
          // We're done — save the game
          console.log('  → Opening menu to save...');
          await emulator.pressButton('start');
          await sleep(1000);
          // Navigate to Save
          for (let i = 0; i < 3; i++) {
            await emulator.pressButton('down');
            await sleep(200);
          }
          await emulator.pressButton('a');
          await sleep(2000);
          // Confirm save
          await emulator.pressButton('a');
          await sleep(3000);
          await emulator.screenshot('game_saved');
          console.log('\n[bootstrap] Game saved! Done.');
          return;

        case 'save_screen':
          console.log('  → Save screen, confirming...');
          await emulator.pressButton('a');
          await sleep(2000);
          break;

        case 'battle':
          console.log('  → In battle! Selecting FIGHT (A)');
          await emulator.pressButton('a');
          await sleep(2000);
          break;

        default: // unknown
          console.log('  → Unknown state, trying A...');
          await emulator.pressButton('a');
          await sleep(2000);
          break;
      }

      // Safety: if we've been on the same unknown state for too long, try B
      if (consecutiveSame > 8 && screen.phase === 'unknown') {
        console.log('  → Stuck on unknown, trying B...');
        await emulator.pressButton('b');
        await sleep(2000);
        consecutiveSame = 0;
      }
    }

    console.log(`\n[bootstrap] Reached max steps (${maxSteps}). Check captures/bootstrap/.`);

  } finally {
    await emulator.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
