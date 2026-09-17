import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDbRevision, useRuntime, useTown } from '../state.tsx';
import { localDB } from '../db/local.ts';
import type { MapDoc } from '../db/schema.ts';
import {
  emptyLayer,
  normalizeMap,
  type AnimatedSprite,
  type SerializedWorldMap,
} from '../engine/worldMap.ts';
import { BUILTIN_TILESETS, ANIMATION_SHEETS } from '../data/maps.ts';
import { imageSize, listUploadedImages, resolveAssetUrl, saveUploadedImage } from '../assets.ts';
import { downloadText } from '../db/transfer.ts';

type Tool = 'paint' | 'erase' | 'fill' | 'pick' | 'pan' | 'sprite' | 'spriteErase';
type LayerTarget = { kind: 'bg' | 'object'; index: number };

const LAYERS: { label: string; target: LayerTarget }[] = [
  { label: 'Ground', target: { kind: 'bg', index: 0 } },
  { label: 'Overlay', target: { kind: 'bg', index: 1 } },
  { label: 'Objects (blocks)', target: { kind: 'object', index: 0 } },
  { label: 'Objects 2', target: { kind: 'object', index: 1 } },
];

/**
 * Map editor: paint the tilemap that the engine pathfinds on, straight in the
 * app. Saving writes the `maps` table and hot-swaps the running world's map.
 */
export default function MapEditor() {
  const runtime = useRuntime();
  useDbRevision();
  const { game } = useTown();

  const [draft, setDraft] = useState<SerializedWorldMap>(() => game.worldMap.serialize());
  const [history, setHistory] = useState<SerializedWorldMap[]>([]);
  const [future, setFuture] = useState<SerializedWorldMap[]>([]);
  const [tool, setTool] = useState<Tool>('paint');
  const [layer, setLayer] = useState<LayerTarget>(LAYERS[0].target);
  const [tile, setTile] = useState(271);
  const [brush, setBrush] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [showBlocked, setShowBlocked] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [sheet, setSheet] = useState(ANIMATION_SHEETS[0].sheet);
  const [dirty, setDirty] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tilesetRef = useRef<HTMLImageElement | null>(null);
  const [tilesetReady, setTilesetReady] = useState(0);
  const pointer = useRef<{ drawing: boolean; last: { x: number; y: number } | null }>({
    drawing: false,
    last: null,
  });

  // Re-sync when the world's map object is replaced (import, activate, reset).
  useEffect(() => {
    setDraft(game.worldMap.serialize());
    setDirty(false);
  }, [game]);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      tilesetRef.current = image;
      setTilesetReady((n) => n + 1);
    };
    image.onerror = () => {
      tilesetRef.current = null;
      setTilesetReady((n) => n + 1);
    };
    image.src = resolveAssetUrl(draft.tileSetUrl);
  }, [draft.tileSetUrl, tilesetReady === -1]);

  const commit = useCallback((next: SerializedWorldMap) => {
    setHistory((h) => [...h.slice(-24), draft]);
    setFuture([]);
    setDraft(next);
    setDirty(true);
  }, [draft]);

  const paintAt = useCallback(
    (tileX: number, tileY: number, mode: Tool) => {
      // Copy the tile columns, not just the layer array: the undo stack keeps the
      // previous draft around, and sharing columns would let a paint rewrite it.
      const copyLayers = (layers: number[][][]) => layers.map((layer) => layer.map((c) => c.slice()));
      const next: SerializedWorldMap = {
        ...draft,
        bgTiles: copyLayers(draft.bgTiles),
        objectTiles: copyLayers(draft.objectTiles),
      };
      const readLayer = (target: LayerTarget) => {
        const list = target.kind === 'bg' ? next.bgTiles : next.objectTiles;
        while (list.length <= target.index) list.push(emptyLayer(next.width, next.height));
        return list[target.index];
      };
      const writeTile = (target: LayerTarget, x: number, y: number, value: number) => {
        if (x < 0 || y < 0 || x >= next.width || y >= next.height) return;
        const layer = readLayer(target);
        if (!layer[x]) layer[x] = new Array(next.height).fill(-1);
        layer[x][y] = value;
      };

      if (mode === 'pick') {
        const value = readLayer(layer)[tileX]?.[tileY] ?? -1;
        if (value >= 0) setTile(value);
        return;
      }
      if (mode === 'sprite') {
        const found = next.animatedSprites.findIndex(
          (s) => Math.floor(s.x / next.tileDim) === tileX && Math.floor(s.y / next.tileDim) === tileY,
        );
        const entry: AnimatedSprite = {
          x: tileX * next.tileDim,
          y: tileY * next.tileDim,
          w: next.tileDim * 2,
          h: next.tileDim * 2,
          layer: 1,
          sheet,
          animation: 'pixels_large',
        };
        const animatedSprites =
          found >= 0
            ? next.animatedSprites.map((s, i) => (i === found ? entry : s))
            : [...next.animatedSprites, entry];
        commit({ ...next, animatedSprites });
        return;
      }
      if (mode === 'spriteErase') {
        const animatedSprites = next.animatedSprites.filter(
          (s) => !(Math.floor(s.x / next.tileDim) === tileX && Math.floor(s.y / next.tileDim) === tileY),
        );
        if (animatedSprites.length !== next.animatedSprites.length) commit({ ...next, animatedSprites });
        return;
      }

      const radius = Math.max(0, Math.floor((brush - 1) / 2));
      const value = mode === 'erase' ? -1 : tile;

      if (mode === 'fill') {
        const target = readLayer(layer);
        const from = target[tileX]?.[tileY] ?? -1;
        if (from === value) return;
        const stack: [number, number][] = [[tileX, tileY]];
        let guard = 0;
        while (stack.length && guard++ < 40_000) {
          const [x, y] = stack.pop()!;
          if (x < 0 || y < 0 || x >= next.width || y >= next.height) continue;
          if (!target[x]) target[x] = new Array(next.height).fill(-1);
          if (target[x][y] !== from) continue;
          target[x][y] = value;
          stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        commit(next);
        return;
      }

      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          writeTile(layer, tileX + dx, tileY + dy, value);
        }
      }
      commit(next);
    },
    [brush, commit, draft, layer, sheet, tile],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, tileDim } = draft;
    const viewW = Math.ceil(width * tileDim * zoom);
    const viewH = Math.ceil(height * tileDim * zoom);
    if (canvas.width !== viewW || canvas.height !== viewH) {
      canvas.width = viewW;
      canvas.height = viewH;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#3f2832';
    ctx.fillRect(0, 0, viewW, viewH);
    const tileset = tilesetRef.current;
    const columns = Math.max(1, Math.floor(draft.tileSetDimX / tileDim));

    const blit = (index: number, x: number, y: number) => {
      if (index < 0) return;
      const sx = (index % columns) * tileDim;
      const sy = Math.floor(index / columns) * tileDim;
      if (tileset && sx + tileDim <= tileset.width && sy + tileDim <= tileset.height) {
        ctx.drawImage(tileset, sx, sy, tileDim, tileDim, x, y, tileDim, tileDim);
      } else {
        ctx.fillStyle = `hsl(${(index * 47) % 360} 45% 45%)`;
        ctx.fillRect(x, y, tileDim, tileDim);
        ctx.fillStyle = 'rgba(0,0,0,.55)';
        ctx.font = '10px monospace';
        ctx.fillText(String(index), x + 2, y + 12);
      }
    };

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        for (const layer of draft.bgTiles) blit(layer[x]?.[y] ?? -1, x * tileDim, y * tileDim);
        for (const layer of draft.objectTiles) blit(layer[x]?.[y] ?? -1, x * tileDim, y * tileDim);
        if (showBlocked) {
          const solid = draft.objectTiles.some((l) => (l[x]?.[y] ?? -1) !== -1);
          if (solid) {
            ctx.fillStyle = 'rgba(255,60,60,.25)';
            ctx.fillRect(x * tileDim, y * tileDim, tileDim, tileDim);
          }
        }
      }
    }

    if (showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x++) {
        ctx.moveTo(x * tileDim + 0.5, 0);
        ctx.lineTo(x * tileDim + 0.5, height * tileDim);
      }
      for (let y = 0; y <= height; y++) {
        ctx.moveTo(0, y * tileDim + 0.5);
        ctx.lineTo(width * tileDim, y * tileDim + 0.5);
      }
      ctx.stroke();
    }

    for (const sprite of draft.animatedSprites) {
      ctx.strokeStyle = 'rgba(120,220,255,.85)';
      ctx.strokeRect(sprite.x + 1, sprite.y + 1, sprite.w - 2, sprite.h - 2);
    }
  }, [draft, showBlocked, showGrid, zoom, tilesetReady]);

  useEffect(() => {
    draw();
  }, [draw]);

  const eventToTile = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / (draft.tileDim * zoom));
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / (draft.tileDim * zoom));
    return { x, y };
  };

  const saveToDb = async () => {
    await runtime.saveMap(normalizeMap(draft), { applyToWorld: true });
    setDirty(false);
  };

  const undo = () => {
    if (!history.length) return;
    const previous = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [draft, ...f].slice(0, 25));
    setDraft(previous);
    setDirty(true);
  };

  const resize = (width: number, height: number) => {
    const next = { ...draft, width, height };
    const remap = (layers: number[][][]) =>
      layers.map((layer) => {
        const out = emptyLayer(width, height);
        for (let x = 0; x < Math.min(width, layer.length); x++) {
          for (let y = 0; y < Math.min(height, (layer[x] ?? []).length); y++) {
            out[x][y] = layer[x][y];
          }
        }
        return out;
      });
    commit({ ...next, bgTiles: remap(draft.bgTiles), objectTiles: remap(draft.objectTiles) });
  };

  const solidCount = useMemo(() => {
    let count = 0;
    for (let x = 0; x < draft.width; x++) {
      for (let y = 0; y < draft.height; y++) {
        if (draft.objectTiles.some((l) => (l[x]?.[y] ?? -1) !== -1)) count++;
      }
    }
    return count;
  }, [draft]);

  const maps = localDB.all<MapDoc>('maps');

  return (
    <div className="grid h-full gap-3 overflow-hidden p-3 lg:grid-cols-[250px_1fr_260px]">
      <aside className="flex flex-col gap-3 overflow-y-auto text-sm">
        <Section title="Save">
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => void saveToDb()} disabled={!dirty}>
              {dirty ? '💾 Apply to world' : '✓ saved'}
            </button>
            <button className="btn" onClick={undo} disabled={!history.length}>
              ↶ undo
            </button>
            <button
              className="btn"
              onClick={() => {
                if (!future.length) return;
                const next = future[0];
                setFuture((f) => f.slice(1));
                setDraft(next);
                setDirty(true);
              }}
              disabled={!future.length}
            >
              ↷ redo
            </button>
          </div>
          <p className="text-[11px] opacity-70">
            “Apply” writes the <code>maps</code> table and the live engine picks it up immediately —
            nobody is teleported into a wall (unwalkable actors get moved).
          </p>
        </Section>

        <Section title="Tools">
          <div className="grid grid-cols-3 gap-1">
            {(['paint', 'erase', 'fill', 'pick', 'sprite', 'spriteErase'] as Tool[]).map((t) => (
              <button
                key={t}
                onClick={() => setTool(t)}
                className={`rounded px-1 py-1 text-[11px] ${
                  tool === t ? 'bg-clay-500' : 'bg-brown-900/60 hover:bg-brown-900'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <label className="mt-2 block text-[11px]">
            Layer
            <select
              className="input mt-1"
              value={LAYERS.findIndex((l) => l.target.kind === layer.kind && l.target.index === layer.index)}
              onChange={(e) => setLayer(LAYERS[Number(e.target.value)].target)}
            >
              {LAYERS.map((l, i) => (
                <option key={l.label} value={i}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-2 block text-[11px]">
            Brush {brush}×{brush}
            <input
              type="range"
              min={1}
              max={5}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              className="w-full"
            />
          </label>
          {tool === 'sprite' && (
            <label className="mt-2 block text-[11px]">
              Animation sheet
              <select className="input mt-1" value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {ANIMATION_SHEETS.map((a) => (
                  <option key={a.sheet} value={a.sheet}>
                    {a.sheet}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="mt-2 flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
            grid
          </label>
          <label className="mt-1 flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={showBlocked}
              onChange={(e) => setShowBlocked(e.target.checked)}
            />
            highlight blocked
          </label>
          <label className="mt-1 block text-[11px]">
            Zoom {zoom.toFixed(2)}×
            <input
              type="range"
              min={0.25}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-full"
            />
          </label>
        </Section>

        <Section title="Geometry">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px]">
              Width
              <input
                className="input mt-1"
                type="number"
                min={8}
                max={256}
                value={draft.width}
                onChange={(e) => resize(Number(e.target.value), draft.height)}
              />
            </label>
            <label className="text-[11px]">
              Height
              <input
                className="input mt-1"
                type="number"
                min={8}
                max={256}
                value={draft.height}
                onChange={(e) => resize(draft.width, Number(e.target.value))}
              />
            </label>
            <label className="text-[11px]">
              Tile px
              <input
                className="input mt-1"
                type="number"
                min={8}
                max={128}
                value={draft.tileDim}
                onChange={(e) =>
                  setDraft({ ...draft, tileDim: Number(e.target.value) })
                }
              />
            </label>
            <label className="text-[11px]">
              Tileset cols
              <input
                className="input mt-1"
                type="number"
                min={1}
                value={Math.floor(draft.tileSetDimX / draft.tileDim)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tileSetDimX: Number(e.target.value) * draft.tileDim,
                  })
                }
              />
            </label>
          </div>
          <p className="mt-1 text-[11px] opacity-70">
            {draft.width * draft.height} tiles · {solidCount} blocked (
            {Math.round((solidCount / (draft.width * draft.height)) * 100)}%) ·{' '}
            {draft.animatedSprites.length} animated
          </p>
        </Section>

        <Section title="Tileset">
          <select
            className="input"
            value={BUILTIN_TILESETS.findIndex((t) => t.url === draft.tileSetUrl) }
            onChange={(e) => {
              const preset = BUILTIN_TILESETS[Number(e.target.value)];
              if (!preset) return;
              setDraft({
                ...draft,
                tileSetUrl: preset.url,
                tileDim: preset.tileDim,
                tileSetDimX: preset.tileSetDimX,
                tileSetDimY: preset.tileSetDimY,
              });
              setDirty(true);
            }}
          >
            <option value={-1}>custom / uploaded</option>
            {BUILTIN_TILESETS.map((t, i) => (
              <option key={t.url} value={i}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="btn mt-2 block cursor-pointer text-center">
            ⬆ upload tileset png
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const ref = await saveUploadedImage(file, file.name);
                const size = await imageSize(ref);
                const columns = Math.max(1, Math.floor(size.width / draft.tileDim));
                const rows = Math.max(1, Math.floor(size.height / draft.tileDim));
                setDraft({
                  ...draft,
                  tileSetUrl: ref,
                  tileSetDimX: columns * draft.tileDim,
                  tileSetDimY: rows * draft.tileDim,
                });
                setDirty(true);
              }}
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1">
            {listUploadedImages().map((image) => (
              <button
                key={image._id}
                title={image.name}
                className="h-8 w-8 overflow-hidden rounded border border-white/20"
                onClick={() => {
                  setDraft({
                    ...draft,
                    tileSetUrl: `image:${image._id}`,
                    tileSetDimX: image.width,
                    tileSetDimY: image.height,
                  });
                  setDirty(true);
                }}
              >
                <img src={image.dataUrl} alt={image.name} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
          <label className="mt-2 block text-[11px]">
            tileset url
            <input
              className="input mt-1"
              value={draft.tileSetUrl}
              onChange={(e) => {
                setDraft({ ...draft, tileSetUrl: e.target.value });
                setDirty(true);
              }}
            />
          </label>
        </Section>

        <Section title="Map files">
          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={() =>
                downloadText(JSON.stringify(draft, null, 2), 'aifavella-map.json', 'application/json')
              }
            >
              ⬇ export json
            </button>
            <button className="btn" onClick={() => void runtime.saveMapAsNew(`${draft.width}×${draft.height}`, draft)}>
              💾 save as new
            </button>
            <label className="btn cursor-pointer">
              ⬆ import
              <input
                type="file"
                accept="application/json,.js"
                className="hidden"
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  const parsed = parseMapFile(text);
                  if (!parsed) {
                    alert('Could not parse that file as an AI Town map (JSON or data/*.js).');
                    return;
                  }
                  commit(normalizeMap(parsed));
                }}
              />
            </label>
          </div>
          <select
            className="input mt-2"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) void runtime.activateMap(id);
            }}
          >
            <option value="">load a saved map…</option>
            {maps.map((map) => (
              <option key={map._id} value={map._id}>
                {map.name} {map.isDefault ? '(active)' : ''}
              </option>
            ))}
          </select>
        </Section>
      </aside>

      <div className="min-h-0 overflow-auto rounded bg-black/40 p-2">
        <canvas
          ref={canvasRef}
          className="mx-auto block touch-none select-none"
          style={{ imageRendering: 'pixelated', cursor: tool === 'pan' ? 'grab' : 'crosshair' }}
          onPointerDown={(e) => {
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            pointer.current.drawing = true;
            const { x, y } = eventToTile(e);
            paintAt(x, y, tool);
          }}
          onPointerMove={(e) => {
            if (!pointer.current.drawing) return;
            if (tool !== 'paint' && tool !== 'erase' && tool !== 'pick') return;
            const { x, y } = eventToTile(e);
            const last = pointer.current.last;
            if (last && last.x === x && last.y === y) return;
            pointer.current.last = { x, y };
            paintAt(x, y, tool);
          }}
          onPointerUp={() => {
            pointer.current.drawing = false;
            pointer.current.last = null;
          }}
          onPointerLeave={() => {
            pointer.current.drawing = false;
          }}
        />
      </div>

      <TilePicker
        url={draft.tileSetUrl}
        tileDim={draft.tileDim}
        columns={Math.max(1, Math.floor(draft.tileSetDimX / draft.tileDim))}
        rows={Math.max(1, Math.floor(draft.tileSetDimY / draft.tileDim))}
        selected={tile}
        onSelect={setTile}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-brown-700 bg-brown-900/40 p-2">
      <h3 className="mb-1 font-display text-sm tracking-wide text-brown-200">{title}</h3>
      {children}
    </section>
  );
}

function TilePicker({
  url,
  tileDim,
  columns,
  rows,
  selected,
  onSelect,
}: {
  url: string;
  tileDim: number;
  columns: number;
  rows: number;
  selected: number;
  onSelect: (tile: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);
  const width = columns * tileDim;
  const height = rows * tileDim;

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = resolveAssetUrl(url);
  }, [url]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#181425';
    ctx.fillRect(0, 0, w, h);
    if (image) ctx.drawImage(image, 0, 0, width, height, 0, 0, w, h);
    const selX = (selected % columns) * tileDim * scale;
    const selY = Math.floor(selected / columns) * tileDim * scale;
    ctx.strokeStyle = '#ffe27a';
    ctx.lineWidth = 2;
    ctx.strokeRect(selX, selY, tileDim * scale, tileDim * scale);
  }, [image, scale, selected, tileDim, columns, width, height]);

  return (
    <aside className="flex min-h-0 flex-col gap-2 rounded border border-brown-700 bg-brown-900/40 p-2 text-sm">
      <h3 className="font-display text-sm text-brown-200">
        Tileset · #{selected}
        <span className="ml-2 font-body text-[11px] opacity-70">
          {columns}×{rows}
        </span>
      </h3>
      <div className="flex items-center gap-2 text-[11px]">
        <button className="btn" onClick={() => setScale((s) => Math.max(0.25, s / 1.5))}>
          −
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button className="btn" onClick={() => setScale((s) => Math.min(4, s * 1.5))}>
          +
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <canvas
          ref={ref}
          className="block cursor-crosshair"
          style={{ imageRendering: 'pixelated' }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / (tileDim * scale));
            const y = Math.floor((e.clientY - rect.top) / (tileDim * scale));
            onSelect(y * columns + x);
          }}
        />
      </div>
    </aside>
  );
}

/** Accepts our JSON export, or a legacy `data/*.js` map module. */
export function parseMapFile(text: string): any {
  try {
    const json = JSON.parse(text);
    if (json?.map) return json.map;
    return json;
  } catch {
    /* try the legacy module format below */
  }
  try {
    const out: any = {};
    const numbers = (name: string) => {
      const match = text.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`, 'm'));
      if (!match) return undefined;
      return JSON.parse(match[1].replace(/,\s*([\]}])/g, '$1'));
    };
    for (const key of ['bgtiles', 'objmap', 'animatedsprites']) {
      const value = numbers(key);
      if (value) out[key === 'objmap' ? 'objectTiles' : key === 'bgtiles' ? 'bgTiles' : 'animatedSprites'] = value;
    }
    for (const key of ['tiledim', 'tilesetpxw', 'tilesetpxh', 'mapwidth', 'mapheight']) {
      const match = text.match(new RegExp(`export const ${key}\\s*=\\s*(\\d+)`));
      if (match) {
        const mapped =
          key === 'tiledim'
            ? 'tileDim'
            : key === 'tilesetpxw'
              ? 'tileSetDimX'
              : key === 'tilesetpxh'
                ? 'tileSetDimY'
                : key;
        out[mapped] = Number(match[1]);
      }
    }
    if (out.bgTiles?.length) {
      out.width ??= out.bgTiles[0].length;
      out.height ??= out.bgTiles[0][0].length;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}
