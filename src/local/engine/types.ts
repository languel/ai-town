/**
 * Geometry/path primitives shared by the simulation. Ported from
 * `convex/util/types.ts` without the Convex validators.
 */

export type Point = { x: number; y: number };
export type Vector = { dx: number; dy: number };

/** Paths are arrays of [x, y, dx, dy, t] tuples. */
export type Path = [number, number, number, number, number][];

export type PathComponent = { position: Point; facing: Vector; t: number };

export function queryPath(p: Path, at: number): PathComponent {
  return unpackPathComponent(p[at]);
}

export function packPathComponent(
  p: PathComponent,
): [number, number, number, number, number] {
  return [p.position.x, p.position.y, p.facing.dx, p.facing.dy, p.t];
}

export function unpackPathComponent(p: [number, number, number, number, number]): PathComponent {
  return {
    position: { x: p[0], y: p[1] },
    facing: { dx: p[2], dy: p[3] },
    t: p[4],
  };
}

export function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.x === 'number' && typeof v.y === 'number' && !isNaN(v.x) && !isNaN(v.y);
}
