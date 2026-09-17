/**
 * Simulation tunables. These used to be compile-time constants on the server
 * (`convex/constants.ts`); here they're defaults that the Settings panel can
 * override at runtime via `overrideConstants()`.
 */

export type TownConstants = {
  /** Max ticks to simulate in one frame (catch-up after the tab was backgrounded). */
  MAX_TICKS_PER_STEP: number;
  /** Max inputs drained from the queue per tick. */
  MAX_INPUTS_PER_STEP: number;
  /** Max pathfinding searches per tick. */
  MAX_PATHFINDS_PER_STEP: number;
  /** Tiles per second. */
  MOVEMENT_SPEED: number;

  PATHFINDING_TIMEOUT: number;
  PATHFINDING_BACKOFF: number;
  CONVERSATION_DISTANCE: number;
  MIDPOINT_THRESHOLD: number;
  TYPING_TIMEOUT: number;
  COLLISION_THRESHOLD: number;

  /** Don't talk to anyone for this long after having a conversation. */
  CONVERSATION_COOLDOWN: number;
  /** Don't do another activity for this long after doing one. */
  ACTIVITY_COOLDOWN: number;
  /** Don't talk to a player within this window of having talked to them. */
  PLAYER_CONVERSATION_COOLDOWN: number;
  /** Probability of accepting an invite that came from another agent. */
  INVITE_ACCEPT_PROBABILITY: number;
  /** Wait this long for invites to be accepted. */
  INVITE_TIMEOUT: number;
  /** Wait for the other player to say something before jumping in. */
  AWKWARD_CONVERSATION_TIMEOUT: number;
  MAX_CONVERSATION_DURATION: number;
  MAX_CONVERSATION_MESSAGES: number;
  /** Minimum gap between two messages in a conversation. */
  MESSAGE_COOLDOWN: number;
  /** Agent operations are abandoned after this long. */
  ACTION_TIMEOUT: number;

  /** How many memories to feed into a prompt (over-fetched 10x for re-ranking). */
  NUM_MEMORIES_TO_SEARCH: number;
  /** Memories older than this get vacuumed out of the local database. */
  VACUUM_MAX_AGE: number;

  ACTIVITIES: { description: string; emoji: string; duration: number }[];
};

export const DEFAULT_CONSTANTS: TownConstants = {
  MAX_TICKS_PER_STEP: 32,
  MAX_INPUTS_PER_STEP: 32,
  MAX_PATHFINDS_PER_STEP: 16,
  MOVEMENT_SPEED: 1.1,

  PATHFINDING_TIMEOUT: 60 * 1000,
  PATHFINDING_BACKOFF: 1000,
  CONVERSATION_DISTANCE: 1.3,
  MIDPOINT_THRESHOLD: 4,
  TYPING_TIMEOUT: 15 * 1000,
  COLLISION_THRESHOLD: 0.75,

  CONVERSATION_COOLDOWN: 15_000,
  ACTIVITY_COOLDOWN: 10_000,
  PLAYER_CONVERSATION_COOLDOWN: 60_000,
  INVITE_ACCEPT_PROBABILITY: 0.8,
  INVITE_TIMEOUT: 60_000,
  AWKWARD_CONVERSATION_TIMEOUT: 20_000,
  MAX_CONVERSATION_DURATION: 3 * 60_000,
  MAX_CONVERSATION_MESSAGES: 8,
  MESSAGE_COOLDOWN: 2_000,
  ACTION_TIMEOUT: 120_000,

  NUM_MEMORIES_TO_SEARCH: 3,
  VACUUM_MAX_AGE: 2 * 7 * 24 * 60 * 60 * 1000,

  // 20s rather than upstream's 60s: in a browser tab you want the first
  // conversation to start within a few seconds of opening the page.
  ACTIVITIES: [
    { description: 'reading a book', emoji: '📖', duration: 20_000 },
    { description: 'daydreaming', emoji: '🤔', duration: 20_000 },
    { description: 'gardening', emoji: '🥕', duration: 20_000 },
  ],
};

let current: TownConstants = clone(DEFAULT_CONSTANTS);

function clone(value: TownConstants): TownConstants {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Live constants. Read through this proxy (not `DEFAULT_CONSTANTS`) so Settings
 * overrides apply everywhere at once.
 */
export const C: TownConstants = new Proxy({} as TownConstants, {
  get(_target, prop: string | symbol) {
    return (current as any)[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(current);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return { configurable: true, enumerable: true, value: (current as any)[prop] };
  },
});

export function overrideConstants(overrides: Partial<TownConstants>) {
  current = { ...current, ...overrides };
}

export function resetConstants() {
  current = clone(DEFAULT_CONSTANTS);
}

export function getConstants(): TownConstants {
  return current;
}

export const DEFAULT_NAME = 'Me';
export const WORLD_ID = 'world';
