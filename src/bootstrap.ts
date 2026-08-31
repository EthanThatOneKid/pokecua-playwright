/**
 * Bootstrap script: plays Pokemon Platinum through the intro to starter selection.
 * 
 * This is a one-shot hardcoded sequence to create a save file.
 * After this runs, the vision-guided decision loop can take over.
 * 
 * Usage:
 *   npx tsx src/bootstrap.ts roms/pokemon-platinum.nds --player-name ASH --rival-name GARY
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
import { Emulator } from './emulator';

interface BootstrapConfig {
  romPath: string;
  playerName: string;
  rivalName: string;
  outputDir: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  console.log('PokeCUA Bootstrap — Creating save file');
  console.log(`ROM: ${romPath}`);
  console.log(`Player: ${playerName}, Rival: ${rivalName}`);
  console.log('');

  const emulator = new Emulator(outputDir);

  try {
    await emulator.start({ romPath });
    console.log('[bootstrap] Emulator started, waiting for ROM to initialize...');
    await sleep(5000);

    // ============================================================
    // PHASE 1: Title screen → Menu → New Game
    // ============================================================
    console.log('\n[Phase 1] Title screen → New Game');

    // Press START to get past title screen
    console.log('  Pressing START...');
    await emulator.pressButton('start');
    await sleep(3000);

    // Press A to select New Game (or just START again)
    console.log('  Pressing A to select New Game...');
    await emulator.pressButton('a');
    await sleep(2000);

    // Capture to see where we are
    await emulator.screenshot('phase1_menu');

    // ============================================================
    // PHASE 2: Professor Rowan intro cutscene
    // ============================================================
    console.log('\n[Phase 2] Professor Rowan intro cutscene');
    console.log('  Waiting 15s for cutscene...');
    await sleep(15000);

    // Press A to advance through Rowan's dialogue
    console.log('  Advancing through dialogue...');
    for (let i = 0; i < 10; i++) {
      await emulator.pressButton('a');
      await sleep(1500);
      console.log(`    A press ${i + 1}/10`);
    }

    await emulator.screenshot('phase2_dialogue');

    // ============================================================
    // PHASE 3: Gender selection
    // ============================================================
    console.log('\n[Phase 3] Gender selection');
    console.log('  Pressing A to confirm default (male)...');
    await emulator.pressButton('a');
    await sleep(2000);

    // May need another A press to confirm
    await emulator.pressButton('a');
    await sleep(2000);

    await emulator.screenshot('phase3_gender');

    // ============================================================
    // PHASE 4: Name entry
    // ============================================================
    console.log('\n[Phase 4] Name entry');
    console.log(`  Typing player name: ${playerName}`);
    await typeName(emulator, playerName);
    await sleep(2000);

    await emulator.screenshot('phase4_player_name');

    // ============================================================
    // PHASE 5: Rival name entry
    // ============================================================
    console.log('\n[Phase 5] Rival name entry');
    console.log(`  Typing rival name: ${rivalName}`);
    await typeName(emulator, rivalName);
    await sleep(2000);

    await emulator.screenshot('phase5_rival_name');

    // ============================================================
    // PHASE 6: Confirm and wait for game to start
    // ============================================================
    console.log('\n[Phase 6] Confirming and waiting for game start');
    
    // Press A to confirm rival name
    await emulator.pressButton('a');
    await sleep(2000);

    // Press A through any remaining dialogue
    for (let i = 0; i < 5; i++) {
      await emulator.pressButton('a');
      await sleep(1500);
    }

    await emulator.screenshot('phase6_game_start');

    // ============================================================
    // PHASE 7: Navigate to overworld
    // ============================================================
    console.log('\n[Phase 7] Waiting for overworld to load');
    await sleep(5000);

    // Press A a few more times to advance through any remaining text
    for (let i = 0; i < 3; i++) {
      await emulator.pressButton('a');
      await sleep(1000);
    }

    await emulator.screenshot('phase7_overworld');

    console.log('\n[bootstrap] Done! Check captures/bootstrap/ for screenshots.');

  } finally {
    await emulator.stop();
  }
}

/**
 * Type a name using D-pad navigation on the NDS keyboard grid.
 * 
 * Pokemon Platinum keyboard layout (English, uppercase):
 * Row 0: A  B  C  D  E  F
 * Row 1: G  H  I  J  K  L
 * Row 2: M  N  O  P  Q  R
 * Row 3: S  T  U  V  W  X
 * Row 4: Y  Z  _  <-  OK
 * 
 * Cursor starts at A (0,0). Navigate with D-pad, press A to select.
 */
async function typeName(emulator: Emulator, name: string): Promise<void> {
  // Keyboard grid: 5 rows x 6 columns
  // Each cell is approximately 42px wide, 32px tall on the 256x192 bottom screen
  // But we use D-pad navigation, not touch coordinates

  const keyboard = [
    ['A', 'B', 'C', 'D', 'E', 'F'],
    ['G', 'H', 'I', 'J', 'K', 'L'],
    ['M', 'N', 'O', 'P', 'Q', 'R'],
    ['S', 'T', 'U', 'V', 'W', 'X'],
    ['Y', 'Z', ' ', 'DEL', 'END', ''],
  ];

  // Find position of each character
  let currentRow = 0;
  let currentCol = 0;

  for (const char of name.toUpperCase()) {
    // Find target position
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

    if (targetRow < 0) {
      console.log(`    Skipping unknown character: ${char}`);
      continue;
    }

    // Navigate to target
    const rowDiff = targetRow - currentRow;
    const colDiff = targetCol - currentCol;

    // Move vertically
    if (rowDiff > 0) {
      for (let i = 0; i < rowDiff; i++) {
        await emulator.pressButton('down');
        await sleep(100);
      }
    } else if (rowDiff < 0) {
      for (let i = 0; i < -rowDiff; i++) {
        await emulator.pressButton('up');
        await sleep(100);
      }
    }

    // Move horizontally
    if (colDiff > 0) {
      for (let i = 0; i < colDiff; i++) {
        await emulator.pressButton('right');
        await sleep(100);
      }
    } else if (colDiff < 0) {
      for (let i = 0; i < -colDiff; i++) {
        await emulator.pressButton('left');
        await sleep(100);
      }
    }

    // Select character
    await emulator.pressButton('a');
    await sleep(300);

    currentRow = targetRow;
    currentCol = targetCol;

    console.log(`    Typed: ${char}`);
  }

  // Navigate to END and press A to confirm
  console.log('    Navigating to END...');
  
  // Move to row 4 (END is at row 4, col 4)
  const endRow = 4;
  const endCol = 4;
  
  for (let i = 0; i < endRow - currentRow; i++) {
    await emulator.pressButton('down');
    await sleep(100);
  }
  for (let i = 0; i < currentRow - endRow; i++) {
    await emulator.pressButton('up');
    await sleep(100);
  }
  for (let i = 0; i < endCol - currentCol; i++) {
    await emulator.pressButton('right');
    await sleep(100);
  }
  for (let i = 0; i < currentCol - endCol; i++) {
    await emulator.pressButton('left');
    await sleep(100);
  }

  await emulator.pressButton('a');
  await sleep(500);
  console.log('    Name confirmed!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
