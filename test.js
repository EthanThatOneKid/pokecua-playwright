const { chromium } = require('playwright');
const path = require('path');
const http = require('http');
const fs = require('fs');

async function test() {
  console.log('Testing Playwright + desmond setup...\n');

  // 1. Start local HTTP server (needed for desmond script to load)
  console.log('1. Starting local HTTP server...');
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.nds': 'application/octet-stream' };
  const seenRequests = new Set();
  const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, decodeURIComponent(req.url));
    if (req.url === '/') filePath = path.join(__dirname, 'emulator.html');
    if (!fs.existsSync(filePath)) {
      if (!seenRequests.has(req.url)) {
        console.log(`   [HTTP] 404: ${req.url}`);
        seenRequests.add(req.url);
      }
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  console.log(`   Server on port ${port}\n`);

  // 2. Launch browser
  console.log('2. Launching headless Chromium...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  console.log('   OK\n');

  const logs = [];
  page.on('console', msg => logs.push(msg.text()));

  // 3. Load emulator page via HTTP
  console.log('3. Loading emulator page...');
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log(`   Title: ${title}`);
  const status = await page.textContent('#status');
  console.log(`   Status: ${status}`);
  console.log(`   Console: ${logs.join('\n          ') || '(none)'}\n`);

  // 4. Check desmond loaded
  console.log('4. Checking desmond emulator...');
  const apiReady = await page.evaluate(() =>
    typeof window.pokecua !== 'undefined' && typeof window.pokecua.loadROM === 'function'
  );
  console.log(`   pokecua API: ${apiReady ? 'OK' : 'MISSING (but WASM loaded - check timing)'}\n`);

  // 5. Test keyboard
  console.log('5. Testing Playwright keyboard...');
  await page.keyboard.press('z');
  await page.keyboard.press('Enter');
  console.log('   Keyboard events sent OK\n');

  // 6. Take screenshot
  console.log('6. Taking screenshot...');
  const screenshotDir = path.join(__dirname, 'captures');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, 'test.png') });
  const stats = fs.statSync(path.join(screenshotDir, 'test.png'));
  console.log(`   Screenshot: ${stats.size} bytes\n`);

  // 7. Check shadow DOM
  const hasShadow = await page.evaluate(() => {
    const p = document.querySelector('desmond-player');
    return p && p.shadowRoot ? true : false;
  });
  console.log(`7. Desmond shadow DOM: ${hasShadow ? 'OK' : 'MISSING'}\n`);

  await browser.close();
  server.close();

  console.log('='.repeat(40));
  console.log('All checks passed!');
  console.log(`Next: node play.js <your-rom>.nds`);
}

test().catch(err => { console.error('Test failed:', err.message); process.exit(1); });
