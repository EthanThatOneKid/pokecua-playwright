/**
 * Gemini vision provider — uses gemini-3.7-flash for image parsing.
 *
 * Free tier: 1M tokens/day, 250K TPM, 10 RPM, 1500 RPD.
 * Much more generous than Groq. FREE through Dec 31, 2026.
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import { VisionProvider, GameState, ScreenHistoryEntry } from '../types';
import { gameStateSchema, GAME_STATE_PROMPT, buildHistoryContext } from './schema';

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

export class GeminiVisionProvider implements VisionProvider {
  readonly name = 'gemini';
  private apiKey: string;
  private model: string;
  private _available = true;

  constructor(apiKey: string, model = 'gemini-3.7-flash') {
    this.apiKey = apiKey;
    this.model = model;
  }

  isAvailable(): boolean {
    return this._available && !!this.apiKey;
  }

  markUnavailable(): void {
    this._available = false;
  }

  async parse(screenshotPath: string, history?: ScreenHistoryEntry[]): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');
    const historyText = history?.length ? buildHistoryContext(history) : '';

    const jsonFormat = `{"phase":"title|intro|name_entry|gender_selection|overworld|battle|menu|dialog|save_screen|unknown","location":"string","badges":["string"],"pokemonCount":0,"activePokemon":{"name":"string","level":0,"hpPercent":0,"status":"string"},"opponent":{"name":"string","level":0,"hpPercent":0},"confidence":0.0-1.0,"description":"what you see"}`;

    const payload = JSON.stringify({
      contents: [
        {
          parts: [
            { text: GAME_STATE_PROMPT + historyText },
            {
              text: `Respond with JSON only. Phase must be one of: ${gameStateSchema.shape.phase.options.join(', ')}.\nJSON format: ${jsonFormat}`,
            },
            {
              inline_data: {
                mime_type: 'image/png',
                data: base64Image,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    });

    // Python urllib for HTTP (Node.js hangs on this machine)
    const pyCode = [
      'import json, urllib.request, urllib.error, sys',
      'payload = sys.stdin.read()',
      'url = "https://generativelanguage.googleapis.com/v1beta/models/' +
        this.model +
        ':generateContent?key=' +
        this.apiKey +
        '"',
      'req = urllib.request.Request(',
      '    url,',
      '    data=payload.encode(),',
      '    headers={',
      '        "Content-Type": "application/json",',
      '        "User-Agent": "PokeCUA/1.0",',
      '    },',
      ')',
      'try:',
      '    resp = urllib.request.urlopen(req, timeout=25)',
      '    result = json.loads(resp.read())',
      '    content = result["candidates"][0]["content"]["parts"][0]["text"]',
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

    // Gemini may wrap JSON in markdown code blocks — strip them
    let raw = pyOutput.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(raw.trim());
    if (parsed.error) throw new Error(parsed.error);

    const zodResult = gameStateSchema.parse(parsed);
    return {
      ...zodResult,
      activePokemon: zodResult.activePokemon ?? undefined,
      opponent: zodResult.opponent ?? undefined,
    } as GameState;
  }
}
