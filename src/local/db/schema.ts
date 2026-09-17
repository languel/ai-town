import type { GameSnapshot } from '../engine/game';
import type { SerializedWorldMap } from '../engine/worldMap';
import type { CharacterDef } from '../engine/descriptions';

/**
 * Local database schema. The table names intentionally mirror the Convex schema
 * (`convex/schema.ts`) so exported JSON from a cloud deployment can be read here
 * and vice-versa.
 */
export const STORE_NAMES = [
  'world',
  'maps',
  'characters',
  'playerDescriptions',
  'agentDescriptions',
  'messages',
  'conversations',
  'participatedTogether',
  'memories',
  'embeddingsCache',
  'logs',
  'images',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

export type Doc = { _id: string; _creationTime: number };

/** The single live simulation state, snapshotted every step. */
export type WorldDoc = Doc & {
  _id: 'world';
  savedAt: number;
  simulation: GameSnapshot;
  /** Simulation clock (ms). Restored so agent cooldowns survive a reload. */
  engineTime: number;
};

export type MapDoc = Doc & {
  name: string;
  map: SerializedWorldMap;
  updatedAt: number;
  isDefault?: boolean;
};

export type PlayerDescriptionDoc = Doc & {
  _id: string; // playerId
  playerId: string;
  name: string;
  description: string;
  character: string;
};

export type AgentDescriptionDoc = Doc & {
  _id: string; // agentId
  agentId: string;
  identity: string;
  plan: string;
  styleNotes?: string;
};

export type CharacterDoc = Doc & CharacterDef;

export type Message = Doc & {
  conversationId: string;
  messageUuid: string;
  author: string;
  text: string;
  worldId: string;
  /** True while an LLM is still streaming tokens into `text`. */
  isStreaming?: boolean;
};

export type ArchivedConversation = Doc & {
  id: string;
  worldId: string;
  creator: string;
  created: number;
  ended: number;
  numMessages: number;
  participants: string[];
};

export type ParticipatedTogether = Doc & {
  worldId: string;
  conversationId: string;
  player1: string;
  player2: string;
  ended: number;
};

export type MemoryData =
  | { type: 'relationship'; playerId: string }
  | { type: 'conversation'; conversationId: string; playerIds: string[] }
  | { type: 'reflection'; relatedMemoryIds: string[] };

export type MemoryDoc = Doc & {
  playerId: string;
  description: string;
  importance: number;
  lastAccess: number;
  data: MemoryData;
  embedding: number[];
};

export type EmbeddingCacheDoc = Doc & {
  /** sha256 hex of the source text. */
  textHash: string;
  text: string;
  model: string;
  embedding: number[];
};

export type LogDoc = Doc & {
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  data?: unknown;
};

export type ImageRecord = Doc & {
  name: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
};

export type Tables = {
  world: WorldDoc;
  maps: MapDoc;
  characters: CharacterDoc;
  playerDescriptions: PlayerDescriptionDoc;
  agentDescriptions: AgentDescriptionDoc;
  messages: Message;
  conversations: ArchivedConversation;
  participatedTogether: ParticipatedTogether;
  memories: MemoryDoc;
  embeddingsCache: EmbeddingCacheDoc;
  logs: LogDoc;
  images: ImageRecord;
};
