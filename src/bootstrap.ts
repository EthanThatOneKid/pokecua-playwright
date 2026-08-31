/**
 * Bootstrap: deterministic intro sequence — no vision API calls.
 *
 * Waits through the title cutscene, presses START, selects New Game.
 * After this, the generalized vision loop takes over for dialogue,
 * gender selection, name entry, etc.
 *
 * Usage:
 *   npx tsx src/bootstrap.ts <rom.nds>
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
import { Emulator } from './emulator';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type a name using D-pad navigation on the NDS keyboard grid */
export async function typeName(emulator: Emulator, name: string): Promise<void> {
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

/**
 * Run the deterministic bootstrap sequence.
 * Returns the Emulator instance for the loop to continue using.
 */
export async function runBootstrap(romPath: string, outputDir: string): Promise<Emulator> {
  const emulator = new Emulator(outputDir);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PokeCUA Bootstrap — Deterministic intro sequence');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ROM: ${romPath}\n`);

  await emulator.start({ romPath });
  console.log('[bootstrap] ROM loaded');

  // Step 1: Wait for title cutscene to finish (~60s)
  console.log('[bootstrap] Waiting 60s for title cutscene to finish...');
  await sleep(60_000);
  console.log('[bootstrap] Cutscene wait complete');

  // Step 2: Press START to open menu
  console.log('[bootstrap] Pressing START...');
  await emulator.pressButton('start');
  await sleep(3_000);

  // Step 3: Press A to select New Game
  console.log('[bootstrap] Pressing A (New Game)...');
  await emulator.pressButton('a');
  await sleep(3_000);

  // Capture a screenshot so we can verify where we are
  await emulator.screenshot('after_bootstrap');
  console.log('[bootstrap] Bootstrap complete — vision loop takes over\n');

  return emulator;
}

// If run directly, execute bootstrap and exit
if (require.main === module) {
  const args = process.argv.slice(2);
  const romPath = args.find((a) => !a.startsWith('--'));
  if (!romPath) {
    console.error('Usage: npx tsx src/bootstrap.ts <rom.nds>');
    process.exit(1);
  }

  const outputDir = path.join(process.cwd(), 'captures', 'bootstrap');
  runBootstrap(romPath, outputDir)
    .then(async (emulator) => {
      await emulator.stop();
      console.log('[bootstrap] Emulator stopped');
    })
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
