/**
 * PokeCUA Playwright — Headless Pokemon agent via browser-based NDS emulator.
 *
 * Two phases:
 *   1. Bootstrap (deterministic): wait 60s, START, A → New Game
 *   2. Loop (vision-guided): dialogue, gender, names, overworld
 *
 * Usage:
 *   npx tsx src/index.ts <rom.nds> [--steps 100] [--player-name ASH] [--rival-name GARY]
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
import { runBootstrap } from './bootstrap';
import { DecisionLoop } from './loop';
import { ChangeDetector } from './detector';
import { Emulator } from './emulator';
import { GroqVisionProvider, GeminiVisionProvider, OpenRouterVisionProvider, FallbackVisionProvider } from './providers';

async function main() {
  const args = process.argv.slice(2);

  const romPath = args.find((a) => !a.startsWith('--'));
  if (!romPath) {
    console.error('Usage: npx tsx src/index.ts <rom.nds> [--steps N] [--player-name ASH] [--rival-name GARY]');
    process.exit(1);
  }

  const stepsIdx = args.indexOf('--steps');
  const maxSteps = stepsIdx >= 0 ? parseInt(args[stepsIdx + 1]) : 100;

  const nameIdx = args.indexOf('--player-name');
  const playerName = nameIdx >= 0 ? args[nameIdx + 1] : 'ASH';
  const rivalIdx = args.indexOf('--rival-name');
  const rivalName = rivalIdx >= 0 ? args[rivalIdx + 1] : 'GARY';

  const outputDir = path.join(process.cwd(), 'captures');

  // Build provider chain
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
  console.log(`Player: ${playerName}, Rival: ${rivalName}`);
  console.log(`Steps: ${maxSteps}\n`);

  // Phase 1: Bootstrap (deterministic, no vision)
  const emulator = await runBootstrap(romPath, outputDir);
  globalEmulator = emulator;

  try {
    // Phase 2: Decision loop (vision-guided)
    const detector = new ChangeDetector(emulator, parser, maxSteps);
    const loop = new DecisionLoop(emulator, detector, {
      maxSteps,
      cycleDelayMs: 2000,
      outputDir,
      visionProvider: parser,
      playerName,
      rivalName,
    });

    const decisions = await loop.run();
    loop.saveHistory();

    const phases = decisions.map((d) => d.state.phase);
    const uniquePhases = [...new Set(phases)];
    console.log('Phases visited:', uniquePhases.join(', '));
    console.log(`Total decisions: ${decisions.length}`);

  } finally {
    await emulator.stop();
  }
}

let globalEmulator: Emulator | null = null;

// Cleanup on crash or SIGINT — kill orphaned Chrome processes
process.on('SIGINT', async () => {
  console.log('\n[shutdown] SIGINT received, cleaning up...');
  if (globalEmulator) await globalEmulator.stop();
  process.exit(0);
});
process.on('uncaughtException', async (err) => {
  console.error('[shutdown] Uncaught exception:', err);
  if (globalEmulator) await globalEmulator.stop();
  process.exit(1);
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
