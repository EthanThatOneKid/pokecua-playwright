# pokecua-playwright

Headless NDS emulator using Playwright + desmond (DeSmuME-wasm).

**All input stays in the browser tab** — your host keyboard is never touched.

## How It Works

1. **desmond** — JavaScript DeSmuME emulator running in a Chromium tab
2. **Playwright** — sends keyboard/touch inputs to that tab only
3. **Screenshots** — captured from the emulator canvas via Playwright

Your computer stays completely usable while the agent plays.

## Quick Start

```bash
npm install
npx playwright install chromium

# Run with a ROM
node play.js /path/to/pokemon.nds
```

## Architecture

```
┌─────────────────────────────────┐
│     Headless Chromium Tab       │
│  ┌───────────────────────────┐  │
│  │    desmond (DeSmuME-wasm) │  │
│  │    ┌─────────────────┐    │  │
│  │    │  Pokemon ROM     │    │  │
│  │    │  (NDS emulator)  │    │  │
│  │    └─────────────────┘    │  │
│  └───────────────────────────┘  │
│                                 │
│  Playwright sends:              │
│  - keyboard.keypress('z')       │
│  - mouse.click(x, y)            │
│  - page.screenshot()            │
└─────────────────────────────────┘
         │
    All input goes HERE
    (never to host OS)
```

## Key Difference from Native DeSmuME

| | Native DeSmuME | Playwright + desmond |
|---|---|---|
| Input | OS-level (SendInput) | Browser tab only |
| Screenshots | PrintWindow/BitBlt | Canvas capture |
| Headless | Partial (needs window) | Fully headless |
| Host interference | ❌ Yes | ✅ No |
| Cost | Free | Free |

## Status

- [x] Browser-based emulator loads
- [x] Playwright sends keyboard input
- [ ] ROM loading works end-to-end
- [ ] Touch screen input
- [ ] Vision-based state detection
- [ ] Intro automation
