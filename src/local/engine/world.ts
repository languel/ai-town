import { Conversation, SerializedConversation } from './conversation';
import { Player, SerializedPlayer } from './player';
import { Agent, SerializedAgent } from './agent';
import { GameId, IdTypes, allocGameId, parseGameId } from './ids';
import { parseMap } from './object';

export type SerializedWorld = {
  nextId: number;
  conversations: SerializedConversation[];
  players: SerializedPlayer[];
  agents: SerializedAgent[];
};

/**
 * Everything the simulation owns that changes frequently: players, agents and
 * conversations. Ported from `convex/aiTown/world.ts` (minus the historical
 * location buffers, which are pointless when the engine and renderer share a
 * process).
 */
export class World {
  nextId: number;
  conversations: Map<GameId<'conversations'>, Conversation>;
  players: Map<GameId<'players'>, Player>;
  agents: Map<GameId<'agents'>, Agent>;

  constructor(serialized?: Partial<SerializedWorld>) {
    this.nextId = serialized?.nextId ?? 0;
    this.conversations = parseMap(serialized?.conversations ?? [], Conversation, (c) => c.id);
    this.players = parseMap(serialized?.players ?? [], Player, (p) => p.id);
    this.agents = parseMap(serialized?.agents ?? [], Agent, (a) => a.id);
  }

  playerConversation(player: Player): Conversation | undefined {
    return [...this.conversations.values()].find((c) => c.participants.has(player.id));
  }

  agentForPlayer(playerId: GameId<'players'>): Agent | undefined {
    return [...this.agents.values()].find((a) => a.playerId === playerId);
  }

  allocId<T extends IdTypes>(idType: T): GameId<T> {
    const id = allocGameId(idType, this.nextId);
    this.nextId += 1;
    return id;
  }

  parseId<T extends IdTypes>(idType: T, id: string): GameId<T> {
    return parseGameId(idType, id);
  }

  serialize(): SerializedWorld {
    return {
      nextId: this.nextId,
      conversations: [...this.conversations.values()].map((c) => c.serialize()),
      players: [...this.players.values()].map((p) => p.serialize()),
      agents: [...this.agents.values()].map((a) => a.serialize()),
    };
  }
}
