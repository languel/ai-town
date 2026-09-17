import { Point, Vector, Path } from './types';
import { C } from '../constants';
import { pointsEqual, pathPosition } from './geometry';
import { GameId, parseGameId } from './ids';
import type { Game } from './game';
import { stopPlayer, findRoute, blocked } from './movement';

export type Pathfinding = {
  destination: Point;
  started: number;
  /** Consecutive A* failures for this destination. */
  failures?: number;
  state:
    | { kind: 'needsPath' }
    | { kind: 'waiting'; until: number }
    | { kind: 'moving'; path: Path };
};

export type Activity = {
  description: string;
  emoji?: string;
  until: number;
};

export type SerializedPlayer = {
  id: string;
  /** Set for humans: a stable local identity string. */
  human?: string;
  pathfinding?: Pathfinding;
  activity?: Activity;
  /** The last time they did something. */
  lastInput: number;
  position: Point;
  facing: Vector;
  speed: number;
};

/**
 * A player in the world: position, facing, movement state.
 * Ported from `convex/aiTown/player.ts`.
 */
export class Player {
  id: GameId<'players'>;
  human?: string;
  pathfinding?: Pathfinding;
  activity?: Activity;
  lastInput: number;
  position: Point;
  facing: Vector;
  speed: number;

  constructor(serialized: SerializedPlayer) {
    this.id = parseGameId('players', serialized.id);
    this.human = serialized.human;
    this.pathfinding = serialized.pathfinding;
    this.activity = serialized.activity;
    this.lastInput = serialized.lastInput;
    this.position = serialized.position;
    this.facing = serialized.facing;
    this.speed = serialized.speed ?? 0;
  }

  tick(_game: Game, _now: number) {
    // Humans used to be kicked after idling for 5 minutes on the server. In a
    // single-player, local-first app that's just annoying, so we keep them.
  }

  tickPathfinding(game: Game, now: number) {
    const { pathfinding, position } = this;
    if (!pathfinding) {
      return;
    }

    if (pathfinding.state.kind === 'moving' && pointsEqual(pathfinding.destination, position)) {
      stopPlayer(this);
    }

    if (pathfinding.started + C.PATHFINDING_TIMEOUT < now) {
      stopPlayer(this);
    }

    if (pathfinding.state.kind === 'waiting' && pathfinding.state.until < now) {
      pathfinding.state = { kind: 'needsPath' };
    }

    if (pathfinding.state.kind === 'needsPath' && game.numPathfinds < C.MAX_PATHFINDS_PER_STEP) {
      game.numPathfinds++;
      const route = findRoute(game, now, this, pathfinding.destination);
      if (route === null) {
        // Somebody (or something) is in the way, or the tile is unreachable.
        // Back off rather than re-running A* for the same tile every tick, and
        // give up after a few tries so the agent picks a new plan.
        const failures = (pathfinding.failures ?? 0) + 1;
        if (failures >= 3) {
          console.warn(`No route to ${JSON.stringify(pathfinding.destination)}, giving up`);
          stopPlayer(this);
        } else {
          pathfinding.failures = failures;
          pathfinding.state = { kind: 'waiting', until: now + C.PATHFINDING_BACKOFF };
        }
      } else {
        if (route.newDestination) {
          pathfinding.destination = route.newDestination;
        }
        delete pathfinding.failures;
        pathfinding.state = { kind: 'moving', path: route.path };
      }
    }
  }

  tickPosition(game: Game, now: number) {
    if (!this.pathfinding || this.pathfinding.state.kind !== 'moving') {
      this.speed = 0;
      return;
    }

    const candidate = pathPosition(this.pathfinding.state.path, now);
    if (!candidate) {
      return;
    }
    const { position, facing, velocity } = candidate;
    const collisionReason = blocked(game, now, position, this.id);
    if (collisionReason !== null) {
      const backoff = Math.random() * C.PATHFINDING_BACKOFF;
      this.pathfinding.state = { kind: 'waiting', until: now + backoff };
      return;
    }
    this.position = position;
    this.facing = facing;
    this.speed = velocity;
  }

  serialize(): SerializedPlayer {
    const { id, human, pathfinding, activity, lastInput, position, facing, speed } = this;
    return { id, human, pathfinding, activity, lastInput, position, facing, speed };
  }
}

export function newPlayerId(game: Game): GameId<'players'> {
  return game.allocId('players');
}

export function assertPlayerId(value: string): GameId<'players'> {
  return parseGameId('players', value);
}
