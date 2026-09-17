import type { Game } from './game';
import { normalizeMap, SerializedWorldMap } from './worldMap';
import { Player, SerializedPlayer, Activity } from './player';
import { Agent, SerializedAgent } from './agent';
import { Conversation } from './conversation';
import { GameId, parseGameId } from './ids';
import { Point } from './types';
import { blocked, findFreeSpotNear, movePlayer, stopPlayer } from './movement';
import { characters } from '../data/characters';
import { C } from '../constants';
import type { CharacterDef } from './descriptions';

/**
 * Everything the game engine accepts as an "input". Same idea as
 * `convex/aiTown/inputs.ts`: both humans and agents mutate the world only by
 * queueing named inputs that the engine runs at the start of a tick. That keeps
 * the simulation single-writer and makes it trivial to log/replay.
 */
export type InputHandlers = {
  join: (game: Game, now: number, args: { name: string; character: string; description: string; human?: string; spawn?: Point | null }) => GameId<'players'>;
  leave: (game: Game, now: number, args: { playerId: string }) => null;
  moveTo: (game: Game, now: number, args: { playerId: string; destination: Point | null }) => null;
  setActivity: (game: Game, now: number, args: { playerId: string; activity: Activity | null }) => null;

  startConversation: (game: Game, now: number, args: { playerId: string; invitee: string }) => GameId<'conversations'> | null;
  acceptInvite: (game: Game, now: number, args: { playerId: string; conversationId: string }) => null;
  rejectInvite: (game: Game, now: number, args: { playerId: string; conversationId: string }) => null;
  leaveConversation: (game: Game, now: number, args: { playerId: string; conversationId: string }) => null;
  startTyping: (game: Game, now: number, args: { playerId: string; conversationId: string; messageUuid: string }) => null;
  finishSendingMessage: (game: Game, now: number, args: { playerId: string; conversationId: string; timestamp: number }) => null;

  finishRememberConversation: (game: Game, now: number, args: { operationId: string; agentId: string }) => null;
  finishDoSomething: (game: Game, now: number, args: { operationId: string; agentId: string; destination?: Point | null; invitee?: string | null; activity?: Activity | null }) => null;
  agentFinishSendingMessage: (game: Game, now: number, args: { agentId: string; conversationId: string; timestamp: number; operationId: string; leaveConversation: boolean }) => null;

  /** Spawn (or re-spawn) an agent from the cast list. */
  spawnCharacter: (game: Game, now: number, args: { character: CharacterDef }) => { playerId: GameId<'players'>; agentId: GameId<'agents'> } | null;
  /** Remove a cast member from the running simulation. */
  despawnCharacter: (game: Game, now: number, args: { playerId: string }) => null;
  updateCharacterDescriptions: (game: Game, now: number, args: { playerId: string; agentId?: string | null; name?: string; description?: string; character?: string; identity?: string; plan?: string; styleNotes?: string }) => null;
  updateWorldMap: (game: Game, now: number, args: { map: SerializedWorldMap }) => null;
};

export type InputNames = keyof InputHandlers;
export type InputArgs<Name extends InputNames> = Parameters<InputHandlers[Name]>[2];

export function createInputHandlers(): {
  [K in InputNames]: (game: Game, now: number, args: any) => any;
} {
  return {
    join(game, now, args) {
      return joinPlayer(game, now, args);
    },
    leave(game, now, args) {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      playerLeave(game, now, player);
      return null;
    },
    moveTo(game, now, args) {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      if (args.destination) {
        movePlayer(game, now, player, {
          x: Math.floor(args.destination.x),
          y: Math.floor(args.destination.y),
        });
      } else {
        stopPlayer(player);
      }
      player.lastInput = now;
      return null;
    },
    setActivity(game, now, args) {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) throw new Error(`Invalid player ID ${args.playerId}`);
      player.activity = args.activity ?? undefined;
      return null;
    },

    startConversation(game, now, args) {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) throw new Error(`Invalid player ID: ${args.playerId}`);
      const invitee = game.world.players.get(parseGameId('players', args.invitee));
      if (!invitee) throw new Error(`Invalid player ID: ${args.invitee}`);
      const { conversationId, error } = Conversation.start(game, now, player, invitee);
      if (!conversationId) {
        throw new Error(error);
      }
      walkOverToHuman(game, now, player, invitee.position);
      return conversationId;
    },
    acceptInvite(game, now, args) {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) throw new Error(`Invalid player ID ${args.playerId}`);
      const conversation = game.world.conversations.get(
        parseGameId('conversations', args.conversationId),
      );
      if (!conversation) throw new Error(`Invalid conversation ${args.conversationId}`);
      conversation.acceptInvite(game, player);
      const otherId = [...conversation.participants.keys()].find((id) => id !== player.id);
      walkOverToHuman(game, now, player, otherId ? game.world.players.get(otherId)?.position : undefined);
      return null;
    },
    rejectInvite(game, now, args) {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) throw new Error(`Invalid player ID ${args.playerId}`);
      const conversation = game.world.conversations.get(
        parseGameId('conversations', args.conversationId),
      );
      if (!conversation) throw new Error(`Invalid conversation ${args.conversationId}`);
      conversation.rejectInvite(game, now, player);
      return null;
    },
    leaveConversation(game, now, args) {
      const player = game.world.players.get(parseGameId('players', args.playerId));
      if (!player) throw new Error(`Invalid player ID ${args.playerId}`);
      const conversation = game.world.conversations.get(
        parseGameId('conversations', args.conversationId),
      );
      if (!conversation) throw new Error(`Invalid conversation ${args.conversationId}`);
      conversation.leave(game, now, player);
      return null;
    },
    startTyping(game, now, args) {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) throw new Error(`Invalid player ID ${playerId}`);
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) throw new Error(`Invalid conversation ID ${conversationId}`);
      if (conversation.isTyping && conversation.isTyping.playerId !== playerId) {
        throw new Error(
          `Player ${conversation.isTyping.playerId} is already typing in ${conversationId}`,
        );
      }
      conversation.isTyping = { playerId, messageUuid: args.messageUuid, since: now };
      return null;
    },
    finishSendingMessage(game, now, args) {
      return applyFinishSendingMessage(game, now, args);
    },

    finishRememberConversation(game, _now, args) {
      const agent = game.world.agents.get(parseGameId('agents', args.agentId));
      if (!agent) throw new Error(`Couldn't find agent: ${args.agentId}`);
      if (agent.inProgressOperation?.operationId !== args.operationId) {
        return null;
      }
      delete agent.inProgressOperation;
      delete agent.toRemember;
      return null;
    },
    finishDoSomething(game, now, args) {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) throw new Error(`Couldn't find agent: ${agentId}`);
      if (agent.inProgressOperation?.operationId !== args.operationId) {
        return null;
      }
      delete agent.inProgressOperation;
      const player = game.world.players.get(agent.playerId);
      if (!player) return null;
      if (args.invitee) {
        const invitee = game.world.players.get(parseGameId('players', args.invitee));
        if (invitee) {
          try {
            Conversation.start(game, now, player, invitee);
          } catch (e) {
            console.warn(`Failed to start conversation: ${(e as Error).message}`);
          }
          agent.lastInviteAttempt = now;
        }
      }
      if (args.destination) {
        try {
          movePlayer(game, now, player, args.destination);
        } catch (e) {
          console.warn(`Failed to wander: ${(e as Error).message}`);
        }
      }
      if (args.activity) {
        player.activity = args.activity;
      }
      return null;
    },
    agentFinishSendingMessage(game, now, args) {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) throw new Error(`Couldn't find agent: ${agentId}`);
      const player = game.world.players.get(agent.playerId);
      if (!player) throw new Error(`Couldn't find player: ${agent.playerId}`);
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (agent.inProgressOperation?.operationId !== args.operationId) {
        return null;
      }
      const startedAt = agent.inProgressOperation?.started ?? 0;
      // Release the agent first: if the chat ended while the model was still
      // writing, throwing here would leave the agent "thinking" until
      // ACTION_TIMEOUT (two minutes of real time).
      delete agent.inProgressOperation;
      if (!conversation) {
        console.debug?.(`Conversation ${conversationId} ended before ${agentId} replied`);
        return null;
      }
      // The other person may have said something *while* the model was writing
      // the agent's goodbye. Don't walk off mid-conversation — stay and answer.
      const interrupted =
        !!args.leaveConversation &&
        !!conversation.lastMessage &&
        conversation.lastMessage.author !== player.id &&
        conversation.lastMessage.timestamp > startedAt;
      applyFinishSendingMessage(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation && !interrupted) {
        conversation.leave(game, now, player);
      }
      return null;
    },

    spawnCharacter(game, now, args) {
      const def = args.character;
      const existing = [...game.world.players.values()].find(
        (p) => game.castIds.get(p.id) === def.id,
      );
      if (existing) {
        playerLeave(game, now, existing);
      }
      const playerId = joinPlayer(game, now, {
        name: def.name,
        character: def.character,
        description: def.description,
        human: def.isHuman ? `human:${def.id}` : undefined,
        spawn: def.spawn,
      });
      game.castIds.set(playerId, def.id);
      if (def.isHuman) {
        return { playerId, agentId: null as any };
      }
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({ id: agentId, playerId }),
      );
      game.agentDescriptions.set(agentId, {
        agentId,
        identity: def.identity,
        plan: def.plan,
        styleNotes: def.styleNotes,
      });
      game.markDescriptionsModified();
      return { playerId, agentId };
    },
    despawnCharacter(game, now, args) {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) return null;
      playerLeave(game, now, player);
      return null;
    },
    updateCharacterDescriptions(game, _now, args) {
      const playerId = parseGameId('players', args.playerId);
      const description = game.playerDescriptions.get(playerId);
      if (description) {
        if (args.name !== undefined) description.name = args.name;
        if (args.description !== undefined) description.description = args.description;
        if (args.character !== undefined) {
          if (!characters.find((c) => c.name === args.character)) {
            throw new Error(`Unknown character sprite: ${args.character}`);
          }
          description.character = args.character;
        }
      }
      if (args.agentId) {
        const agentId = parseGameId('agents', args.agentId);
        const agentDescription = game.agentDescriptions.get(agentId);
        if (agentDescription) {
          if (args.identity !== undefined) agentDescription.identity = args.identity;
          if (args.plan !== undefined) agentDescription.plan = args.plan;
          if (args.styleNotes !== undefined) agentDescription.styleNotes = args.styleNotes;
        }
      }
      game.markDescriptionsModified();
      return null;
    },
    updateWorldMap(game, _now, args) {
      game.setWorldMap(normalizeMap(args.map));
      // Push everyone out of walls.
      for (const player of game.world.players.values()) {
        if (game.worldMap.isSolid(Math.floor(player.position.x), Math.floor(player.position.y))) {
          const spot = findFreeSpot(game);
          if (spot) {
            player.position = { x: spot.x + 0.5, y: spot.y + 0.5 };
          }
          stopPlayer(player);
        }
      }
      return null;
    },
  };
}

function joinPlayer(
  game: Game,
  now: number,
  args: { name: string; character: string; description: string; human?: string; spawn?: Point | null },
): GameId<'players'> {
  if (!characters.find((c) => c.name === args.character)) {
    throw new Error(
      `Invalid character: ${args.character} (expected one of ${characters
        .map((c) => c.name)
        .join(', ')})`,
    );
  }
  const position =
    args.spawn && !game.worldMap.isSolid(Math.floor(args.spawn.x), Math.floor(args.spawn.y))
      ? args.spawn
      : findFreeSpot(game) ?? { x: 1, y: 1 };
  const facingOptions = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  const facing = facingOptions[Math.floor(Math.random() * facingOptions.length)];
  const playerId = game.allocId('players');
  game.world.players.set(
    playerId,
    new Player({
      id: playerId,
      human: args.human,
      lastInput: now,
      position: { x: position.x + 0.5, y: position.y + 0.5 },
      facing,
      speed: 0,
    }),
  );
  game.playerDescriptions.set(playerId, {
    playerId,
    name: args.name,
    description: args.description,
    character: args.character,
  });
  game.markDescriptionsModified();
  return playerId;
}

function playerLeave(game: Game, now: number, player: Player) {
  const conversation = game.world.playerConversation(player);
  if (conversation) {
    conversation.stop(game, now);
  }
  for (const [agentId, agent] of game.world.agents.entries()) {
    if (agent.playerId === player.id) {
      game.world.agents.delete(agentId);
      game.agentDescriptions.delete(agentId);
    }
  }
  game.world.players.delete(player.id);
  game.playerDescriptions.delete(player.id);
  game.castIds.delete(player.id);
  game.markDescriptionsModified();
}

/**
 * A human who invites (or accepts an invite from) somebody walks over to them —
 * agents do this in `Agent.tick`, and a player who has to *also* click a
 * destination would just stand there until the invite timed out.
 */
function walkOverToHuman(game: Game, now: number, player: Player, target: Point | undefined) {
  if (!player.human || !target || player.pathfinding) return;
  try {
    movePlayer(game, now, player, findFreeSpotNear(game, target, 8));
  } catch (e: any) {
    console.warn(`Couldn't walk ${player.id} over: ${e?.message}`);
  }
}

export function findFreeSpot(game: Game): Point | null {
  const { width, height } = game.worldMap;
  for (let attempt = 0; attempt < 400; attempt++) {
    const candidate = {
      x: 1 + Math.floor(Math.random() * Math.max(1, width - 2)),
      y: 1 + Math.floor(Math.random() * Math.max(1, height - 2)),
    };
    if (blocked(game, game.currentTime, candidate) === null) {
      return candidate;
    }
  }
  // Brute-force scan as a fallback.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (blocked(game, game.currentTime, { x, y }) === null) {
        return { x, y };
      }
    }
  }
  return null;
}

export function defaultActivity(now: number): Activity {
  const activity = C.ACTIVITIES[Math.floor(Math.random() * C.ACTIVITIES.length)];
  return {
    description: activity.description,
    emoji: activity.emoji,
    until: now + activity.duration,
  };
}

export type { SerializedPlayer, SerializedAgent };

/**
 * Shared by `finishSendingMessage` (human messages) and `agentFinishSendingMessage`
 * (model replies) — the handlers can't call each other because they're invoked
 * detached from the handler object.
 */
function applyFinishSendingMessage(
  game: Game,
  _now: number,
  args: { playerId: string; conversationId: string; timestamp: number },
) {
  const playerId = parseGameId('players', args.playerId);
  const conversationId = parseGameId('conversations', args.conversationId);
  const conversation = game.world.conversations.get(conversationId);
  if (!conversation) throw new Error(`Invalid conversation ID ${conversationId}`);
  if (conversation.isTyping && conversation.isTyping.playerId === playerId) {
    delete conversation.isTyping;
  }
  conversation.lastMessage = { author: playerId, timestamp: args.timestamp };
  conversation.numMessages++;
  return null;
}
