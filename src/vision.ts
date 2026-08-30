/**
 * Vision-based game state parser using Vercel AI SDK + Groq.
 * 
 * Uses generateObject for structured output — no manual JSON parsing needed.
 */

import * as fs from 'fs';
import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';
import { GameState } from './types';

/** Zod schema for structured game state output */
const gameStateSchema = z.object({
  phase: z.enum(['title', 'intro', 'name_entry', 'overworld', 'battle', 'menu', 'dialog', 'save_screen', 'unknown']),
  location: z.string().describe('Current in-game location if identifiable'),
  badges: z.array(z.string()).describe('Gym badges visible on screen'),
  pokemonCount: z.number().int().min(0).describe('Number of Pokemon in party if visible'),
  activePokemon: z.object({
    name: z.string().describe('Player\'s active Pokemon name'),
    level: z.number().int().min(0),
    hpPercent: z.number().min(0).max(100).describe('HP percentage estimated from bar'),
    status: z.string().describe('Status condition: healthy, poisoned, paralyzed, burned, frozen, asleep, or unknown'),
  }).nullable().describe('Active Pokemon info if in battle'),
  opponent: z.object({
    name: z.string().describe('Opponent Pokemon name'),
    level: z.number().int().min(0),
    hpPercent: z.number().min(0).max(100),
  }).nullable().describe('Opponent info if in battle'),
  confidence: z.number().min(0).max(1).describe('Confidence in this parse'),
  description: z.string().describe('Brief description of what\'s on screen'),
});

const GAME_STATE_PROMPT = `You are a Pokemon game state parser. Analyze this Nintendo DS screenshot
and extract the current game state.

Rules:
- If you cannot determine a field, use sensible defaults (empty string, 0, null).
- HP percentage should be estimated visually from the HP bar width.
- If you see a text box, phase should be "dialog".
- Be specific about what you see — don't guess.
- Confidence should be lower if the screenshot is blurry or unclear.`;

export class VisionParser {
  private groq;

  constructor(apiKey: string, model = 'qwen/qwen3.8-27b') {
    this.groq = createGroq({ apiKey });
    this._model = model;
  }

  private _model: string;

  /** Parse a screenshot and extract structured game state */
  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);

    const { object } = await generateObject({
      model: this.groq(this._model),
      schema: gameStateSchema,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: GAME_STATE_PROMPT },
            {
              type: 'image',
              image: imageBuffer,
            },
          ],
        },
      ],
      temperature: 0.1,
    });

    return object as GameState;
  }
}
