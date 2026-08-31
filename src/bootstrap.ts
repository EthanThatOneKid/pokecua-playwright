/**
 * Bootstrap: plays Pokemon Platinum through intro to starter selection.
 * 
 * Uses ChangeDetector for:
 * 1. Pixel diff detection — only parse when screen changes (saves tokens)
 * 2. Rate-limit-aware backoff — exponential backoff on 429
 * 3. Fallback state machine — estimated phase when vision is unavailable
 * 
 * Usage:
 *   npx tsx src/bootstrap.ts roms/pokemon-platinum.nds --player-name ASH --rival-name GARY
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();
import { spawn } from 'child_process';
import { Emulator } from './emulator';
import { ChangeDetector } from './detector';
import { GroqVisionProvider, GeminiVisionProvider, OpenRouterVisionProvider, FallbackVisionProvider } from './providers';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(cmd: string, args: string[], input?: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve(code === 0 ? stdout : ''));
    child.on('error', () => resolve(''));
    if (input) child.stdin.write(input);
    child.stdin.end();
    setTimeout(() => { child.kill(); resolve(''); }, timeoutMs);
  });
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

  // Provider chain: OpenRouter (free, 50 req/day) → Gemini → Groq
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const geminiKey = process.env.GOOGLE_API_KEY;
  const groqKey = process.env.GROQ_API_KEY;

  let parser;
  if (openrouterKey) {
    // OpenRouter as primary — free vision models, 50 req/day
    const fallbacks = [];
    if (geminiKey) fallbacks.push(new GeminiVisionProvider(geminiKey));
    if (groqKey) fallbacks.push(new GroqVisionProvider(groqKey));

    if (fallbacks.length > 0) {
      // Chain fallbacks: Gemini → Groq
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

  const detector = new ChangeDetector(emulator, parser);

  try {
    await emulator.start({ romPath });
    console.log('[bootstrap] ROM loaded, waiting for init...\n');
    await sleep(5000);

    // ============================================================
    // LOOP: Detect → Decide → Act → Repeat
    // ============================================================
    let step = 0;
    const maxSteps = 100;

    while (step < maxSteps) {
      step++;
      console.log(`\n--- Step ${step} [${detector.debug()}] ---`);

      // DETECT: What's on screen? (with pixel diff + rate limit awareness)
      const screen = await detector.detect(`step_${step}`);
      const source = screen.fromCache ? 'cached' : 'parsed';
      console.log(`  Screen: ${screen.phase} (${screen.confidence}) [${source}] — ${screen.description.substring(0, 80)}`);

      // DECIDE + ACT
      let action: string;

      if (screen.confidence > 0) {
        // Vision gave us a confident answer — use it
        action = await actOnPhase(emulator, screen.phase, playerName, detector);
      } else {
        // Vision unavailable — use fallback state machine
        const fallback = detector.getFallbackAction();
        console.log(`  → Fallback: ${fallback.reasoning}`);
        await emulator.pressButton(fallback.button);
        detector.recordAction(fallback.button);
        action = fallback.button;
        await sleep(2000);
      }

      // Record this screen + action in history for next parse
      detector.addHistoryEntry(screen.phase, action, screen.description);

      // Check for terminal state
      if (screen.phase === 'overworld' && screen.confidence > 0.5) {
        console.log('\n[bootstrap] Reached overworld! Saving game...');
        await saveGame(emulator);
        await emulator.screenshot('game_saved');
        console.log('[bootstrap] Game saved! Done.');
        return;
      }

      // Check for save screen
      if (screen.phase === 'save_screen' && screen.confidence > 0.5) {
        console.log('\n[bootstrap] Save screen! Confirming...');
        await emulator.pressButton('a');
        await sleep(3000);
        await emulator.screenshot('game_saved');
        console.log('[bootstrap] Game saved! Done.');
        return;
      }
    }

    console.log(`\n[bootstrap] Reached max steps (${maxSteps}). Check captures/bootstrap/.`);

  } finally {
    await emulator.stop();
  }
}

/** Execute action based on detected phase */
async function actOnPhase(
  emulator: Emulator,
  phase: string,
  playerName: string,
  detector: ChangeDetector,
): Promise<string> {
  switch (phase) {
    case 'title':
      console.log('  → Pressing START');
      await emulator.pressButton('start');
      detector.recordAction('start');
      await sleep(3000);
      return 'start';

    case 'intro':
      console.log('  → Intro playing, waiting...');
      detector.recordAction('wait');
      await sleep(5000);
      return 'wait';

    case 'dialog':
      console.log('  → Advancing dialog (A)');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(2000);
      return 'a';

    case 'gender_selection':
      console.log('  → Confirming default gender (A)');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(3000);
      return 'a';

    case 'name_entry':
      console.log(`  → Typing player name: ${playerName}`);
      await typeName(emulator, playerName);
      detector.recordAction('typeName');
      await sleep(3000);
      return 'typeName';

    case 'menu':
      console.log('  → Selecting New Game (A)');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(3000);
      return 'a';

    case 'overworld':
      console.log('  → In overworld!');
      detector.recordAction('overworld');
      return 'overworld';

    case 'save_screen':
      console.log('  → Save screen (A)');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(2000);
      return 'a';

    case 'battle':
      console.log('  → In battle! Selecting FIGHT (A)');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(2000);
      return 'a';

    default:
      console.log('  → Unknown, trying A...');
      await emulator.pressButton('a');
      detector.recordAction('a');
      await sleep(2000);
      return 'a';
  }
}

/** Save game via in-game menu */
async function saveGame(emulator: Emulator): Promise<void> {
  await emulator.pressButton('start');
  await sleep(1000);
  // Navigate to Save (down 3 times)
  for (let i = 0; i < 3; i++) {
    await emulator.pressButton('down');
    await sleep(200);
  }
  await emulator.pressButton('a');
  await sleep(2000);
  // Confirm save
  await emulator.pressButton('a');
  await sleep(3000);
  // Close menu
  await emulator.pressButton('b');
  await sleep(500);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
