import { World, SerializedWorld } from './world';
import { WorldMap, SerializedWorldMap, normalizeMap } from './worldMap';
import { PlayerDescription, AgentDescription } from './descriptions';
import { GameId, IdTypes, allocGameId } from './ids';
import { createInputHandlers, InputNames } from './inputs';
import type { AgentOperations } from './agent';
import { C } from '../constants';
import { playerLocation, type Location } from './location';


const handlers = createInputHandlers();

export type QueuedInput = {
  id: number;
  name: string;
  args: any;
  received: number;
  resolve?: (value: any) => void;
  reject?: (error: any) => void;
};

export type ArchivedConversation = {
  id: string;
  creator: string;
  created: number;
  ended: number;
  numMessages: number;
  participants: string[];
  worldId: string;
};

export type GameSnapshot = {
  world: SerializedWorld;
  worldMap: SerializedWorldMap;
  playerDescriptions: PlayerDescription[];
  agentDescriptions: AgentDescription[];
  castIds: [string, string][];
};

/**
 * The local game engine: same shape as `convex/aiTown/game.ts`, but instead of
 * loading/saving through Convex transactions it owns plain objects that
 * `SimRuntime` persists to IndexedDB.
 */
export class Game {
  world: World;
  worldMap: WorldMap;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;
  agentDescriptions: Map<GameId<'agents'>, AgentDescription>;
  /** playerId -> cast-list id, so the editor can map world actors to defs. */
  castIds: Map<GameId<'players'>, string>;

  numPathfinds = 0;
  descriptionsModified = false;
  mapModified = false;

  inputQueue: QueuedInput[] = [];
  pendingOperations: { name: keyof AgentOperations; args: any }[] = [];
  completedInputs: { inputId: number; ok: boolean; value?: any; error?: string }[] = [];

  /** Monotonic revision, bumped whenever anything observable changed. */
  revision = 0;
  /** Latest simulated time (ms since epoch). Tracks the wall clock while the
   * tab is visible, so every cooldown in the engine is expressed in this clock —
   * never mix it with Date.now() inside an input handler. */
  currentTime = Date.now();

  /** Set by the runtime. */
  onNotify: (() => void) | null = null;
  /** Async work the engine wants run outside the tick (LLM calls). */
  onOperation: ((name: string, args: any) => void) | null = null;

  // Hooks the runtime wires up.
  onArchivedConversation: ((conversation: ArchivedConversation) => void) | null = null;
  constructor(initial?: Partial<GameSnapshot> & { worldMap?: SerializedWorldMap }) {
    this.world = new World(initial?.world);
    this.worldMap = new WorldMap(
      normalizeMap(initial?.worldMap ?? { width: 32, height: 24, tileDim: 32 }),
    );
    this.playerDescriptions = new Map(
      (initial?.playerDescriptions ?? []).map((d) => [d.playerId , d]),
    );
    this.agentDescriptions = new Map(
      (initial?.agentDescriptions ?? []).map((d) => [d.agentId , d]),
    );
    this.castIds = new Map((initial?.castIds ?? []) as [GameId<'players'>, string][]);
  }

  allocId<T extends IdTypes>(idType: T): GameId<T> {
    return this.world.allocId(idType);
  }

  scheduleOperation<Name extends keyof AgentOperations>(
    name: Name,
    args: AgentOperations[Name] & { operationId: string },
  ) {
    if (this.onOperation) {
      this.onOperation(name, args);
      return;
    }
    this.pendingOperations.push({ name, args } as any);
  }

  /** Ops queued while no runtime was attached. */
  flushOperations(): { name: keyof AgentOperations; args: any }[] {
    const out = this.pendingOperations;
    this.pendingOperations = [];
    return out;
  }

  markDescriptionsModified() {
    this.descriptionsModified = true;
  }

  setWorldMap(map: SerializedWorldMap) {
    this.worldMap = new WorldMap(map);
    this.mapModified = true;
  }

  playerConversation(playerId: GameId<'players'>) {
    const player = this.world.players.get(playerId);
    return player ? this.world.playerConversation(player) : undefined;
  }

  locationOf(playerId: GameId<'players'>): Location {
    const player = this.world.players.get(playerId);
    if (!player) {
      return { x: 0, y: 0, dx: 1, dy: 0, speed: 0 };
    }
    return playerLocation(player);
  }

  /** One frame of simulation. */
  tick(now: number) {
    this.currentTime = now;
    this.numPathfinds = 0;

    this.drainInputs(now);

    for (const player of this.world.players.values()) {
      player.tick(this, now);
    }
    for (const player of this.world.players.values()) {
      player.tickPathfinding(this, now);
    }
    for (const player of this.world.players.values()) {
      player.tickPosition(this, now);
    }
    for (const conversation of this.world.conversations.values()) {
      conversation.tick(this, now);
    }
    for (const agent of this.world.agents.values()) {
      try {
        agent.tick(this, now);
      } catch (e) {
        console.warn(`Agent ${agent.id} tick failed:`, e);
      }
    }

    this.completedInputs.length = 0;
  }

  drainInputs(now: number) {
    let processed = 0;
    while (this.inputQueue.length > 0 && processed < C.MAX_INPUTS_PER_STEP) {
      const input = this.inputQueue.shift()!;
      processed++;
      try {
        const value = this.handleInput(now, input.name, input.args);
        input.resolve?.(value);
        this.completedInputs.push({ inputId: input.id, ok: true, value });
      } catch (e: any) {
        input.reject?.(e);
        this.completedInputs.push({ inputId: input.id, ok: false, error: e?.message ?? `${e}` });
        console.warn(`Input ${input.name} failed: ${e?.message ?? e}`);
      }
      this.markDirty();
    }
  }

  handleInput(now: number, name: string, args: any) {
    const handler = (handlers as any)[name as InputNames];
    if (!handler) {
      throw new Error(`Invalid input: ${name}`);
    }
    return handler(this, now, args);
  }

  /** Queue an input; resolves when the engine has applied it. */
  insertInput<Name extends InputNames>(name: Name, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.inputQueue.push({
        id: Math.floor(Math.random() * 1e9),
        name,
        args,
        received: Date.now(),
        resolve,
        reject,
      });
      // Apply immediately when the loop is paused, so editors still feel live.
      if (!this.running) {
        this.drainInputs(this.currentTime);
      }
    });
  }

  running = true;

  pause() {
    this.running = false;
  }
  resume() {
    this.running = true;
  }

  markDirty() {
    this.revision++;
    this.onNotify?.();
  }

  archiveConversation(conversation: import('./conversation').Conversation) {
    this.onArchivedConversation?.({
      id: conversation.id,
      creator: conversation.creator,
      created: conversation.created,
      ended: Date.now(),
      numMessages: conversation.numMessages,
      participants: [...conversation.participants.keys()],
      worldId: 'world',
    });
  }

  snapshot(): GameSnapshot {
    return {
      world: this.world.serialize(),
      worldMap: this.worldMap.serialize(),
      playerDescriptions: [...this.playerDescriptions.values()],
      agentDescriptions: [...this.agentDescriptions.values()],
      castIds: [...this.castIds.entries()],
    };
  }

  static fromSnapshot(snapshot: GameSnapshot): Game {
    const game = new Game(snapshot);
    return game;
  }
}

export { allocGameId };
