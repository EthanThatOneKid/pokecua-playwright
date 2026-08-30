/**
 * PokeCUA Playwright Controller
 * 
 * Launches a headless Chromium browser with the desmond NDS emulator,
 * loads a Pokemon ROM, and provides keyboard/touch/screenshot control.
 * 
 * All input goes to the browser tab — never touches the host keyboard.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EMULATOR_HTML = path.join(__dirname, 'emulator.html');
const OUTPUT_DIR = path.join(__dirname, 'captures');

class NDSController {
  constructor(page) {
    this.page = page;
    this.stepCount = 0;
  }

  /**
   * Load a ROM file into the emulator
   */
  async loadROM(romPath) {
    // Convert to file:// URL for the browser
    const absPath = path.resolve(romPath);
    const fileUrl = `file:///${absPath.replace(/\\/g, '/')}`;
    
    console.log(`Loading ROM: ${romPath}`);
    await this.page.evaluate((url) => window.pokecua.loadROM(url), fileUrl);
    
    // Wait for ROM to load
    await this.page.waitForFunction(() => window.pokecua.loaded === true, { timeout: 30000 });
    console.log('ROM loaded successfully');
  }

  /**
   * Press an NDS button (completely headless — browser tab only)
   */
  async pressButton(button, holdMs = 50) {
    await this.page.evaluate((btn) => window.pokecua.pressKey(btn), button.toLowerCase());
    await this.page.waitForTimeout(holdMs);
  }

  /**
   * Press a button multiple times
   */
  async pressButtonTimes(button, times, delayMs = 200) {
    for (let i = 0; i < times; i++) {
      await this.pressButton(button);
      if (i < times - 1) {
        await this.page.waitForTimeout(delayMs);
      }
    }
  }

  /**
   * Capture screenshot of the emulator canvas
   */
  async screenshot(label) {
    this.stepCount++;
    const filename = label || `step_${String(this.stepCount).padStart(3, '0')}`;
    
    // Get canvas data URL from Desmond
    const dataUrl = await this.page.evaluate(() => window.pokecua.screenshot());
    
    if (!dataUrl) {
      console.warn(`  [${filename}] No canvas found`);
      return null;
    }

    // Convert data URL to buffer and save
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outPath = path.join(OUTPUT_DIR, `${filename}.png`);
    fs.writeFileSync(outPath, buffer);
    
    console.log(`  [${filename}] ${buffer.length} bytes -> ${filename}.png`);
    return outPath;
  }

  /**
   * Type a name on the NDS touch keyboard
   * (Pokemon Platinum keyboard coordinates)
   */
  async typeName(name) {
    const KEYBOARD = {
      'A': [16, 100], 'B': [48, 100], 'C': [80, 100], 'D': [112, 100],
      'E': [144, 100], 'F': [176, 100], 'G': [208, 100], 'H': [240, 100],
      'I': [16, 120], 'J': [48, 120], 'K': [80, 120], 'L': [112, 120],
      'M': [144, 120], 'N': [176, 120], 'O': [208, 120], 'P': [240, 120],
      'Q': [16, 140], 'R': [48, 140], 'S': [80, 140], 'T': [112, 140],
      'U': [144, 140], 'V': [176, 140], 'W': [208, 140], 'X': [240, 140],
      'Y': [16, 160], 'Z': [48, 160],
      'OK': [208, 170],
    };

    console.log(`  Typing: ${name}`);
    for (const char of name.toUpperCase()) {
      if (KEYBOARD[char]) {
        const [x, y] = KEYBOARD[char];
        // Click on the NDS bottom screen
        // Desmond canvas dimensions may vary, so we use relative coords
        await this.page.evaluate(({x, y}) => {
          const canvas = document.querySelector('desmond-player').shadowRoot.querySelector('canvas');
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            // Map NDS coords to canvas coords (bottom half of canvas)
            const clickX = rect.left + (x / 256) * rect.width;
            const clickY = rect.top + rect.height * 0.5 + (y / 192) * rect.height * 0.5;
            canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: clickX, clientY: clickY, bubbles: true }));
            canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: clickX, clientY: clickY, bubbles: true }));
          }
        }, { x, y });
        await this.page.waitForTimeout(250);
        process.stdout.write(`    ${char}`);
      }
    }
    console.log();

    // Press OK
    await this.page.waitForTimeout(300);
    await this.page.evaluate(() => {
      const canvas = document.querySelector('desmond-player').shadowRoot.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const clickX = rect.left + (208 / 256) * rect.width;
        const clickY = rect.top + rect.height * 0.5 + (170 / 192) * rect.height * 0.5;
        canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: clickX, clientY: clickY, bubbles: true }));
        canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: clickX, clientY: clickY, bubbles: true }));
      }
    });
    await this.page.waitForTimeout(1000);
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const romPath = args[0];
  
  if (!romPath) {
    console.error('Usage: node play.js <path-to-rom.nds>');
    process.exit(1);
  }

  console.log('Launching headless browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  
  // Load the emulator page
  await page.goto(`file:///${EMULATOR_HTML.replace(/\\/g, '/')}`);
  await page.waitForTimeout(1000);

  const nds = new NDSController(page);

  try {
    // Load ROM
    await nds.loadROM(romPath);
    await nds.screenshot('00_loaded');

    // Wait for game to initialize
    console.log('\nWaiting 20s for game to initialize...');
    await page.waitForTimeout(20000);
    await nds.screenshot('01_boot');

    // Phase 1: Z presses to get past title
    console.log('\n--- Phase 1: Z presses (40x) ---');
    for (let i = 0; i < 40; i++) {
      await nds.pressButton('a');
      await page.waitForTimeout(400);
      if ([0, 10, 20, 30, 39].includes(i)) {
        await nds.screenshot(`02_z_${String(i).padStart(3, '0')}`);
      }
    }

    // Phase 2: Enter+Z to skip cutscenes
    console.log('\n--- Phase 2: Enter+Z combo (30x) ---');
    for (let i = 0; i < 30; i++) {
      await nds.pressButton('start');
      await page.waitForTimeout(300);
      await nds.pressButton('a');
      await page.waitForTimeout(500);
      if ([0, 10, 20, 29].includes(i)) {
        await nds.screenshot(`03_combo_${String(i).padStart(3, '0')}`);
      }
    }

    await nds.screenshot('04_before_name');

    // Phase 3: Z presses for name prompt
    console.log('\n--- Phase 3: Z presses (20x) ---');
    for (let i = 0; i < 20; i++) {
      await nds.pressButton('a');
      await page.waitForTimeout(500);
      if ([0, 10, 19].includes(i)) {
        await nds.screenshot(`05_name_prompt_${String(i).padStart(3, '0')}`);
      }
    }

    // Phase 4: Type player name
    console.log('\n--- Phase 4: Type player name ---');
    await nds.screenshot('06_name_entry');
    await nds.typeName('ASH');
    await nds.screenshot('07_after_player_name');

    // Phase 5: Type rival name
    console.log('\n--- Phase 5: Type rival name ---');
    await page.waitForTimeout(1000);
    await nds.screenshot('08_rival_name');
    await nds.typeName('GARY');
    await nds.screenshot('09_after_rival_name');

    console.log('\n' + '='.repeat(60));
    console.log(`Done! Screenshots saved to ${OUTPUT_DIR}`);

  } catch (err) {
    console.error('Error:', err.message);
    await nds.screenshot('error');
  } finally {
    await browser.close();
  }
}

// Export for programmatic use
module.exports = { NDSController };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
