/**
 * Vision-based game state parser using Groq.
 * 
 * Sends screenshots to Groq (Qwen 3.8 27B) and returns structured game state.
 */

import * as fs from 'fs';
import { GameState } from './types';

const GAME_STATE_PROMPT = `You are a Pokemon game state parser. Analyze this Nintendo DS (DeSmuME) screenshot 
and extract the current game state as a JSON object.

Return ONLY a valid JSON object with these fields (no markdown, no commentary):

{
  "phase": "<one of: title, intro, name_entry, overworld, battle, menu, dialog, unknown>",
  "location": "<current location name if identifiable>",
  "badges": ["<list of badge names if visible>"],
  "pokemonCount": <int, number of pokemon in party if visible>,
  "activePokemon": {
    "name": "<player's active pokemon name if in battle>",
    "level": <int>,
    "hpPercent": <float 0-100>,
    "status": "<healthy, poisoned, paralyzed, burned, frozen, asleep, or unknown>"
  } or null,
  "opponent": {
    "name": "<opponent pokemon name if in battle>",
    "level": <int>,
    "hpPercent": <float 0-100>
  } or null,
  "confidence": <float 0-1, how confident you are in this parse>,
  "description": "<brief free-form description of what's happening on screen>"
}

Rules:
- For fields you cannot determine, use sensible defaults (empty string, 0, null).
- HP percentage should be estimated visually from the HP bar width.
- If you see a text box, phase should be "dialog".
- Confidence should be lower if the screenshot is blurry or unclear.
- Be specific about what you see — don't guess.`;

export class VisionParser {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'qwen/qwen3.8-27b') {
    this.apiKey = apiKey;
    this.model = model;
  }

  /** Parse a screenshot and extract game state */
  async parse(screenshotPath: string): Promise<GameState> {
    const imageBuffer = fs.readFileSync(screenshotPath);
    const imageBase64 = imageBuffer.toString('base64');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: GAME_STATE_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageBase64}` },
            },
          ],
        }],
        temperature: 0.1,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} ${error}`);
    }

    const data = await response.json() as any;
    const text = data.choices[0].message.content;

    return this.parseResponse(text);
  }

  /** Parse the JSON response from the vision model */
  private parseResponse(text: string): GameState {
    // Strip thinking tags
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    cleaned = cleaned.replace(/<think>[\s\S]*$/, '').trim();

    // Strip markdown fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n', 1)[1] || '';
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, cleaned.lastIndexOf('```'));
      }
      cleaned = cleaned.trim();
    }

    try {
      const data = JSON.parse(cleaned);
      return {
        phase: data.phase || 'unknown',
        location: data.location || '',
        badges: data.badges || [],
        pokemonCount: data.pokemonCount || 0,
        activePokemon: data.activePokemon || undefined,
        opponent: data.opponent || undefined,
        confidence: data.confidence || 0,
        description: data.description || '',
      };
    } catch {
      // Try to extract JSON from the text
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const data = JSON.parse(cleaned.slice(start, end + 1));
          return {
            phase: data.phase || 'unknown',
            location: data.location || '',
            badges: data.badges || [],
            pokemonCount: data.pokemonCount || 0,
            activePokemon: data.activePokemon || undefined,
            opponent: data.opponent || undefined,
            confidence: data.confidence || 0,
            description: data.description || '',
          };
        } catch {
          // Fall through
        }
      }

      return {
        phase: 'unknown',
        location: '',
        badges: [],
        pokemonCount: 0,
        confidence: 0,
        description: `Parse failed: ${text.slice(0, 200)}`,
      };
    }
  }
}
