/**
 * Ollama vision provider — uses AI SDK with local moondream model.
 *
 * Fully local, unlimited, free inference. No API key needed.
 * Uses ollama-ai-provider-v2 for clean AI SDK integration.
 * Note: CPU-only inference is slow (~80s/parse). Best with GPU.
 */

import * as fs from 'fs';
import { createOllama } from 'ollama-ai-provider-v2';
import { generateObject } from 'ai';
import { VisionProvider, GameState } from '../types';
import { gameStateSchema, GAME_STATE_PROMPT } from './schema';

export class OllamaVisionProvider implements VisionProvider {
  readonly name = 'ollama';
  private model: string;
  private baseUrl: string;
  private _available: boolean | null = null;

  constructor(model = 'moondream', baseUrl = 'http://localhost:11434') {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    return true; // Lazy check — validated on first parse
  }

  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64Image = imageBuffer.toString('base64');

    const ollama = createOllama({ baseURL: `${this.baseUrl}/api` });

    try {
      const { object } = await generateObject({
        model: ollama(this.model),
        schema: gameStateSchema,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: GAME_STATE_PROMPT },
              {
                type: 'text',
                text: `Analyze this Nintendo DS screenshot. What game phase is shown? Be specific about what you see on both screens.`,
              },
              {
                type: 'file',
                data: `data:image/png;base64,${base64Image}`,
                mediaType: 'image/png',
              },
            ],
          },
        ],
        temperature: 0.1,
      });

      this._available = true;

      return {
        ...object,
        activePokemon: object.activePokemon ?? undefined,
        opponent: object.opponent ?? undefined,
      } as GameState;
    } catch (e: any) {
      this._available = false;
      throw new Error(e.message?.substring(0, 150));
    }
  }
}
