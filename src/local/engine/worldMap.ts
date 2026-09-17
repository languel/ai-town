/**
 * The world map: tile layers + the derived occupancy grid used for pathfinding.
 *
 * This is the same data shape the AI Town server kept in the `maps` table (and the
 * shape `data/gentle.js` is generated in), so maps round-trip between the in-app
 * editor, IndexedDB, and exported JSON files.
 */

/** `layer[x][y]` is the tile index in the tileset, or -1 when empty. */
export type TileLayer = number[][];

export type AnimatedSprite = {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  sheet: string;
  animation: string;
};

export type SerializedWorldMap = {
  width: number;
  height: number;

  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;

  /** Tile size in pixels (assumed square). */
  tileDim: number;
  bgTiles: TileLayer[];
  objectTiles: TileLayer[];
  animatedSprites: AnimatedSprite[];
};

export class WorldMap {
  width: number;
  height: number;
  tileSetUrl: string;
  tileSetDimX: number;
  tileSetDimY: number;
  tileDim: number;
  bgTiles: TileLayer[];
  objectTiles: TileLayer[];
  animatedSprites: AnimatedSprite[];

  constructor(serialized: SerializedWorldMap) {
    this.width = serialized.width;
    this.height = serialized.height;
    this.tileSetUrl = serialized.tileSetUrl;
    this.tileSetDimX = serialized.tileSetDimX;
    this.tileSetDimY = serialized.tileSetDimY;
    this.tileDim = serialized.tileDim;
    this.bgTiles = serialized.bgTiles;
    this.objectTiles = serialized.objectTiles;
    this.animatedSprites = serialized.animatedSprites ?? [];
  }

  /** How many tiles fit across the tileset image. */
  tileSetColumns() {
    return Math.max(1, Math.floor(this.tileSetDimX / this.tileDim));
  }

  tileSetRows() {
    return Math.max(1, Math.floor(this.tileSetDimY / this.tileDim));
  }

  inBounds(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** True if a world object (tree, wall, water...) occupies this tile. */
  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) {
      return true;
    }
    for (const layer of this.objectTiles) {
      const column = layer[x];
      if (!column) continue;
      const tile = column[y];
      if (tile !== undefined && tile !== -1) {
        return true;
      }
    }
    return false;
  }

  tileAt(layerKind: 'bg' | 'object', layer: number, x: number, y: number): number {
    const layers = layerKind === 'bg' ? this.bgTiles : this.objectTiles;
    return layers[layer]?.[x]?.[y] ?? -1;
  }

  setTile(layerKind: 'bg' | 'object', layer: number, x: number, y: number, tile: number) {
    const layers = layerKind === 'bg' ? this.bgTiles : this.objectTiles;
    while (layers.length <= layer) {
      layers.push(emptyLayer(this.width, this.height));
    }
    // Layers are indexed `[x][y]`, and a tile index of 0 is a real tile — grow
    // the column instead of testing it for truthiness.
    const grid = (layers[layer] ??= emptyLayer(this.width, this.height));
    while (grid.length < this.width) grid.push([]);
    const column = (grid[x] ??= []);
    while (column.length < this.height) column.push(-1);
    column[y] = tile;
  }

  /** Total number of distinct tiles in the tileset image. */
  tileCount() {
    return this.tileSetColumns() * this.tileSetRows();
  }

  serialize(): SerializedWorldMap {
    return {
      width: this.width,
      height: this.height,
      tileSetUrl: this.tileSetUrl,
      tileSetDimX: this.tileSetDimX,
      tileSetDimY: this.tileSetDimY,
      tileDim: this.tileDim,
      bgTiles: this.bgTiles,
      objectTiles: this.objectTiles,
      animatedSprites: this.animatedSprites,
    };
  }
}

export function emptyLayer(width: number, height: number): TileLayer {
  const layer: TileLayer = [];
  for (let x = 0; x < width; x++) {
    const column: number[] = [];
    for (let y = 0; y < height; y++) {
      column.push(-1);
    }
    layer.push(column);
  }
  return layer;
}

export function newMap(partial: Partial<SerializedWorldMap> = {}): SerializedWorldMap {
  const width = partial.width ?? 32;
  const height = partial.height ?? 24;
  const tileDim = partial.tileDim ?? 32;
  const tileSetDimX = partial.tileSetDimX ?? 1440;
  const tileSetDimY = partial.tileSetDimY ?? 1024;
  return {
    width,
    height,
    tileSetUrl: partial.tileSetUrl ?? 'assets/gentle-obj.png',
    tileSetDimX,
    tileSetDimY,
    tileDim,
    bgTiles: partial.bgTiles ?? [emptyLayer(width, height), emptyLayer(width, height)],
    objectTiles: partial.objectTiles ?? [emptyLayer(width, height)],
    animatedSprites: partial.animatedSprites ?? [],
  };
}

/** Normalize a map for storage: rectangular layers, sane numbers, no holes. */
export function normalizeMap(input: any): SerializedWorldMap {
  const width = Math.max(4, Math.floor(input?.width ?? 32));
  const height = Math.max(4, Math.floor(input?.height ?? 32));
  const tileDim = Math.max(8, Math.floor(input?.tileDim ?? 32));

  const fixLayers = (layers: any, minCount: number) => {
    const out: TileLayer[] = [];
    const src: any[] = Array.isArray(layers) ? layers : [];
    const count = Math.max(minCount, src.length);
    for (let l = 0; l < count; l++) {
      const layer = emptyLayer(width, height);
      const inputLayer = src[l];
      if (Array.isArray(inputLayer)) {
        // AI Town indexes layers as `[x][y]`; tolerate `[y][x]` from other tools.
        const indexedByX = inputLayer.length === width;
        for (let x = 0; x < width; x++) {
          for (let y = 0; y < height; y++) {
            const value = indexedByX ? inputLayer[x]?.[y] : inputLayer[y]?.[x];
            const tile = typeof value === 'number' && isFinite(value) ? Math.floor(value) : -1;
            layer[x][y] = tile < 0 ? -1 : tile;
          }
        }
      }
      out.push(layer);
    }
    return out;
  };

  const bgTiles = fixLayers(input?.bgTiles, 1);
  const objectTiles = fixLayers(input?.objectTiles, 1);

  const animatedSprites: AnimatedSprite[] = Array.isArray(input?.animatedSprites)
    ? input.animatedSprites
        .filter((s: any) => s && typeof s.x === 'number' && typeof s.y === 'number')
        .map((s: any) => ({
          x: s.x,
          y: s.y,
          w: s.w ?? s.width ?? 32,
          h: s.h ?? s.height ?? 32,
          layer: s.layer ?? 1,
          sheet: String(s.sheet ?? ''),
          animation: String(s.animation ?? 'pixels_large'),
        }))
    : [];

  return {
    width,
    height,
    tileSetUrl: String(input?.tileSetUrl ?? 'assets/gentle-obj.png'),
    tileSetDimX: Math.floor(input?.tileSetDimX ?? 1440),
    tileSetDimY: Math.floor(input?.tileSetDimY ?? 1024),
    tileDim,
    bgTiles,
    objectTiles,
    animatedSprites,
  };
}
