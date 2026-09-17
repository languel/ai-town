import * as PIXI from 'pixi.js';
import { PixiComponent, applyDefaultProps } from '@pixi/react';
import type { WorldMap } from '../engine/worldMap';
import { resolveAssetUrl } from '../assets';
import * as campfire from '../../../data/animations/campfire.json';
import * as gentleSparkle from '../../../data/animations/gentlesparkle.json';
import * as gentleWaterfall from '../../../data/animations/gentlewaterfall.json';
import * as gentleSplash from '../../../data/animations/gentlesplash.json';
import * as windmill from '../../../data/animations/windmill.json';

/**
 * Renders the tilemap + its animated sprites. A port of
 * `src/components/PixiStaticMap.tsx` that takes a plain serialized map and
 * re-renders whenever `revision` changes (i.e. when the map editor saves).
 */

const animations: Record<string, { spritesheet: any; url: string }> = {
  'campfire.json': { spritesheet: campfire, url: 'assets/spritesheets/campfire.png' },
  'gentlesparkle.json': {
    spritesheet: gentleSparkle,
    url: 'assets/spritesheets/gentlesparkle32.png',
  },
  'gentlewaterfall.json': {
    spritesheet: gentleWaterfall,
    url: 'assets/spritesheets/gentlewaterfall32.png',
  },
  'gentlesplash.json': {
    spritesheet: gentleSplash,
    url: 'assets/spritesheets/gentlewaterfall32.png',
  },
  'windmill.json': { spritesheet: windmill, url: 'assets/spritesheets/windmill.png' },
};

export type PixiMapProps = {
  map: WorldMap;
  revision: number;
  showGrid?: boolean;
  showBlocked?: boolean;
  [key: string]: any;
};

export const PixiMap = PixiComponent('LocalMap', {
  create: (props: PixiMapProps) => {
    const container = renderMap(props.map, props);
    return container;
  },
  applyProps: (instance: PIXI.Container, oldProps: PixiMapProps, newProps: PixiMapProps) => {
    applyDefaultProps(instance, oldProps, newProps);
    const mapChanged =
      oldProps.revision !== newProps.revision ||
      oldProps.showGrid !== newProps.showGrid ||
      oldProps.showBlocked !== newProps.showBlocked;
    if (mapChanged) {
      const next = renderMap(newProps.map, newProps);
      instance.removeChildren();
      for (const child of [...next.children]) {
        instance.addChild(child);
      }
      next.destroy({ children: false });
    }
  },
});

function renderMap(map: WorldMap, props: PixiMapProps): PIXI.Container {
  const container = new PIXI.Container();
  const tileDim = map.tileDim;
  const columns = Math.floor(map.tileSetDimX / tileDim);
  const rows = Math.floor(map.tileSetDimY / tileDim);

  let texture: PIXI.BaseTexture | null = null;
  const url = resolveAssetUrl(map.tileSetUrl);
  if (url) {
    try {
      texture = PIXI.BaseTexture.from(url, { scaleMode: PIXI.SCALE_MODES.NEAREST });
    } catch (e) {
      console.warn('Failed to load tileset', url, e);
    }
  }

  const tiles: PIXI.Texture[] = [];
  if (texture) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        tiles[x + y * columns] = new PIXI.Texture(
          texture,
          new PIXI.Rectangle(x * tileDim, y * tileDim, tileDim, tileDim),
        );
      }
    }
  }

  const fallback = texture
    ? new PIXI.Texture(texture, new PIXI.Rectangle(0, 0, tileDim, tileDim))
    : undefined;

  const allLayers = [...map.bgTiles, ...map.objectTiles];
  for (let x = 0; x < map.width; x++) {
    for (let y = 0; y < map.height; y++) {
      for (const layer of allLayers) {
        const tileIndex = layer[x]?.[y] ?? -1;
        if (tileIndex === -1) continue;
        const texture_ = tiles[tileIndex] ?? fallback;
        if (!texture_) continue;
        const sprite = new PIXI.Sprite(texture_);
        sprite.x = x * tileDim;
        sprite.y = y * tileDim;
        container.addChild(sprite);
      }
      if (props.showBlocked && map.isSolid(x, y)) {
        const overlay = new PIXI.Graphics();
        overlay.beginFill(0xff2b2b, 0.28);
        overlay.drawRect(x * tileDim, y * tileDim, tileDim, tileDim);
        overlay.endFill();
        container.addChild(overlay);
      }
    }
  }

  if (props.showGrid) {
    const grid = new PIXI.Graphics();
    grid.lineStyle(1, 0xffffff, 0.18);
    for (let x = 0; x <= map.width; x++) {
      grid.moveTo(x * tileDim, 0);
      grid.lineTo(x * tileDim, map.height * tileDim);
    }
    for (let y = 0; y <= map.height; y++) {
      grid.moveTo(0, y * tileDim);
      grid.lineTo(map.width * tileDim, y * tileDim);
    }
    container.addChild(grid);
  }

  // Animated sprites (waterfalls, windmills, campfires...).
  const bySheet = new Map<string, typeof map.animatedSprites>();
  for (const sprite of map.animatedSprites) {
    if (!bySheet.has(sprite.sheet)) bySheet.set(sprite.sheet, []);
    bySheet.get(sprite.sheet)!.push(sprite);
  }
  for (const [sheet, sprites] of bySheet.entries()) {
    const animation = animations[sheet];
    if (!animation) {
      console.warn(`Unknown animation sheet: ${sheet}`);
      continue;
    }
    const base = PIXI.BaseTexture.from(resolveAssetUrl(animation.url), {
      scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    const spriteSheet = new PIXI.Spritesheet(base, animation.spritesheet );
    void spriteSheet.parse().then(() => {
      for (const sprite of sprites) {
        const frames = spriteSheet.animations[sprite.animation];
        if (!frames) continue;
        const animated = new PIXI.AnimatedSprite(frames);
        animated.animationSpeed = 0.1;
        animated.autoUpdate = true;
        animated.x = sprite.x;
        animated.y = sprite.y;
        animated.width = sprite.w;
        animated.height = sprite.h;
        container.addChild(animated);
        animated.play();
      }
    });
  }

  container.hitArea = new PIXI.Rectangle(0, 0, map.width * tileDim, map.height * tileDim);
  container.interactive = true;
  return container;
}
