/**
 * OpenRouter vision provider — uses AI SDK with free gemma-4-31b model.
 *
 * Free tier: 50 req/day (1,000 after $10 credit purchase).
 * Uses @openrouter/ai-sdk-provider for clean integration.
 */

import * as fs from 'fs';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import { VisionProvider, GameState, ScreenHistoryEntry } from '../types';
import { gameStateSchema, GAME_STATE_PROMPT, buildHistoryContext } from './schema';

export class OpenRouterVisionProvider implements VisionProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private model: string;
  private _available = true;

  constructor(apiKey: string, model = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free') {
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

    const openrouter = createOpenRouter({ apiKey: this.apiKey });

    try {
      const { object } = await generateObject({
        model: openrouter.chat(this.model),
        schema: gameStateSchema,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: GAME_STATE_PROMPT + historyText },
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

      return {
        ...object,
        activePokemon: object.activePokemon ?? undefined,
        opponent: object.opponent ?? undefined,
      } as GameState;
    } catch (e: any) {
      // If AI SDK HTTP hangs or fails, mark unavailable
      this._available = false;
      throw new Error(e.message?.substring(0, 150));
    }
  }
}
