import * as dotenv from 'dotenv';
dotenv.config();
import * as path from 'path';
import { Emulator } from './src/emulator';
import { OpenRouterVisionProvider } from './src/providers';
import { ChangeDetector } from './src/detector';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const outputDir = path.join(process.cwd(), 'captures', 'or_test');
  const emulator = new Emulator(outputDir);
  const provider = new OpenRouterVisionProvider(process.env.OPENROUTER_API_KEY!);
  const detector = new ChangeDetector(emulator, provider, 15);

  await emulator.start({ romPath: 'roms/Pokemon - Platinum Version (USA) (Rev 1).nds' });
  console.log('ROM loaded, waiting 5s...');
  await sleep(5000);

  let introStuckCount = 0;
  let lastPhase = '';

  for (let step = 1; step <= 50; step++) {
    const t0 = Date.now();
    console.log(`\n--- Step ${step} [${detector.debug()}] ---`);
    const screen = await detector.detect(`step_${step}`);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Screen: ${screen.phase} (${screen.confidence}) [${screen.fromCache ? 'cached' : 'parsed'} ${elapsed}s] — ${(screen.description || '').substring(0, 100)}`);

    if (screen.phase === 'intro' && lastPhase === 'intro') introStuckCount++;
    else introStuckCount = 0;
    lastPhase = screen.phase;

    if (screen.confidence > 0) {
      switch (screen.phase) {
        case 'title':
          console.log('  → Pressing START');
          await emulator.pressButton('start');
          introStuckCount = 0;
          break;
        case 'intro':
          if (introStuckCount > 3) {
            console.log(`  → Intro stuck (${introStuckCount}x), pressing START`);
            await emulator.pressButton('start');
            introStuckCount = 0;
          } else {
            console.log('  → Intro, waiting...');
            await sleep(5000);
          }
          break;
        case 'dialog':
          console.log('  → Dialog (A)');
          await emulator.pressButton('a');
          break;
        case 'menu':
          console.log('  → Menu (A)');
          await emulator.pressButton('a');
          break;
        case 'gender_selection':
          console.log('  → GENDER SELECTION!');
          await emulator.screenshot('gender_reached');
          await emulator.stop();
          return;
        case 'overworld':
          console.log('  → OVERWORLD!');
          await emulator.screenshot('overworld_reached');
          await emulator.stop();
          return;
        default:
          console.log(`  → ${screen.phase}, pressing A`);
          await emulator.pressButton('a');
          break;
      }
    } else {
      console.log('  → fallback A');
      await emulator.pressButton('a');
    }
    await sleep(2000);
  }
  console.log('\nMax steps reached');
  await emulator.stop();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
