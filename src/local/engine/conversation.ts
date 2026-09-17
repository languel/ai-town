import { GameId, parseGameId } from './ids';
import { Player } from './player';
import { C } from '../constants';
import { distance, normalize, vector } from './geometry';
import { Point } from './types';
import type { Game } from './game';
import { stopPlayer, blocked, movePlayer, findFreeSpotNear } from './movement';
import { ConversationMembership, SerializedConversationMembership } from './conversationMembership';
import { parseMap, serializeMap } from './object';

export type SerializedConversation = {
  id: string;
  creator: string;
  created: number;
  isTyping?: { playerId: string; messageUuid: string; since: number };
  lastMessage?: { author: string; timestamp: number };
  numMessages: number;
  participants: SerializedConversationMembership[];
};

/**
 * A two-person conversation. Ported from `convex/aiTown/conversation.ts`.
 */
export class Conversation {
  /** Ephemeral: throttles re-nudging a stuck participant, never serialized. */
  lastNudge?: number;
  id: GameId<'conversations'>;
  creator: GameId<'players'>;
  created: number;
  isTyping?: {
    playerId: GameId<'players'>;
    messageUuid: string;
    since: number;
  };
  lastMessage?: {
    author: GameId<'players'>;
    timestamp: number;
  };
  numMessages: number;
  participants: Map<GameId<'players'>, ConversationMembership>;

  constructor(serialized: SerializedConversation) {
    const { id, creator, created, isTyping, lastMessage, numMessages, participants } = serialized;
    this.id = parseGameId('conversations', id);
    this.creator = parseGameId('players', creator);
    this.created = created;
    this.isTyping = isTyping && {
      playerId: parseGameId('players', isTyping.playerId),
      messageUuid: isTyping.messageUuid,
      since: isTyping.since,
    };
    this.lastMessage = lastMessage && {
      author: parseGameId('players', lastMessage.author),
      timestamp: lastMessage.timestamp,
    };
    this.numMessages = numMessages;
    this.participants = parseMap(participants, ConversationMembership, (m) => m.playerId);
  }

  tick(game: Game, now: number) {
    if (this.isTyping && this.isTyping.since + C.TYPING_TIMEOUT < now) {
      delete this.isTyping;
    }
    if (this.participants.size !== 2) {
      console.warn(`Conversation ${this.id} has ${this.participants.size} participants`);
      return;
    }
    const [playerId1, playerId2] = [...this.participants.keys()];
    const member1 = this.participants.get(playerId1)!;
    const member2 = this.participants.get(playerId2)!;

    const player1 = game.world.players.get(playerId1);
    const player2 = game.world.players.get(playerId2);
    if (!player1 || !player2) {
      this.stop(game, now);
      return;
    }

    const playerDistance = distance(player1.position, player2.position);

    // A human waits where they stand, so the other person doesn't have to make it
    // all the way into the exact conversation radius or the chat silently never
    // starts (they give up on obstacles otherwise).
    const arriveRadius = C.CONVERSATION_DISTANCE + (player1.human || player2.human ? 1.0 : 0);

    if (member1.status.kind === 'walkingOver' && member2.status.kind === 'walkingOver') {
      if (playerDistance < arriveRadius) {
        // First, stop the two players from moving.
        stopPlayer(player1);
        stopPlayer(player2);

        member1.status = { kind: 'participating', started: now };
        member2.status = { kind: 'participating', started: now };

        // Nudge them to face each other on adjacent, unblocked tiles.
        const neighbors = (p: Point) => [
          { x: p.x + 1, y: p.y },
          { x: p.x - 1, y: p.y },
          { x: p.x, y: p.y + 1 },
          { x: p.x, y: p.y - 1 },
        ];
        const floorPos1 = { x: Math.floor(player1.position.x), y: Math.floor(player1.position.y) };
        const p1Candidates = neighbors(floorPos1).filter((p) => !blocked(game, now, p, player1.id));
        p1Candidates.sort((a, b) => distance(a, player2.position) - distance(b, player2.position));
        if (p1Candidates.length > 0) {
          const p1Candidate = p1Candidates[0];
          const p2Candidates = neighbors(p1Candidate).filter(
            (p) => !blocked(game, now, p, player2.id),
          );
          p2Candidates.sort(
            (a, b) => distance(a, player1.position) - distance(b, player1.position),
          );
          if (p2Candidates.length > 0) {
            const p2Candidate = p2Candidates[0];
            movePlayer(game, now, player1, p1Candidate, true);
            movePlayer(game, now, player2, p2Candidate, true);
          }
        }
      }
    }

    if (member1.status.kind === 'walkingOver' || member2.status.kind === 'walkingOver') {
      // Whoever is standing still while their counterpart walks over gets a nudge:
      // one failed A* (a wall, a pond, a crowded doorway) used to leave the pair
      // staring at each other until INVITE_TIMEOUT quietly cancelled the chat.
      const nudge = (self: Player, other: Player, selfMember: ConversationMembership) => {
        if (selfMember.status.kind !== 'walkingOver') return;
        if (self.pathfinding || self.activity) return;
        if (playerDistance <= arriveRadius) return;
        if (this.lastNudge && now - this.lastNudge < 1500) return;
        this.lastNudge = now;
        try {
          movePlayer(game, now, self, findFreeSpotNear(game, other.position, 3), true);
        } catch {
          // Nowhere safe to step; the other side keeps coming.
        }
      };
      nudge(player1, player2, member1);
      nudge(player2, player1, member2);
    }

    // Orient the two players towards each other if they're not moving.
    if (member1.status.kind === 'participating' && member2.status.kind === 'participating') {
      const v = normalize(vector(player1.position, player2.position));
      if (!player1.pathfinding && v) {
        player1.facing = v;
      }
      if (!player2.pathfinding && v) {
        player2.facing = { dx: -v.dx, dy: -v.dy };
      }
    }
  }

  static start(game: Game, now: number, player: Player, invitee: Player) {
    if (player.id === invitee.id) {
      throw new Error(`Can't invite yourself to a conversation`);
    }
    if ([...game.world.conversations.values()].find((c) => c.participants.has(player.id))) {
      return { error: `Player ${player.id} is already in a conversation` };
    }
    if ([...game.world.conversations.values()].find((c) => c.participants.has(invitee.id))) {
      return { error: `Player ${invitee.id} is already in a conversation` };
    }
    const conversationId = game.allocId('conversations');
    game.world.conversations.set(
      conversationId,
      new Conversation({
        id: conversationId,
        created: now,
        creator: player.id,
        numMessages: 0,
        participants: [
          { playerId: player.id, invited: now, status: { kind: 'walkingOver' } },
          { playerId: invitee.id, invited: now, status: { kind: 'invited' } },
        ],
      }),
    );
    return { conversationId };
  }

  setIsTyping(now: number, player: Player, messageUuid: string) {
    if (this.isTyping) {
      if (this.isTyping.playerId !== player.id) {
        throw new Error(`Player ${this.isTyping.playerId} is already typing in ${this.id}`);
      }
      return;
    }
    this.isTyping = { playerId: player.id, messageUuid, since: now };
  }

  acceptInvite(_game: Game, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Player ${player.id} not in conversation ${this.id}`);
    }
    if (member.status.kind !== 'invited') {
      throw new Error(
        `Invalid membership status for ${player.id}:${this.id}: ${JSON.stringify(member)}`,
      );
    }
    member.status = { kind: 'walkingOver' };
  }

  rejectInvite(game: Game, now: number, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Player ${player.id} not in conversation ${this.id}`);
    }
    if (member.status.kind !== 'invited') {
      throw new Error(
        `Rejecting invite in wrong membership state: ${this.id}:${player.id}: ${JSON.stringify(
          member,
        )}`,
      );
    }
    this.stop(game, now);
  }

  stop(game: Game, now: number) {
    delete this.isTyping;
    for (const [playerId] of this.participants.entries()) {
      const agent = [...game.world.agents.values()].find((a) => a.playerId === playerId);
      if (agent) {
        agent.lastConversation = now;
        agent.toRemember = this.id;
      }
    }
    game.archiveConversation(this);
    game.world.conversations.delete(this.id);
  }

  leave(game: Game, now: number, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Couldn't find membership for ${this.id}:${player.id}`);
    }
    this.stop(game, now);
  }

  serialize(): SerializedConversation {
    const { id, creator, created, isTyping, lastMessage, numMessages } = this;
    return {
      id,
      creator,
      created,
      isTyping,
      lastMessage,
      numMessages,
      participants: serializeMap(this.participants),
    };
  }
}
