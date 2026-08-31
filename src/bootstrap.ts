/**
 * Bootstrap script: plays Pokemon Platinum through intro to starter selection.
 * 
 * Polls screen stability, detects loops, presses START multiple times to catch
 * the right frame in the title animation.
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Get the number of unique colors in an image (cheap, no API needed) */
function getImageColors(imagePath: string): number {
  try {
    const result = execSync(
      `python -c "from PIL import Image; img=Image.open('${imagePath.replace(/\\/g, '/')}'); print(len(img.getcolors(maxcolors=100000)))"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}

/** Wait for screen to stabilize or change significantly */
async function waitForChange(
  emulator: Emulator,
  label: string,
  maxWaitMs: number = 30000,
  pollIntervalMs: number = 1000,
): Promise<{ colors: number; duration: number }> {
  const start = Date.now();
  let prevColors = -1;
  let stableCount = 0;

  while (Date.now() - start < maxWaitMs) {
    const tmpPath = await emulator.screenshot(`${label}_poll`);
    const colors = getImageColors(tmpPath);
    fs.unlinkSync(tmpPath);

    if (colors === prevColors && colors > 1) {
      stableCount++;
      if (stableCount >= 3) {
        return { colors, duration: Date.now() - start };
      }
    } else {
      stableCount = 0;
    }

    // If colors changed dramatically, something happened
    if (prevColors > 0 && Math.abs(colors - prevColors) > 50) {
      console.log(`    [${label}] Screen changed: ${prevColors} → ${colors} colors`);
      return { colors, duration: Date.now() - start };
    }

    prevColors = colors;
    await sleep(pollIntervalMs);
  }

  return { colors: prevColors, duration: Date.now() - start };
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
  console.log(`Player: ${playerName}, Rival: ${rivalName}\n`);

  const emulator = new Emulator(outputDir);

  try {
    await emulator.start({ romPath });
    console.log('[bootstrap] ROM loaded, waiting for init...\n');
    await sleep(5000);

    // ============================================================
    // PHASE 1: Get past title screen into menu
    // ============================================================
    console.log('[Phase 1] Title screen → Menu');
    
    // Press START repeatedly to catch the right frame in the title animation
    console.log('  Pressing START repeatedly...');
    for (let i = 0; i < 5; i++) {
      await emulator.pressButton('start');
      await sleep(500);
    }

    // Wait and check if screen changed
    const r1 = await waitForChange(emulator, 'phase1', 10000);
    console.log(`  After STARTs: ${r1.colors} colors`);

    // If still on title (30 colors), try pressing A instead
    if (r1.colors >= 25 && r1.colors <= 35) {
      console.log('  Still on title, trying A press...');
      for (let i = 0; i < 3; i++) {
        await emulator.pressButton('a');
        await sleep(500);
      }
      const r1b = await waitForChange(emulator, 'phase1b', 10000);
      console.log(`  After A: ${r1b.colors} colors`);
    }

    // ============================================================
    // PHASE 2: Wait for intro cutscene / dialogue to start
    // ============================================================
    console.log('\n[Phase 2] Waiting for game to advance from title/menu');
    console.log('  Polling screen for changes (may take a while)...');

    let advancedPastTitle = false;
    let attempts = 0;
    const maxAttempts = 20;

    while (!advancedPastTitle && attempts < maxAttempts) {
      attempts++;
      
      // Check current screen
      const tmpPath = await emulator.screenshot('check');
      const colors = getImageColors(tmpPath);
      fs.unlinkSync(tmpPath);

      console.log(`  Attempt ${attempts}: ${colors} colors`);

      // Title screen is ~30 colors, intro cutscene has more variety
      if (colors > 100) {
        console.log('  Screen changed significantly — game advanced!');
        advancedPastTitle = true;
        break;
      }

      // Try pressing different buttons to advance
      if (colors <= 35) {
        // Still on title or similar — press START
        await emulator.pressButton('start');
        await sleep(1000);
      } else {
        // Some progress — press A to advance
        await emulator.pressButton('a');
        await sleep(1000);
      }
    }

    if (!advancedPastTitle) {
      console.log('  WARNING: Could not advance past title after ' + maxAttempts + ' attempts');
    }

    // Wait for intro cutscene to play out
    console.log('\n  Waiting for intro cutscene to finish...');
    const r2 = await waitForChange(emulator, 'phase2', 60000, 2000);
    console.log(`  Intro settled: ${r2.colors} colors`);

    // ============================================================
    // PHASE 3: Advance through dialogue
    // ============================================================
    console.log('\n[Phase 3] Advancing through dialogue');

    let dialogCycles = 0;
    const maxDialogCycles = 40;
    let lastColors = -1;
    let sameCount = 0;

    while (dialogCycles < maxDialogCycles) {
      await emulator.pressButton('a');
      await sleep(1500);

      const tmpPath = await emulator.screenshot('dialog_check');
      const colors = getImageColors(tmpPath);
      fs.unlinkSync(tmpPath);

      if (colors === lastColors) {
        sameCount++;
      } else {
        sameCount = 0;
      }
      lastColors = colors;

      console.log(`    Dialog ${dialogCycles + 1}: ${colors} colors`);

      // If we've been on the same screen for 5 cycles, something is stuck
      if (sameCount >= 5) {
        console.log('  Stuck on same screen — trying different input');
        await emulator.pressButton('start');
        await sleep(1000);
        sameCount = 0;
        continue;
      }

      // Big change = moved to next phase
      if (colors > 200) {
        console.log('  Major screen change — moving to next phase');
        break;
      }

      dialogCycles++;
    }

    // ============================================================
    // PHASE 4: Gender selection
    // ============================================================
    console.log('\n[Phase 4] Gender selection');
    const r4 = await waitForChange(emulator, 'phase4', 30000);
    console.log(`  Gender screen: ${r4.colors} colors`);

    // Confirm default (male)
    await emulator.pressButton('a');
    await sleep(3000);

    // Wait for name entry
    const r4b = await waitForChange(emulator, 'phase4b', 20000);
    console.log(`  After gender: ${r4b.colors} colors`);

    // ============================================================
    // PHASE 5: Name entry
    // ============================================================
    console.log(`\n[Phase 5] Name entry — typing: ${playerName}`);
    await typeName(emulator, playerName);
    await sleep(3000);

    const r5 = await waitForChange(emulator, 'phase5', 20000);
    console.log(`  After player name: ${r5.colors} colors`);

    // ============================================================
    // PHASE 6: Rival name entry
    // ============================================================
    console.log(`\n[Phase 6] Rival name entry — typing: ${rivalName}`);
    await typeName(emulator, rivalName);
    await sleep(3000);

    // ============================================================
    // PHASE 7: Confirm and wait for overworld
    // ============================================================
    console.log('\n[Phase 7] Confirming rival name and waiting for overworld');
    await emulator.pressButton('a');
    await sleep(5000);

    const r7 = await waitForChange(emulator, 'phase7', 60000, 2000);
    console.log(`  Game state: ${r7.colors} colors`);

    // Press A through remaining text
    for (let i = 0; i < 5; i++) {
      await emulator.pressButton('a');
      await sleep(2000);
    }

    const finalResult = await waitForChange(emulator, 'final', 30000, 2000);
    await emulator.screenshot('final');

    console.log('\n[bootstrap] Done!');
    console.log('Final screen:', finalResult.colors, 'colors');
    console.log('Check captures/bootstrap/ for screenshots.');

  } finally {
    await emulator.stop();
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

    if (targetRow < 0) {
      console.log(`    Skipping: ${char}`);
      continue;
    }

    // Navigate with D-pad
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
  console.log('    Navigating to END...');
  for (let i = 0; i < 4 - currentRow; i++) {
    await emulator.pressButton('down');
    await sleep(100);
  }
  for (let i = 0; i < currentCol - 4; i++) {
    await emulator.pressButton('left');
    await sleep(100);
  }
  for (let i = 0; i < 4 - currentCol; i++) {
    await emulator.pressButton('right');
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
