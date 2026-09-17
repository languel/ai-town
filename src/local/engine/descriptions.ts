import type { GameId } from './ids';

export type PlayerDescription = {
  playerId: GameId<'players'>;
  name: string;
  /** Shown in the UI ("Alice is a famous scientist"). */
  description: string;
  /** Sprite name, e.g. `f3`. */
  character: string;
};

export type AgentDescription = {
  agentId: GameId<'agents'>;
  /** Personality. Feeds `About you: ...` in the prompts. */
  identity: string;
  /** What the agent is trying to get out of conversations. */
  plan: string;
  /** Optional extra style instructions appended to every prompt. */
  styleNotes?: string;
};

/**
 * A row in the "cast" — the thing the personality editor edits. Creating a cast
 * member spawns a player + agent in the world; deleting it kicks them.
 */
export type CharacterDef = {
  id: string;
  name: string;
  description: string;
  identity: string;
  plan: string;
  styleNotes?: string;
  /** Sprite key from data/characters.ts (f1..f8, p1..p3 ...) */
  character: string;
  /** Where they materialize when spawned. */
  spawn?: { x: number; y: number } | null;
  /** When false they stay in the cast list but leave the simulation. */
  enabled: boolean;
  /** Per-character sampling knobs. */
  temperature?: number;
  isHuman?: boolean;
};
