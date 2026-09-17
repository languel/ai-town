import { GameId, parseGameId } from './ids';
import {
  C,
} from '../constants';
import { distance } from './geometry';
import type { Game } from './game';
import { findFreeSpotNear, movePlayer } from './movement';
import { Player } from './player';
import { Conversation } from './conversation';

export type SerializedAgent = {
  id: string;
  playerId: string;
  toRemember?: string;
  lastConversation?: number;
  lastInviteAttempt?: number;
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };
};

/**
 * The in-world half of an AI character: when to wake up, when to invite someone,
 * when to talk, when to remember. Ported from `convex/aiTown/agent.ts`; the
 * expensive async work (LLM calls) happens in `src/local/ai/operations.ts`.
 */
export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };

  constructor(serialized: SerializedAgent) {
    this.id = parseGameId('agents', serialized.id);
    this.playerId = parseGameId('players', serialized.playerId);
    this.toRemember =
      serialized.toRemember !== undefined
        ? parseGameId('conversations', serialized.toRemember)
        : undefined;
    this.lastConversation = serialized.lastConversation;
    this.lastInviteAttempt = serialized.lastInviteAttempt;
    this.inProgressOperation = serialized.inProgressOperation;
  }

  tick(game: Game, now: number) {
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }
    if (this.inProgressOperation) {
      if (now < this.inProgressOperation.started + C.ACTION_TIMEOUT) {
        return;
      }
      console.log(`Timing out ${JSON.stringify(this.inProgressOperation)}`);
      delete this.inProgressOperation;
    }
    const conversation = game.world.playerConversation(player);
    const member = conversation?.participants.get(player.id);

    const recentlyAttemptedInvite =
      this.lastInviteAttempt && now < this.lastInviteAttempt + C.CONVERSATION_COOLDOWN;
    const doingActivity = player.activity && player.activity.until > now;
    if (doingActivity && (conversation || player.pathfinding)) {
      player.activity!.until = now;
    }
    // Check to see if we have a conversation we need to remember. Unlike the
    // hosted engine this runs *before* the "do something" branch: an agent that
    // just left a chat is idle, so the idle branch would keep winning and the
    // memory would never be written.
    if (this.toRemember) {
      this.startOperation(game, now, 'agentRememberConversation', {
        playerId: this.playerId,
        agentId: this.id,
        conversationId: this.toRemember,
      });
      delete this.toRemember;
      return;
    }
    if (!conversation && !doingActivity && (!player.pathfinding || !recentlyAttemptedInvite)) {
      this.startOperation(game, now, 'agentDoSomething', {
        player: player.serialize(),
        otherFreePlayers: [...game.world.players.values()]
          .filter((p) => p.id !== player.id)
          .filter(
            (p) => ![...game.world.conversations.values()].find((c) => c.participants.has(p.id)),
          )
          .map((p) => p.serialize()),
        agent: this.serialize(),
        map: game.worldMap.serialize(),
      });
      return;
    }
    if (conversation && member) {
      const [otherPlayerId] = [...conversation.participants.keys()].filter(
        (id) => id !== player.id,
      );
      const otherPlayer = game.world.players.get(otherPlayerId)!;
      if (member.status.kind === 'invited') {
        if (otherPlayer.human || Math.random() < C.INVITE_ACCEPT_PROBABILITY) {
          conversation.acceptInvite(game, player);
          if (player.pathfinding) {
            delete player.pathfinding;
          }
        } else {
          conversation.rejectInvite(game, now, player);
        }
        return;
      }
      if (member.status.kind === 'walkingOver') {
        if (member.invited + C.INVITE_TIMEOUT < now) {
          conversation.leave(game, now, player);
          return;
        }
        const playerDistance = distance(player.position, otherPlayer.position);
        if (playerDistance < C.CONVERSATION_DISTANCE) {
          return;
        }
        if (!player.pathfinding) {
          let destination;
          if (playerDistance < C.MIDPOINT_THRESHOLD) {
            destination = findFreeSpotNear(game, otherPlayer.position, 8);
          } else {
            destination = {
              x: Math.floor((player.position.x + otherPlayer.position.x) / 2),
              y: Math.floor((player.position.y + otherPlayer.position.y) / 2),
            };
          }
          movePlayer(game, now, player, destination);
        }
        return;
      }
      if (member.status.kind === 'participating') {
        const started = member.status.started;
        if (conversation.isTyping && conversation.isTyping.playerId !== player.id) {
          return;
        }
        if (!conversation.lastMessage) {
          const isInitiator = conversation.creator === player.id;
          const awkwardDeadline = started + C.AWKWARD_CONVERSATION_TIMEOUT;
          if (isInitiator || awkwardDeadline < now) {
            this.sendMessage(game, now, conversation, otherPlayer, 'start');
          }
          return;
        }
        const tooLongDeadline = started + C.MAX_CONVERSATION_DURATION;
        if (tooLongDeadline < now || conversation.numMessages > C.MAX_CONVERSATION_MESSAGES) {
          this.sendMessage(game, now, conversation, otherPlayer, 'leave');
          return;
        }
        if (conversation.lastMessage.author === player.id) {
          const awkwardDeadline =
            conversation.lastMessage.timestamp + C.AWKWARD_CONVERSATION_TIMEOUT;
          if (now < awkwardDeadline) {
            return;
          }
        }
        const messageCooldown = conversation.lastMessage.timestamp + C.MESSAGE_COOLDOWN;
        if (now < messageCooldown) {
          return;
        }
        this.sendMessage(game, now, conversation, otherPlayer, 'continue');
        return;
      }
    }
  }

  private sendMessage(
    game: Game,
    now: number,
    conversation: Conversation,
    otherPlayer: Player,
    type: 'start' | 'continue' | 'leave',
  ) {
    const messageUuid = uuidLike();
    conversation.setIsTyping(now, game.world.players.get(this.playerId)!, messageUuid);
    this.startOperation(game, now, 'agentGenerateMessage', {
      playerId: this.playerId,
      agentId: this.id,
      conversationId: conversation.id,
      otherPlayerId: otherPlayer.id,
      messageUuid,
      type,
    });
  }

  startOperation<Name extends keyof AgentOperations>(
    game: Game,
    now: number,
    name: Name,
    args: AgentOperations[Name],
  ) {
    if (this.inProgressOperation) {
      throw new Error(
        `Agent ${this.id} already has an operation: ${JSON.stringify(this.inProgressOperation)}`,
      );
    }
    const operationId = game.allocId('operations');
    game.scheduleOperation(name, { operationId, ...args } as any);
    this.inProgressOperation = { name, operationId, started: now };
  }

  serialize(): SerializedAgent {
    return {
      id: this.id,
      playerId: this.playerId,
      toRemember: this.toRemember,
      lastConversation: this.lastConversation,
      lastInviteAttempt: this.lastInviteAttempt,
      inProgressOperation: this.inProgressOperation,
    };
  }
}

function uuidLike() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Async jobs the engine asks the AI layer to run. */
export type AgentOperations = {
  agentDoSomething: {
    player: any;
    agent: SerializedAgent;
    map: any;
    otherFreePlayers: any[];
  };
  agentRememberConversation: {
    playerId: string;
    agentId: string;
    conversationId: string;
  };
  agentGenerateMessage: {
    playerId: string;
    agentId: string;
    conversationId: string;
    otherPlayerId: string;
    messageUuid: string;
    type: 'start' | 'continue' | 'leave';
  };
};
