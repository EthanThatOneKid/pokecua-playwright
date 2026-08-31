/** Game state parsed from a screenshot via vision API */
export interface GameState {
  /** Current game phase */
  phase: 'title' | 'intro' | 'name_entry' | 'gender_selection' | 'overworld' | 'battle' | 'menu' | 'dialog' | 'save_screen' | 'unknown';
  /** Player's current location if identifiable */
  location: string;
  /** Gym badges earned */
  badges: string[];
  /** Number of Pokemon in party */
  pokemonCount: number;
  /** Active Pokemon info (if in battle) */
  activePokemon?: {
    name: string;
    level: number;
    hpPercent: number;
    status: string;
  };
  /** Opponent info (if in battle) */
  opponent?: {
    name: string;
    level: number;
    hpPercent: number;
  };
  /** Confidence in this parse (0-1) */
  confidence: number;
  /** Free-form description of what's on screen */
  description: string;
}

/** An action the agent can take */
export interface Action {
  /** Button to press */
  button: 'a' | 'b' | 'x' | 'y' | 'up' | 'down' | 'left' | 'right' | 'start' | 'select' | 'l' | 'r';
  /** Number of times to press */
  repeat: number;
  /** Delay between presses (ms) */
  delayMs: number;
  /** Reasoning for this action */
  reasoning: string;
}

/** A decision cycle result */
export interface Decision {
  /** Timestamp */
  timestamp: number;
  /** Step number */
  step: number;
  /** Detected game state */
  state: GameState;
  /** Action chosen */
  action: Action;
  /** Screenshot path */
  screenshotPath: string;
}

/** Emulator configuration */
export interface EmulatorConfig {
  /** Path to NDS ROM file */
  romPath: string;
  /** Port for local HTTP server (0 = auto) */
  port?: number;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
}

/** Decision loop configuration */
export interface LoopConfig {
  /** Maximum number of decision cycles */
  maxSteps: number;
  /** Delay between cycles (ms) */
  cycleDelayMs: number;
  /** Directory for screenshots */
  outputDir: string;
  /** Groq API key */
  groqApiKey: string;
  /** Groq model to use */
  groqModel?: string;
}
