/**
 * PokeCUA Playwright — Headless Pokemon agent via browser-based NDS emulator.
 * 
 * Usage:
 *   npx tsx src/index.ts <path-to-rom.nds> [--steps 100] [--output captures]
 */

import * as path from 'path';
import { Emulator } from './emulator';
import { DecisionLoop } from './loop';

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const romPath = args.find((a) => !a.startsWith('--'));
  if (!romPath) {
    console.error('Usage: npx tsx src/index.ts <path-to-rom.nds> [--steps N] [--output dir]');
    process.exit(1);
  }

  const stepsIdx = args.indexOf('--steps');
  const maxSteps = stepsIdx >= 0 ? parseInt(args[stepsIdx + 1]) : 100;

  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : path.join(process.cwd(), 'captures');

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('GROQ_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('PokeCUA Playwright — Headless Pokemon Agent');
  console.log(`ROM: ${romPath}`);
  console.log(`Steps: ${maxSteps}`);
  console.log(`Output: ${outputDir}`);
  console.log('');

  const emulator = new Emulator(outputDir);

  try {
    // Start emulator
    await emulator.start({ romPath });

    // Create and run decision loop
    const loop = new DecisionLoop(emulator, {
      maxSteps,
      cycleDelayMs: 2000,
      outputDir,
      groqApiKey: apiKey,
    });

    const decisions = await loop.run();

    // Save results
    loop.saveHistory();

    // Summary
    const phases = decisions.map((d) => d.state.phase);
    const uniquePhases = [...new Set(phases)];
    console.log('Phases visited:', uniquePhases.join(', '));
    console.log(`Total decisions: ${decisions.length}`);

  } finally {
    await emulator.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
