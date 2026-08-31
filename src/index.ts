/**
 * PokeCUA Playwright — Headless Pokemon agent via browser-based NDS emulator.
 * 
 * Usage:
 *   npx tsx src/index.ts <path-to-rom.nds> [--steps 100] [--output captures]
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
import { Emulator } from './emulator';
import { DecisionLoop } from './loop';
import { GroqVisionProvider, GeminiVisionProvider, OpenRouterVisionProvider, FallbackVisionProvider } from './providers';

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

  // Provider chain: OpenRouter (free) → Gemini → Groq
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GOOGLE_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  let parser;
  if (openrouterKey) {
    const fallbacks = [];
    if (geminiKey) fallbacks.push(new GeminiVisionProvider(geminiKey));
    if (groqKey) fallbacks.push(new GroqVisionProvider(groqKey));
    if (fallbacks.length > 0) {
      let chain: any = fallbacks[fallbacks.length - 1];
      for (let i = fallbacks.length - 2; i >= 0; i--) {
        chain = new FallbackVisionProvider(fallbacks[i], chain);
      }
      parser = new FallbackVisionProvider(new OpenRouterVisionProvider(openrouterKey), chain);
      console.log('[providers] OpenRouter → ' + fallbacks.map(f => f.name).join(' → '));
    } else {
      parser = new OpenRouterVisionProvider(openrouterKey);
      console.log('[providers] OpenRouter only');
    }
  } else if (geminiKey && groqKey) {
    parser = new FallbackVisionProvider(
      new GeminiVisionProvider(geminiKey),
      new GroqVisionProvider(groqKey),
    );
    console.log('[providers] Gemini → Groq');
  } else if (geminiKey) {
    parser = new GeminiVisionProvider(geminiKey);
    console.log('[providers] Gemini only');
  } else if (groqKey) {
    parser = new GroqVisionProvider(groqKey);
    console.log('[providers] Groq only');
  } else {
    console.error('No API key! Set OPENROUTER_API_KEY, GOOGLE_API_KEY, or GROQ_API_KEY in .env');
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
      visionProvider: parser,
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
