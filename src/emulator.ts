/**
 * Headless NDS emulator controller using Playwright + desmond.
 * 
 * All input stays in the browser tab — host keyboard is never touched.
 */

import { chromium, Browser, Page } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EmulatorConfig } from './types';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.nds': 'application/octet-stream',
};

export class Emulator {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private server: http.Server | null = null;
  private port = 0;
  private stepCount = 0;
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
    fs.mkdirSync(outputDir, { recursive: true });
  }

  /** Start the HTTP server and browser */
  async start(config: EmulatorConfig): Promise<void> {
    // Start HTTP server — serves from project root + node_modules
    const projectRoot = path.resolve(__dirname, '..');
    this.server = http.createServer((req, res) => {
      const url = req.url || '/';
      let filePath: string;
      if (url === '/') {
        filePath = path.join(projectRoot, 'emulator.html');
      } else {
        const decoded = decodeURIComponent(url);
        // Resolve relative to project root (covers /node_modules/... paths too)
        filePath = path.join(projectRoot, decoded);
      }
      if (!fs.existsSync(filePath)) {
        console.log(`[HTTP] 404: ${url}`);
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = path.extname(filePath) || '.html';
      const contentType: string = (MIME as Record<string, string>)[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, resolve));
    this.port = (this.server.address() as any).port;
    console.log(`[emulator] HTTP server on port ${this.port}`);

    // Launch browser
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage({
      viewport: config.viewport || { width: 800, height: 600 },
    });

    // Load emulator page
    await this.page.goto(`http://localhost:${this.port}/`);
    await this.page.waitForTimeout(5000);

    // Copy ROM to project root for serving
    const romAbs = path.resolve(config.romPath);
    const romDest = path.join(projectRoot, 'rom.nds');
    if (!fs.existsSync(romDest)) {
      fs.copyFileSync(romAbs, romDest);
    }

    // Load ROM into emulator
    console.log(`[emulator] Loading ROM: ${path.basename(config.romPath)}`);
    await this.page.evaluate(() => {
      const player = document.querySelector('desmond-player') as any;
      if (player) {
        player.loadURL('/rom.nds', () => {
          const status = document.getElementById('status');
          if (status) {
            status.textContent = 'ROM loaded!';
            status.className = 'ready';
          }
        });
      }
    });

    // Wait for ROM to initialize
    await this.page.waitForTimeout(15000);
    console.log('[emulator] ROM loaded');
  }

  /** Stop the browser and server */
  async stop(): Promise<void> {
    if (this.browser) await this.browser.close();
    if (this.server) this.server.close();

    // Clean up ROM copy
    const romDest = path.join(__dirname, '..', 'rom.nds');
    if (fs.existsSync(romDest)) fs.unlinkSync(romDest);
  }

  /** Press an NDS button via Playwright keyboard (desmond listens on window.onkeydown) */
  async pressButton(button: string, holdMs = 50): Promise<void> {
    if (!this.page) throw new Error('Emulator not started');

    // Desmond maps browser keyboard events via window.onkeydown/onkeyup
    const keyMap: Record<string, string> = {
      a: 'a', b: 'b', x: 'x', y: 'y',
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
      start: 'Enter', select: 'Backspace', l: 'q', r: 'w',
    };

    const key = keyMap[button.toLowerCase()] || button;
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(holdMs);
  }

  /** Press a button multiple times with delay */
  async pressButtonTimes(button: string, times: number, delayMs = 200): Promise<void> {
    for (let i = 0; i < times; i++) {
      await this.pressButton(button);
      if (i < times - 1) await this.page!.waitForTimeout(delayMs);
    }
  }

  /** Click on NDS bottom screen coordinates */
  async touchScreen(ndsX: number, ndsY: number): Promise<void> {
    if (!this.page) throw new Error('Emulator not started');

    await this.page.evaluate(({ x, y }: { x: number; y: number }) => {
      const player = document.querySelector('desmond-player') as any;
      if (!player?.shadowRoot) return;
      const canvas = player.shadowRoot.querySelector('canvas');
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const clickX = rect.left + (x / 256) * rect.width;
      const clickY = rect.top + rect.height * 0.5 + (y / 192) * rect.height * 0.5;

      canvas.dispatchEvent(new MouseEvent('mousedown', {
        clientX: clickX, clientY: clickY, bubbles: true,
      }));
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        clientX: clickX, clientY: clickY, bubbles: true,
      }));
    }, { x: ndsX, y: ndsY });

    await this.page.waitForTimeout(100);
  }

  /** Capture screenshot from the emulator canvas */
  async screenshot(label?: string): Promise<string> {
    if (!this.page) throw new Error('Emulator not started');

    this.stepCount++;
    const filename = label || `step_${String(this.stepCount).padStart(4, '0')}`;
    const outPath = path.join(this.outputDir, `${filename}.png`);

    // Try canvas capture first (native NDS resolution)
    const canvasData = await this.page.evaluate(() => {
      const player = document.querySelector('desmond-player') as any;
      if (!player?.shadowRoot) return null;
      const canvas = player.shadowRoot.querySelector('canvas');
      return canvas ? canvas.toDataURL('image/png') : null;
    }).catch(() => null);

    if (canvasData) {
      const base64 = canvasData.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    } else {
      // Fallback to page screenshot
      await this.page.screenshot({ path: outPath });
    }

    return outPath;
  }

  /** Get the current page (for advanced operations) */
  getPage(): Page {
    if (!this.page) throw new Error('Emulator not started');
    return this.page;
  }
}
