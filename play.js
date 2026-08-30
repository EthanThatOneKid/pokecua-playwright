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
const http = require('http');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.nds': 'application/octet-stream' };

class NDSController {
  constructor(page, server) {
    this.page = page;
    this.server = server;
    this.stepCount = 0;
  }

  async pressButton(button, holdMs = 50) {
    // Desmond keyboard mapping
    const keyMap = {
      'a': 'a', 'b': 'b', 'x': 'x', 'y': 'y',
      'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight',
      'start': 'Enter', 'select': 'Backspace', 'l': 'q', 'r': 'w',
    };
    const key = keyMap[button.toLowerCase()] || button;
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(holdMs);
  }

  async pressButtonTimes(button, times, delayMs = 200) {
    for (let i = 0; i < times; i++) {
      await this.pressButton(button);
      if (i < times - 1) await this.page.waitForTimeout(delayMs);
    }
  }

  async screenshot(label) {
    this.stepCount++;
    const filename = label || `step_${String(this.stepCount).padStart(3, '0')}`;
    const outDir = path.join(__dirname, 'captures');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${filename}.png`);
    
    // Try canvas capture first, fall back to page screenshot
    const canvasData = await this.page.evaluate(() => {
      const player = document.querySelector('desmond-player');
      if (!player || !player.shadowRoot) return null;
      const canvas = player.shadowRoot.querySelector('canvas');
      return canvas ? canvas.toDataURL('image/png') : null;
    }).catch(() => null);

    if (canvasData) {
      const base64 = canvasData.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    } else {
      await this.page.screenshot({ path: outPath });
    }

    const stats = fs.statSync(outPath);
    console.log(`  [${filename}] ${stats.size} bytes`);
    return outPath;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const romPath = args[0];

  if (!romPath) {
    console.error('Usage: node play.js <path-to-rom.nds>');
    process.exit(1);
  }

  const absRom = path.resolve(romPath);
  if (!fs.existsSync(absRom)) {
    console.error(`ROM not found: ${absRom}`);
    process.exit(1);
  }

  // Start HTTP server
  const MIME_ALL = { ...MIME };
  const server = http.createServer((req, res) => {
    let filePath;
    if (req.url === '/') {
      filePath = path.join(__dirname, 'emulator.html');
    } else {
      filePath = path.join(__dirname, decodeURIComponent(req.url));
    }
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME_ALL[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  console.log(`HTTP server on port ${port}`);

  // Launch browser
  console.log('Launching headless Chromium...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));

  // Load emulator
  console.log('Loading emulator page...');
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(5000);

  console.log(`Console: ${logs.join('\n          ')}`);

  const nds = new NDSController(page, server);

  try {
    // Load ROM
    console.log(`\nLoading ROM: ${romPath}`);
    const romUrl = `http://localhost:${port}/rom.nds`;
    // Serve the ROM through our HTTP server by creating a symlink or copying
    const romLink = path.join(__dirname, 'rom.nds');
    if (!fs.existsSync(romLink)) {
      fs.copyFileSync(absRom, romLink);
    }

    // Tell desmond to load the ROM
    await page.evaluate(() => {
      const player = document.querySelector('desmond-player');
      if (player) {
        player.loadURL('/rom.nds', function() {
          document.getElementById('status').textContent = 'ROM loaded!';
          document.getElementById('status').className = 'ready';
          console.log('ROM loaded successfully');
        });
      }
    });

    // Wait for ROM to load
    console.log('Waiting for ROM to load...');
    await page.waitForTimeout(15000);
    await nds.screenshot('00_loaded');

    // Phase 1: Z presses to get past title
    console.log('\n--- Phase 1: Z presses (40x) ---');
    for (let i = 0; i < 40; i++) {
      await nds.pressButton('a');
      await page.waitForTimeout(400);
      if ([0, 10, 20, 30, 39].includes(i)) {
        await nds.screenshot(`01_z_${String(i).padStart(3, '0')}`);
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
        await nds.screenshot(`02_combo_${String(i).padStart(3, '0')}`);
      }
    }

    await nds.screenshot('03_final');

    console.log('\n' + '='.repeat(60));
    console.log('Done!');

  } catch (err) {
    console.error('Error:', err.message);
    await nds.screenshot('error');
  } finally {
    await browser.close();
    server.close();
    // Clean up ROM copy
    const romLink = path.join(__dirname, 'rom.nds');
    if (fs.existsSync(romLink)) fs.unlinkSync(romLink);
  }
}

module.exports = { NDSController };

if (require.main === module) {
  main().catch(console.error);
}
