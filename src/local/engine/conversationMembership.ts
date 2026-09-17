import { GameId, parseGameId } from './ids';

export type SerializedConversationMembership = {
  playerId: string;
  invited: number;
  status:
    | { kind: 'invited' }
    | { kind: 'walkingOver' }
    | { kind: 'participating'; started: number };
};

export class ConversationMembership {
  playerId: GameId<'players'>;
  invited: number;
  status:
    | { kind: 'invited' }
    | { kind: 'walkingOver' }
    | { kind: 'participating'; started: number };

  constructor(serialized: SerializedConversationMembership) {
    this.playerId = parseGameId('players', serialized.playerId);
    this.invited = serialized.invited;
    this.status = serialized.status;
  }

  serialize(): SerializedConversationMembership {
    const { playerId, invited, status } = this;
    return { playerId, invited, status };
  }
}
