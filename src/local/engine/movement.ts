import { C } from '../constants';
import { compressPath, distance, manhattanDistance, pointsEqual } from './geometry';
import { MinHeap } from './minheap';
import { Point, Vector } from './types';
import type { Game } from './game';
import { GameId } from './ids';
import { Player } from './player';
import { WorldMap } from './worldMap';

export type PathCandidate = {
  position: Point;
  facing?: Vector;
  t: number;
  length: number;
  cost: number;
  prev?: PathCandidate;
};

export function stopPlayer(player: Player) {
  delete player.pathfinding;
  player.speed = 0;
}

export function movePlayer(
  game: Game,
  now: number,
  player: Player,
  destination: Point,
  allowInConversation?: boolean,
) {
  if (Math.floor(destination.x) !== destination.x || Math.floor(destination.y) !== destination.y) {
    throw new Error(`Non-integral destination: ${JSON.stringify(destination)}`);
  }
  const { position } = player;
  if (pointsEqual(position, destination)) {
    return;
  }
  const inConversation = [...game.world.conversations.values()].some(
    (c) => c.participants.get(player.id)?.status.kind === 'participating',
  );
  if (inConversation && !allowInConversation) {
    throw new Error(`Can't move when in a conversation. Leave the conversation first!`);
  }
  player.pathfinding = {
    destination,
    started: now,
    state: { kind: 'needsPath' },
  };
}

/**
 * A* over the tile grid, avoiding solid map tiles and other players.
 * Ported from `convex/aiTown/movement.ts`.
 */
export function findRoute(game: Game, now: number, player: Player, destination: Point) {
  const minDistances: PathCandidate[][] = [];
  const explore = (current: PathCandidate): PathCandidate[] => {
    const { x, y } = current.position;
    const neighbors = [];

    // If we're not on a grid point, first move to an adjacent grid point.
    if (x !== Math.floor(x)) {
      neighbors.push(
        { position: { x: Math.floor(x), y }, facing: { dx: -1, dy: 0 } },
        { position: { x: Math.floor(x) + 1, y }, facing: { dx: 1, dy: 0 } },
      );
    }
    if (y !== Math.floor(y)) {
      neighbors.push(
        { position: { x, y: Math.floor(y) }, facing: { dx: 0, dy: -1 } },
        { position: { x, y: Math.floor(y) + 1 }, facing: { dx: 0, dy: 1 } },
      );
    }
    if (x == Math.floor(x) && y == Math.floor(y)) {
      neighbors.push(
        { position: { x: x + 1, y }, facing: { dx: 1, dy: 0 } },
        { position: { x: x - 1, y }, facing: { dx: -1, dy: 0 } },
        { position: { x, y: y + 1 }, facing: { dx: 0, dy: 1 } },
        { position: { x, y: y - 1 }, facing: { dx: 0, dy: -1 } },
      );
    }
    const next = [];
    for (const { position, facing } of neighbors) {
      const segmentLength = distance(current.position, position);
      const length = current.length + segmentLength;
      if (blocked(game, now, position, player.id)) {
        continue;
      }
      const remaining = manhattanDistance(position, destination);
      const path = {
        position,
        facing,
        t: current.t + (segmentLength / C.MOVEMENT_SPEED) * 1000,
        length,
        cost: length + remaining,
        prev: current,
      };
      const existingMin = minDistances[position.y]?.[position.x];
      if (existingMin && existingMin.cost <= path.cost) {
        continue;
      }
      minDistances[position.y] ??= [];
      minDistances[position.y][position.x] = path;
      next.push(path);
    }
    return next;
  };

  const startingPosition = { x: player.position.x, y: player.position.y };
  let current: PathCandidate | undefined = {
    position: startingPosition,
    facing: player.facing,
    t: now,
    length: 0,
    cost: manhattanDistance(startingPosition, destination),
    prev: undefined,
  };
  let bestCandidate = current;
  const minheap = MinHeap<PathCandidate>((p0, p1) => p0.cost > p1.cost);
  const maxExpansions = game.worldMap.width * game.worldMap.height * 4;
  let expansions = 0;
  while (current && expansions++ < maxExpansions) {
    if (pointsEqual(current.position, destination)) {
      break;
    }
    if (
      manhattanDistance(current.position, destination) <
      manhattanDistance(bestCandidate.position, destination)
    ) {
      bestCandidate = current;
    }
    for (const candidate of explore(current)) {
      minheap.push(candidate);
    }
    current = minheap.pop();
  }
  let newDestination = null;
  if (!current || !pointsEqual(current.position, destination)) {
    if (bestCandidate.length === 0) {
      return null;
    }
    current = bestCandidate;
    newDestination = current.position;
  }
  const densePath = [];
  let facing = current.facing!;
  while (current) {
    densePath.push({ position: current.position, t: current.t, facing });
    facing = current.facing!;
    current = current.prev;
  }
  densePath.reverse();

  return { path: compressPath(densePath), newDestination };
}

/**
 * The closest walkable tile to `point`, searched outward. Used whenever an agent
 * wants to walk "to" someone: their exact tile can be solid (or occupied), and
 * a failed route would leave the pair standing around forever.
 */
export function findFreeSpotNear(
  game: Game,
  point: Point,
  maxRadius = 8,
  options: { avoidPlayers?: boolean } = {},
): Point {
  // `avoidPlayers: false` only rules out solid tiles. When an agent walks to
  // stand next to somebody, the human standing there mustn't count as an
  // obstacle — otherwise the two of them can hover a tile-and-a-half apart,
  // never close enough to start talking.
  const avoidPlayers = options.avoidPlayers ?? true;
  const walkable = (p: Point) =>
    game.worldMap.inBounds(p.x, p.y) &&
    !game.worldMap.isSolid(p.x, p.y) &&
    (!avoidPlayers || blocked(game, game.currentTime, p) === null);
  const base = { x: Math.floor(point.x), y: Math.floor(point.y) };
  if (walkable(base)) return base;
  // Collect then sort by real distance to `point`: scanning a square ring picks
  // diagonals first, which would leave two people standing a tile-and-a-half
  // apart — too far to start a conversation (CONVERSATION_DISTANCE is 1.3).
  const candidates: Point[] = [];
  for (let dx = -maxRadius; dx <= maxRadius; dx++) {
    for (let dy = -maxRadius; dy <= maxRadius; dy++) {
      if (dx === 0 && dy === 0) continue;
      const candidate = { x: base.x + dx, y: base.y + dy };
      if (walkable(candidate)) candidates.push(candidate);
    }
  }
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x + 0.5 - point.x, a.y + 0.5 - point.y) -
      Math.hypot(b.x + 0.5 - point.x, b.y + 0.5 - point.y),
  );
  return candidates[0] ?? base;
}

export function blocked(game: Game, now: number, pos: Point, playerId?: GameId<'players'>) {
  const otherPositions = [...game.world.players.values()]
    .filter((p) => p.id !== playerId)
    .map((p) => p.position);
  return blockedWithPositions(pos, otherPositions, game.worldMap, now, playerId);
}

export function blockedWithPositions(
  position: Point,
  otherPositions: Point[],
  map: WorldMap,
  _now?: number,
  _playerId?: string,
): string | null {
  if (isNaN(position.x) || isNaN(position.y)) {
    throw new Error(`NaN position in ${JSON.stringify(position)}`);
  }
  if (position.x < 0 || position.y < 0 || position.x >= map.width || position.y >= map.height) {
    return 'out of bounds';
  }
  if (map.isSolid(Math.floor(position.x), Math.floor(position.y))) {
    return 'world blocked';
  }
  for (const otherPosition of otherPositions) {
    if (distance(otherPosition, position) < C.COLLISION_THRESHOLD) {
      return 'player';
    }
  }
  return null;
}
