/**
 * OpenRouter vision provider — uses free gemma-4-31b-it for image parsing.
 *
 * Free tier: 50 req/day (1,000 after $10 credit purchase).
 * OpenAI-compatible API. No credit card required.
 * Models: google/gemma-4-31b-it:free, nvidia/nemotron-nano-12b-v2-vl:free
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import { VisionProvider, GameState } from '../types';
import { gameStateSchema, GAME_STATE_PROMPT } from './schema';

/** Run a command and return stdout */
function runCommand(cmd: string, args: string[], input?: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.substring(0, 300)}`));
      else resolve(stdout);
    });
    child.on('error', reject);
    if (input) child.stdin.write(input);
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      reject(new Error('Timeout'));
    }, timeoutMs);
  });
}

export class OpenRouterVisionProvider implements VisionProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private model: string;
  private _available = true;

  constructor(apiKey: string, model = 'google/gemma-4-31b-it:free') {
    this.apiKey = apiKey;
    this.model = model;
  }

  isAvailable(): boolean {
    return this._available && !!this.apiKey;
  }

  markUnavailable(): void {
    this._available = false;
  }

  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');

    const jsonFormat = `{"phase":"title|intro|name_entry|gender_selection|overworld|battle|menu|dialog|save_screen|unknown","location":"string","badges":["string"],"pokemonCount":0,"activePokemon":{"name":"string","level":0,"hpPercent":0,"status":"string"},"opponent":{"name":"string","level":0,"hpPercent":0},"confidence":0.0-1.0,"description":"what you see"}`;

    const payload = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: GAME_STATE_PROMPT },
            {
              type: 'text',
              text: `Respond with JSON only. Phase must be one of: ${gameStateSchema.shape.phase.options.join(', ')}.\\nJSON format: ${jsonFormat}`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64Image}` },
            },
          ],
        },
      ],
      temperature: 0.1,
    });

    // Python urllib — Node.js HTTP hangs on this machine
    const pyCode = [
      'import json, urllib.request, urllib.error, sys',
      'payload = sys.stdin.read()',
      'req = urllib.request.Request(',
      '    "https://openrouter.ai/api/v1/chat/completions",',
      '    data=payload.encode(),',
      '    headers={',
      '        "Authorization": "Bearer ' + this.apiKey + '",',
      '        "Content-Type": "application/json",',
      '        "User-Agent": "PokeCUA/1.0",',
      '        "HTTP-Referer": "https://github.com/EthanThatOneKid/pokecua-playwright",',
      '    },',
      ')',
      'try:',
      '    resp = urllib.request.urlopen(req, timeout=25)',
      '    result = json.loads(resp.read())',
      '    content = result["choices"][0]["message"]["content"]',
      '    print(content)',
      'except urllib.error.HTTPError as e:',
      '    body = e.read().decode() if hasattr(e, "read") else ""',
      '    print(json.dumps({"error": "HTTP " + str(e.code) + " " + body[:300], "phase": "unknown", "confidence": 0, "description": "API error"}))',
      'except Exception as e:',
      '    print(json.dumps({"error": str(e), "phase": "unknown", "confidence": 0, "description": "API error"}))',
    ].join('\n');

    let pyOutput: string;
    try {
      pyOutput = await runCommand('python', ['-c', pyCode], payload);
    } catch (e: any) {
      throw new Error(e.message?.substring(0, 150));
    }

    // Strip markdown code blocks if present
    let raw = pyOutput.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(raw.trim());
    if (parsed.error) throw new Error(parsed.error);

    // Normalize non-standard phase values (gemma may return different phrasing)
    const validPhases = gameStateSchema.shape.phase.options;
    if (parsed.phase && !validPhases.includes(parsed.phase)) {
      const lower = parsed.phase.toLowerCase();
      if (lower.includes('title')) parsed.phase = 'title';
      else if (lower.includes('intro')) parsed.phase = 'intro';
      else if (lower.includes('overworld') || lower.includes('town') || lower.includes('route')) parsed.phase = 'overworld';
      else if (lower.includes('battle')) parsed.phase = 'battle';
      else if (lower.includes('dialog') || lower.includes('text')) parsed.phase = 'dialog';
      else if (lower.includes('menu')) parsed.phase = 'menu';
      else if (lower.includes('name') || lower.includes('keyboard')) parsed.phase = 'name_entry';
      else if (lower.includes('gender') || lower.includes('boy') || lower.includes('girl')) parsed.phase = 'gender_selection';
      else if (lower.includes('save')) parsed.phase = 'save_screen';
      else parsed.phase = 'unknown';
    }

    const zodResult = gameStateSchema.parse(parsed);
    return {
      ...zodResult,
      activePokemon: zodResult.activePokemon ?? undefined,
      opponent: zodResult.opponent ?? undefined,
    } as GameState;
  }
}
