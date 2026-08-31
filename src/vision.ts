/**
 * Vision-based game state parser using Vercel AI SDK + Groq.
 * 
 * Uses generateObject for structured output — no manual JSON parsing needed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { z } from 'zod';
import { GameState } from './types';

/** Run a command and return stdout */
function runCommand(cmd: string, args: string[], input?: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => stdout += d.toString());
    child.stderr.on('data', (d: Buffer) => stderr += d.toString());
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.substring(0, 200)}`));
      else resolve(stdout);
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
    child.stdin.end();
    setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, timeoutMs);
  });
}

/** Zod schema for structured game state output */
const gameStateSchema = z.object({
  phase: z.enum(['title', 'intro', 'name_entry', 'gender_selection', 'overworld', 'battle', 'menu', 'dialog', 'save_screen', 'unknown']),
  location: z.string().default('').describe('Current in-game location if identifiable'),
  badges: z.array(z.string()).default([]).describe('Gym badges visible on screen'),
  pokemonCount: z.number().int().min(0).default(0).describe('Number of Pokemon in party if visible'),
  activePokemon: z.object({
    name: z.string().describe('Player\'s active Pokemon name'),
    level: z.number().int().min(0),
    hpPercent: z.number().min(0).max(100).describe('HP percentage estimated from bar'),
    status: z.string().describe('Status condition: healthy, poisoned, paralyzed, burned, frozen, asleep, or unknown'),
  }).nullable().default(null).describe('Active Pokemon info if in battle'),
  opponent: z.object({
    name: z.string().describe('Opponent Pokemon name'),
    level: z.number().int().min(0),
    hpPercent: z.number().min(0).max(100),
  }).nullable().default(null).describe('Opponent info if in battle'),
  confidence: z.number().min(0).max(1).default(0.5).describe('Confidence in this parse'),
  description: z.string().default('').describe('Brief description of what\'s on screen'),
});

const GAME_STATE_PROMPT = `You are a Pokemon game state parser. Analyze this Nintendo DS screenshot
and extract the current game state.

The Nintendo DS has two screens stacked vertically (256x192 each). The top screen shows the main game view. The bottom screen shows menus, maps, or touch controls.

Phase definitions:
- "title": The game title/logo screen. Black background with Pokemon logo. May show "PRESS START" text. The bottom screen may show Giratina or a dark scene.
- "intro": A cinematic cutscene BEFORE the player has control. Key signals: no UI elements, no text boxes, characters moving cinematically. In Pokemon Platinum, the intro shows a blue sky with clouds and a protagonist silhouette running.
- "overworld": The player character is visible AND has control. Key signals: visible location name in corner, HP bar, party Pokemon icons, or the character is standing in a town/route. The bottom screen usually shows a map or menu.
- "battle": Two Pokemon facing each other, HP bars visible, FIGHT/BAG/POKEMON/RUN menu.
- "dialog": A text box is visible at the bottom of the top screen.
- "menu": A list of options visible (New Game, Continue, Options, etc.). Gray background with text options. The bottom screen may show button prompts.
- "name_entry": A keyboard grid or letter selection is visible on the bottom screen. Letters A-Z arranged in a grid pattern.
- "gender_selection": Two character sprites (male/female) shown for the player to choose.
- "save_screen": The game asks to save progress.
- "unknown": Cannot determine what is shown.

Rules:
- If you see a text box, phase should be "dialog".
- If the bottom screen shows a keyboard grid with letters, it is "name_entry".
- If you see two character sprites (boy/girl), it is "gender_selection".
- If the bottom screen shows a list of text options (New Game, Continue), it is "menu".
- If both screens show a cinematic (no UI), it is "intro".
- If you see HP bars or party icons, it is "overworld" or "battle".
- Be specific about what you see — don't guess.
- Confidence should be lower if the screenshot is blurry or unclear.`;

export class VisionParser {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'qwen/qwen3.8-27b') {
    this.apiKey = apiKey;
    this.model = model;
  }

  /** Parse a screenshot and extract structured game state */
  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');

    const payload = JSON.stringify({
      model: this.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: GAME_STATE_PROMPT },
          { type: 'text', text: `Respond with JSON only. Phase must be one of: ${gameStateSchema.shape.phase.options.join(', ')}.` },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
        ],
      }],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    // Use Python for HTTP because Node.js native fetch/subprocesses hang on this machine
    const pyCode = [
      'import json, urllib.request, sys',
      'payload = sys.stdin.read()',
      'req = urllib.request.Request(',
      '    "https://api.groq.com/openai/v1/chat/completions",',
      '    data=payload.encode(),',
      '    headers={',
      '        "Authorization": "Bearer ' + this.apiKey + '",',
      '        "Content-Type": "application/json",',
      '        "User-Agent": "PokeCUA/1.0",',
      '    },',
      ')',
      'resp = urllib.request.urlopen(req, timeout=15)',
      'result = json.loads(resp.read())',
      'content = result["choices"][0]["message"]["content"]',
      'print(content)',
    ].join('\n');
    const pyOutput = await runCommand('python', ['-c', pyCode], payload);
    const parsed = JSON.parse(pyOutput.trim());
    const zodResult = gameStateSchema.parse(parsed);
    return {
      ...zodResult,
      activePokemon: zodResult.activePokemon ?? undefined,
      opponent: zodResult.opponent ?? undefined,
    } as GameState;
  }
}
