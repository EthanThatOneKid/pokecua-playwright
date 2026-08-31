/**
 * Groq vision provider — uses qwen3.8-27b for image parsing.
 *
 * Free tier: 200K tokens/day, 8K TPM, ~100 image parses/day.
 * Good for: quick tests, low-volume usage.
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import { VisionProvider, GameState } from '../types';
import { gameStateSchema, GAME_STATE_PROMPT } from './schema';

/** Run a command and return stdout */
function runCommand(cmd: string, args: string[], input?: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Exit ${code}: ${stderr.substring(0, 200)}`));
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

export class GroqVisionProvider implements VisionProvider {
  readonly name = 'groq';
  private apiKey: string;
  private model: string;
  private _available = true;

  constructor(apiKey: string, model = 'qwen/qwen3.8-27b') {
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

    const payload = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: GAME_STATE_PROMPT },
            {
              type: 'text',
              text: `Respond with JSON only. Phase must be one of: ${gameStateSchema.shape.phase.options.join(', ')}.`,
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
          ],
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    // Python urllib — Node.js HTTP hangs on this machine
    const pyCode = [
      'import json, urllib.request, urllib.error, sys',
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
      'try:',
      '    resp = urllib.request.urlopen(req, timeout=15)',
      '    result = json.loads(resp.read())',
      '    content = result["choices"][0]["message"]["content"]',
      '    print(content)',
      'except urllib.error.HTTPError as e:',
      '    body = e.read().decode() if hasattr(e, "read") else ""',
      '    print(json.dumps({"error": "HTTP " + str(e.code) + " " + body[:200], "phase": "unknown", "confidence": 0, "description": "API error"}))',
      'except Exception as e:',
      '    print(json.dumps({"error": str(e), "phase": "unknown", "confidence": 0, "description": "API error"}))',
    ].join('\n');

    let pyOutput: string;
    try {
      pyOutput = await runCommand('python', ['-c', pyCode], payload);
    } catch (e: any) {
      throw new Error(e.message?.substring(0, 100));
    }

    const parsed = JSON.parse(pyOutput.trim());
    if (parsed.error) throw new Error(parsed.error);

    const zodResult = gameStateSchema.parse(parsed);
    return {
      ...zodResult,
      activePokemon: zodResult.activePokemon ?? undefined,
      opponent: zodResult.opponent ?? undefined,
    } as GameState;
  }
}
