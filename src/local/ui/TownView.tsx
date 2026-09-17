import { useCallback, useMemo, useRef, useState } from 'react';
import { Stage, useApp } from '@pixi/react';
import { useElementSize } from 'usehooks-ts';
import * as PIXI from 'pixi.js';
import { Graphics } from '@pixi/react';
import { Graphics as PixiGraphics } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import { PixiMap } from './PixiMap.tsx';
import PixiViewport from './PixiViewport.tsx';
import { Character, Nameplate } from './Character.tsx';
import { useTown } from '../state.tsx';
import { findCharacter } from '../data/characters.ts';
import { orientationDegrees } from '../engine/geometry.ts';
import type { GameId } from '../engine/ids.ts';
import type { Player } from '../engine/player.ts';
import type { Point } from '../engine/types.ts';
import { PlayerPanel } from './PlayerPanel.tsx';

/**
 * The world view: tilemap, agents, click-to-move, and the side panel.
 *
 * Unlike the hosted client there is no history buffer to replay — the engine
 * ticks in this same process, so the sprites are drawn from live state.
 */
export default function TownView({
  selectedPlayerId,
  onSelectPlayer,
}: {
  selectedPlayerId?: GameId<'players'>;
  onSelectPlayer: (id?: GameId<'players'>) => void;
}) {
  const { runtime, game, world, worldMap, status } = useTown();
  const [wrapperRef, { width, height }] = useElementSize();
  const viewportRef = useRef<Viewport | undefined>();
  const dragStart = useRef<{ screenX: number; screenY: number } | null>(null);
  const [lastDestination, setLastDestination] = useState<{ x: number; y: number; t: number } | null>(null);
  const [showNames, setShowNames] = useState(true);
  const [showBlocked, setShowBlocked] = useState(false);
  const [mapRevision, setMapRevision] = useState(0);
  const previousMapRef = useRef(worldMap);
  if (previousMapRef.current !== worldMap) {
    previousMapRef.current = worldMap;
    setMapRevision((r) => r + 1);
  }

  const humanPlayerId = runtime.humanPlayerId;

  const players = useMemo(() => [...world.players.values()], [world.players.size, game.revision]);

  const onMapPointerDown = useCallback((e: any) => {
    dragStart.current = { screenX: e.screenX, screenY: e.screenY };
  }, []);

  const onMapPointerUp = useCallback(
    async (e: any) => {
      if (dragStart.current) {
        const { screenX, screenY } = dragStart.current;
        dragStart.current = null;
        const dist = Math.hypot(screenX - e.screenX, screenY - e.screenY);
        if (dist > 10) return;
      }
      if (!humanPlayerId || !viewportRef.current) return;
      const point = viewportRef.current.toWorld(e.screenX, e.screenY);
      const destination: Point = {
        x: Math.floor(point.x / worldMap.tileDim),
        y: Math.floor(point.y / worldMap.tileDim),
      };
      setLastDestination({ t: Date.now(), ...destination });
      try {
        await runtime.sendInput('moveTo', { playerId: humanPlayerId, destination });
      } catch (e: any) {
        console.warn(e?.message);
      }
    },
    [humanPlayerId, runtime, worldMap.tileDim],
  );

  const centerOnHuman = useCallback(() => {
    if (!viewportRef.current || !humanPlayerId) return;
    const player = world.players.get(humanPlayerId);
    if (!player) return;
    viewportRef.current.animate({
      position: new PIXI.Point(player.position.x * worldMap.tileDim, player.position.y * worldMap.tileDim),
      scale: 1.6,
      time: 300,
    });
  }, [humanPlayerId, world, worldMap.tileDim]);

  return (
    <div className="grid h-full w-full grid-rows-[1fr_auto] lg:grid-cols-[1fr_360px] lg:grid-rows-1">
      <div
        ref={wrapperRef}
        className="relative min-h-[320px] overflow-hidden bg-brown-900"
      >
        {width > 0 && height > 0 && (
          <Stage width={width} height={height} options={{ backgroundColor: 0x7ab5ff, antialias: false }}>
            <ViewportHost
              screenWidth={width}
              screenHeight={height}
              worldWidth={worldMap.width * worldMap.tileDim}
              worldHeight={worldMap.height * worldMap.tileDim}
              viewportRef={viewportRef}
            >
              <PixiMap
                map={worldMap}
                revision={mapRevision}
                showBlocked={showBlocked}
                onpointerup={onMapPointerUp}
                onpointerdown={onMapPointerDown}
              />
              {players.map((player) => (
                <PlayerSprite
                  key={player.id}
                  player={player}
                  game={game}
                  isViewer={player.id === humanPlayerId}
                  showName={showNames}
                  onSelect={onSelectPlayer}
                  tileDim={worldMap.tileDim}
                />
              ))}
              {lastDestination && (
                <DestinationRing destination={lastDestination} tileDim={worldMap.tileDim} />
              )}
            </ViewportHost>
          </Stage>
        )}

        <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap gap-2 text-sm">
          <ToolButton onClick={() => runtime.toggle()}>
            {status.status === 'running' ? '⏸ Pause' : '▶ Play'}
          </ToolButton>
          <ToolButton onClick={() => void runtime.fastForward(90)}>⏩ Fast-forward</ToolButton>
          <ToolButton
            onClick={() => {
              if (humanPlayerId) void runtime.leaveHuman();
              else
                void runtime.joinHuman().then(() => setTimeout(centerOnHuman, 250));
            }}
          >
            {humanPlayerId ? '🚪 Leave town' : '🧍 Join town'}
          </ToolButton>
          <ToolButton onClick={() => setShowNames((v) => !v)}>{showNames ? '🙈 Names' : '👀 Names'}</ToolButton>
          <ToolButton onClick={() => setShowBlocked((v) => !v)}>{showBlocked ? '🚧 Collision' : '⬜ Collision'}</ToolButton>
          {humanPlayerId && <ToolButton onClick={centerOnHuman}>🎯 Center</ToolButton>}
        </div>

        <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-black/50 px-2 py-1 text-[11px] font-system text-white/80">
          {world.players.size} players · {world.conversations.size} talking ·{' '}
          {runtime.status().activeOps > 0 ? `model busy (${runtime.status().queuedOps} queued)` : 'idle'}
        </div>
      </div>

      <div className="flex min-h-0 flex-col overflow-y-auto border-t-4 border-brown-900 bg-brown-800 px-3 py-3 text-brown-100 lg:border-l-4 lg:border-t-0">
        <PlayerPanel playerId={selectedPlayerId} onSelectPlayer={onSelectPlayer} />
      </div>
    </div>
  );
}

function PlayerSprite({
  player,
  game,
  isViewer,
  showName,
  onSelect,
  tileDim,
}: {
  player: Player;
  game: import('../engine/game.ts').Game;
  isViewer: boolean;
  showName: boolean;
  onSelect: (id?: GameId<'players'>) => void;
  tileDim: number;
}) {
  const description = game.playerDescriptions.get(player.id);
  const character = description ? findCharacter(description.character) : undefined;
  if (!character || !description) return null;

  const conversation = game.world.playerConversation(player);
  const isSpeaking = !!conversation?.isTyping?.playerId && conversation.isTyping.playerId === player.id;
  const agent = game.world.agentForPlayer(player.id);
  const isThinking = !isSpeaking && !!agent?.inProgressOperation;
  const now = game.currentTime || Date.now();
  const x = player.position.x * tileDim + tileDim / 2;
  const y = player.position.y * tileDim + tileDim / 2;

  return (
    <>
      <Character
        x={x}
        y={y}
        orientation={orientationDegrees(player.facing)}
        isMoving={player.speed > 0}
        isThinking={isThinking}
        isSpeaking={isSpeaking}
        emoji={player.activity && player.activity.until > now ? player.activity.emoji : undefined}
        isViewer={isViewer}
        textureUrl={character.textureUrl}
        spritesheetData={character.spritesheetData as any}
        speed={character.speed}
        onClick={() => onSelect(player.id)}
      />
      {showName && (
        <Nameplate x={x} y={y - 26} text={description.name} highlight={isViewer} />
      )}
      {conversation && <BubblePair conversation={conversation} game={game} tileDim={tileDim} />}
    </>
  );
}

/** Small "…" bubble over a conversation so you can spot who's talking. */
function BubblePair({
  conversation,
  game,
  tileDim,
}: {
  conversation: import('../engine/conversation.ts').Conversation;
  game: import('../engine/game.ts').Game;
  tileDim: number;
}) {
  const participants = [...conversation.participants.keys()]
    .map((id) => game.world.players.get(id))
    .filter(Boolean) as Player[];
  const active = participants.every(
    (p) => conversation.participants.get(p.id)?.status.kind === 'participating',
  );
  if (!active) return null;
  return (
    <>
      {participants.map((player) => (
        <Nameplate
          key={`${player.id}-talk`}
          x={player.position.x * tileDim + tileDim / 2 + 16}
          y={player.position.y * tileDim - 8}
          text={game.world.conversations.get(conversation.id)?.isTyping ? '💬' : '💭'}
        />
      ))}
    </>
  );
}

function DestinationRing({
  destination,
  tileDim,
}: {
  destination: { x: number; y: number; t: number };
  tileDim: number;
}) {
  return (
    <PixiRing destination={destination} tileDim={tileDim} />
  );
}

const PixiRing = ({ destination, tileDim }: { destination: { x: number; y: number; t: number }; tileDim: number }) => (
  <Graphics
    draw={(g: PixiGraphics) => {
      g.clear();
      const now = Date.now();
      if (destination.t + 600 <= now) return;
      const progress = (now - destination.t) / 600;
      g.lineStyle(1.5, 0xffffff, 0.7);
      g.drawCircle(destination.x * tileDim, destination.y * tileDim, 0.35 * tileDim * (1 - progress));
    }}
  />
);

/** Must be rendered inside <Stage> so it can pick up the shared Application. */
function ViewportHost({
  app,
  ...props
}: Omit<React.ComponentProps<typeof PixiViewport>, 'app'> & { app?: import('pixi.js').Application }) {
  const app2 = useApp();
  return <PixiViewport app={app ?? app2} {...props} />;
}

function ToolButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="pointer-events-auto rounded border border-white/20 bg-black/60 px-2 py-1 font-system text-xs text-white hover:bg-black/80"
    >
      {children}
    </button>
  );
}
