/**
 * Game-scoped IDs. Mirrors `convex/aiTown/ids.ts` but without Convex validators.
 */

const IdShortCodes = {
  players: 'p',
  agents: 'a',
  conversations: 'c',
  operations: 'o',
  characters: 'k',
} as const;

export type IdTypes = keyof typeof IdShortCodes;

export type GameId<T extends IdTypes> = string & { __type: T };

export function parseGameId<T extends IdTypes>(idType: T, gameId: string): GameId<T> {
  const type = gameId[0];
  const match = Object.entries(IdShortCodes).find(([_, value]) => value === type);
  if (!match || match[0] !== idType) {
    throw new Error(`Invalid game ID type for ${idType}: ${gameId}`);
  }
  const number = parseInt(gameId.slice(2), 10);
  if (isNaN(number) || !Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid game ID number: ${gameId}`);
  }
  return gameId as GameId<T>;
}

export function allocGameId<T extends IdTypes>(idType: T, idNumber: number): GameId<T> {
  const type = IdShortCodes[idType];
  if (!type) {
    throw new Error(`Invalid game ID type: ${idType}`);
  }
  return `${type}:${idNumber}` as GameId<T>;
}

export function looksLikeGameId(value: unknown): value is GameId<IdTypes> {
  return typeof value === 'string' && /^[pacok]:\d+$/.test(value);
}
