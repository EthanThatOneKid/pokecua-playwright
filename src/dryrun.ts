/**
 * Dry-run capture mode: captures screenshots at every step without
 * calling any vision APIs. Used to build a ground-truth timeline of
 * what happens after each button press.
 *
 * Usage:
 *   npx tsx src/dryrun.ts roms/Pokemon\ -\ Platinum\ Version\ \(USA\)\ \(Rev\ 1\).nds
 *
 * Output:
 *   captures/dryrun/ — PNG files named by step number and button pressed
 *   captures/dryrun/timeline.json — structured log of every step
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();
import { Emulator } from './emulator';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TimelineEntry {
  step: number;
  action: string;
  timestamp: number;
  waitBeforeMs: number;
  captureAfterMs: number;
  screenshotPath: string;
}

async function main() {
  const romPath = process.argv[2] || 'roms/Pokemon - Platinum Version (USA) (Rev 1).nds';
  const outputDir = path.join(process.cwd(), 'captures', 'dryrun');
  const timeline: TimelineEntry[] = [];

  fs.mkdirSync(outputDir, { recursive: true });

  const emulator = new Emulator(outputDir);
  await emulator.start({ romPath });
  console.log(`ROM loaded. Output: ${outputDir}\n`);

  // Wait for title screen to appear
  console.log('Waiting 35s for title screen...');
  await sleep(35000);

  // Define the intro sequence to capture
  // Each entry: [button, waitAfterMs, description]
  const sequence: Array<[string, number, string]> = [
    // Title screen → press START to open menu
    ['start', 3000, 'Press START on title screen'],

    // Capture the menu — what options appear?
    // In Pokemon Platinum, the menu shows: New Game, Continue, Options
    // We need to select "New Game" — it's usually the first option
    ['a', 3000, 'Press A (select New Game from menu)'],

    // Professor Rowan intro dialogue — press A to advance
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],
    ['a', 2000, 'Press A (advance Rowan dialogue)'],

    // Gender selection should appear
    ['a', 3000, 'Press A (confirm gender selection)'],

    // Name entry should appear — type a name
    // We'll just press A a few times to see what happens
    ['a', 2000, 'Press A (name entry interaction)'],
    ['a', 2000, 'Press A (name entry interaction)'],
    ['a', 2000, 'Press A (name entry interaction)'],
    ['a', 2000, 'Press A (name entry interaction)'],
    ['a', 2000, 'Press A (name entry interaction)'],
  ];

  let step = 0;

  // First, capture the title screen before any input
  step++;
  const titlePath = await emulator.screenshot(`step_${String(step).padStart(3, '0')}_title`);
  timeline.push({
    step,
    action: 'none (title screen)',
    timestamp: Date.now(),
    waitBeforeMs: 35000,
    captureAfterMs: 0,
    screenshotPath: titlePath,
  });
  console.log(`Step ${step}: Title screen captured`);

  // Now run through the sequence
  for (const [button, waitMs, desc] of sequence) {
    step++;
    console.log(`Step ${step}: ${desc}...`);

    // Press the button
    await emulator.pressButton(button);

    // Wait for the game to respond
    await sleep(waitMs);

    // Capture the result
    const label = `step_${String(step).padStart(3, '0')}_${button}`;
    const screenshotPath = await emulator.screenshot(label);

    timeline.push({
      step,
      action: button,
      timestamp: Date.now(),
      waitBeforeMs: waitMs,
      captureAfterMs: waitMs,
      screenshotPath,
    });

    console.log(`  → Captured: ${path.basename(screenshotPath)}`);
  }

  // Save timeline
  const timelinePath = path.join(outputDir, 'timeline.json');
  fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
  console.log(`\nTimeline saved to ${timelinePath}`);
  console.log(`Total captures: ${step}`);
  console.log(`\nTo analyze: open captures/dryrun/ and look at the PNG files.`);

  await emulator.stop();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
