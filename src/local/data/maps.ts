import type { SerializedWorldMap } from '../engine/worldMap';
import { emptyLayer } from '../engine/worldMap';

/**
 * The default town map.
 *
 * `data/gentle.js` is the same generated map the Convex seed inserted into the
 * `maps` table, so a local world starts in the familiar Gentle town. It's loaded
 * as a module (no fetch) and then copied into IndexedDB, where the map editor
 * owns it.
 */

const TILESET_URL = 'assets/gentle-obj.png';

let cache: SerializedWorldMap | null = null;

export async function loadDefaultMap(): Promise<SerializedWorldMap> {
  if (cache) return cache;
  try {
    const gentle: any = await import('../../../data/gentle.js');
    cache = {
      width: gentle.mapwidth ?? gentle.bgtiles?.[0]?.length ?? 48,
      height: gentle.mapheight ?? gentle.bgtiles?.[0]?.[0]?.length ?? 32,
      tileSetUrl: TILESET_URL,
      tileSetDimX: gentle.tilesetpxw ?? 1440,
      tileSetDimY: gentle.tilesetpxh ?? 1024,
      tileDim: gentle.tiledim ?? 32,
      bgTiles: gentle.bgtiles ?? [emptyLayer(48, 32), emptyLayer(48, 32)],
      objectTiles: gentle.objmap ?? [emptyLayer(48, 32)],
      animatedSprites: gentle.animatedsprites ?? [],
    };
  } catch (e) {
    console.warn('Falling back to a generated map', e);
    cache = proceduralMap(40, 28);
  }
  return cache;
}

/**
 * A small hand-rolled map (grass + a pond + a border of trees) so the app still
 * boots somewhere walkable if the bundled art can't be loaded.
 */
export function proceduralMap(width = 40, height = 28): SerializedWorldMap {
  const tileDim = 32;
  const columns = Math.floor(1440 / tileDim);
  const grass = 271;
  const water = 962;
  const tree = 5;

  const bg0 = emptyLayer(width, height);
  const bg1 = emptyLayer(width, height);
  const obj0 = emptyLayer(width, height);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      bg0[x][y] = grass;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const nearEdge = x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2;
      if (edge) {
        obj0[x][y] = tree;
        bg0[x][y] = tree + columns;
      } else if (nearEdge && (x + y) % 3 === 0) {
        obj0[x][y] = tree;
        bg0[x][y] = tree + columns;
      }
      const dx = x - width * 0.66;
      const dy = y - height * 0.6;
      if (dx * dx * 1.6 + dy * dy * 2.4 < 18) {
        bg0[x][y] = water;
        bg1[x][y] = -1;
        obj0[x][y] = water;
      }
    }
  }

  return {
    width,
    height,
    tileSetUrl: TILESET_URL,
    tileSetDimX: 1440,
    tileSetDimY: 1024,
    tileDim,
    bgTiles: [bg0, bg1],
    objectTiles: [obj0],
    animatedSprites: [],
  };
}

/** Tilesets shipped in `public/assets` that the map editor can switch to. */
export const BUILTIN_TILESETS = [
  {
    name: 'Gentle (default)',
    url: 'assets/gentle-obj.png',
    tileDim: 32,
    tileSetDimX: 1440,
    tileSetDimY: 1024,
  },
  {
    name: 'RPG tileset',
    url: 'assets/rpg-tileset.png',
    tileDim: 16,
    tileSetDimX: 1600,
    tileSetDimY: 1600,
  },
  {
    name: 'Mage city',
    url: 'assets/magecity.png',
    tileDim: 16,
    tileSetDimX: 256,
    tileSetDimY: 1450,
  },
];

/** Sprite sheets the engine knows how to animate (see PixiMap). */
export const ANIMATION_SHEETS = [
  { sheet: 'campfire.json', animation: 'pixels_large', url: 'assets/spritesheets/campfire.png' },
  {
    sheet: 'gentlesparkle.json',
    animation: 'pixels_large',
    url: 'assets/spritesheets/gentlesparkle32.png',
  },
  {
    sheet: 'gentlewaterfall.json',
    animation: 'pixels_large',
    url: 'assets/spritesheets/gentlewaterfall32.png',
  },
  {
    sheet: 'gentlesplash.json',
    animation: 'pixels_large',
    url: 'assets/spritesheets/gentlewaterfall32.png',
  },
  { sheet: 'windmill.json', animation: 'pixels_large', url: 'assets/spritesheets/windmill.png' },
];
