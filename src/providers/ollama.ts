/**
 * Ollama vision provider — runs locally via Ollama API.
 *
 * Uses moondream (1.6B params, 1.7GB) for fully local, unlimited, free inference.
 * No API key needed. No rate limits. No token usage tracking.
 */

import * as fs from 'fs';
import * as path from 'path';
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

export class OllamaVisionProvider implements VisionProvider {
  readonly name = 'ollama';
  private model: string;
  private baseUrl: string;
  private _available: boolean | null = null; // lazy check

  constructor(model = 'moondream', baseUrl = 'http://localhost:11434') {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    // Lazy check — will be validated on first parse
    return true;
  }

  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');

    const prompt = `${GAME_STATE_PROMPT}\n\nRespond with JSON only. Phase must be one of: ${gameStateSchema.shape.phase.options.join(', ')}.`;

    const payload = JSON.stringify({
      model: this.model,
      prompt,
      images: [base64Image],
      stream: false,
      options: {
        temperature: 0.1,
      },
    });

    // Use Python urllib (Node.js HTTP hangs on this machine)
    const pyCode = [
      'import json, urllib.request, urllib.error, sys',
      'payload = sys.stdin.read()',
      `req = urllib.request.Request('${this.baseUrl}/api/generate',`,
      '    data=payload.encode(),',
      '    headers={"Content-Type": "application/json"},',
      ')',
      'try:',
      '    resp = urllib.request.urlopen(req, timeout=60)',
      '    result = json.loads(resp.read())',
      '    print(result.get("response", ""))',
      'except urllib.error.HTTPError as e:',
      '    body = e.read().decode() if hasattr(e, "read") else ""',
      '    print(json.dumps({"error": "HTTP " + str(e.code) + " " + body[:300]}))',
      'except Exception as e:',
      '    print(json.dumps({"error": str(e)}))',
    ].join('\n');

    let pyOutput: string;
    try {
      pyOutput = await runCommand('python', ['-c', pyCode], payload, 60000);
    } catch (e: any) {
      this._available = false;
      throw new Error(e.message?.substring(0, 150));
    }

    // Mark as available if we got a response
    this._available = true;

    // Parse the response — moondream may wrap in markdown code blocks
    let raw = pyOutput.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Try to extract JSON from the response (moondream sometimes adds text before/after)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON in response: ${raw.substring(0, 100)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.error) throw new Error(parsed.error);

    // Moondream may return non-standard phase values — normalize them
    const validPhases = gameStateSchema.shape.phase.options;
    if (parsed.phase && !validPhases.includes(parsed.phase)) {
      // Try to match loosely
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
