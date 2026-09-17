import { Player } from './player';

/** A player's pose at a point in time. Used by the renderer. */
export type Location = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
};

export function playerLocation(player: Player): Location {
  return {
    x: player.position.x,
    y: player.position.y,
    dx: player.facing.dx,
    dy: player.facing.dy,
    speed: player.speed,
  };
}
