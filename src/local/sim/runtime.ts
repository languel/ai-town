import { Game } from '../engine/game';
import { normalizeMap, type SerializedWorldMap } from '../engine/worldMap';
import type { CharacterDef } from '../engine/descriptions';
import type { GameId } from '../engine/ids';
import type { AgentOperations } from '../engine/agent';
import { localDB } from '../db/local';
import type {
  ArchivedConversation,
  CharacterDoc,
  LogDoc,
  MapDoc,
  WorldDoc,
} from '../db/schema';
import { getSettings, subscribeSettings } from '../db/settings';
import { overrideConstants } from '../constants';
import { DEFAULT_CAST } from '../data/defaultCast';
import { loadDefaultMap } from '../data/maps';
import {
  doSomething,
  generateConversationMessage,
  rememberConversation,
} from '../ai/operations';
import { sleep } from '../engine/object';

export type EngineState = {
  status: 'loading' | 'running' | 'paused' | 'error';
  error?: string;
  /** Wall-clock time the simulation has reached. */
  currentTime: number;
  /** How long this tab has been simulating. */
  uptimeMs: number;
  /** Ops currently awaiting the model. */
  activeOps: number;
  queuedOps: number;
  /** Requests per minute, smoothed. */
  llmCalls: number;
  lastLlmMs: number;
  lastLlmError?: string;
  isLeader: boolean;
};

/**
 * Owns the simulation: loads it from IndexedDB, drives the tick loop, persists a
 * snapshot on a timer, and runs agent "operations" (the LLM work) without ever
 * blocking a frame.
 */
const LOG_LIMIT = 400;

export class SimRuntime {
  game: Game;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  private startedAt = Date.now();
  private opQueue: { name: keyof AgentOperations; args: any }[] = [];
  private activeOps = 0;
  private lastSave = 0;
  private lastNotify = 0;
  private bootedAt = Date.now();
  private visibilityHandler: (() => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;

  llmCalls = 0;
  lastLlmMs = 0;
  lastLlmError: string | null = null;
  error: string | null = null;

  constructor(game?: Game) {
    this.game = game ?? new Game();
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    if (!localDB.ready) await localDB.init();
    applySettingsToConstants();

    const worldDoc = localDB.get<WorldDoc>('world', 'world');
    const mapDoc = localDB.all<MapDoc>('maps').find((m) => m.isDefault) ?? localDB.all<MapDoc>('maps')[0];

    if (worldDoc?.simulation) {
      try {
        this.game = new Game({
          ...worldDoc.simulation,
          worldMap: mapDoc?.map ?? worldDoc.simulation.worldMap,
        });
        this.game.currentTime = worldDoc.engineTime ?? Date.now();
        // Seeding and any queued inputs are applied on the next tick: keep the
        // loop parked until init() has finished, or `await sendInput()` deadlocks.
        this.game.pause();
      } catch (e: any) {
        console.warn('Failed to restore saved world, starting fresh:', e);
        await this.seedWorld();
      }
    } else {
      await this.seedWorld();
    }

    this.wireGame();
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.hidden) void this.persist();
        else this.syncTimer();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      this.unloadHandler = () => void this.persistSync();
      window.addEventListener('beforeunload', this.unloadHandler);
      window.addEventListener('pagehide', this.unloadHandler);
    }
    if (getSettings().player.joinOnLoad) {
      await this.joinHuman();
    }
    if (getSettings().sim.autoStart) this.game.resume();
    else this.game.pause();
    this.unsubscribeSettings = subscribeSettings(() => {
      applySettingsToConstants();
      void this.applyHumanSettings();
    });
    this.syncTimer();
    this.notify();
  }

  private async seedWorld() {
    // First run: create the default map + cast inside the local database, then
    // build the world from it.
    if (localDB.count('maps') === 0) {
      localDB.put('maps', {
        _id: 'map-default',
        name: 'Gentle (default)',
        map: normalizeMap(await loadDefaultMap()),
        updatedAt: Date.now(),
        isDefault: true,
      });
    }
    if (localDB.count('characters') === 0) {
      DEFAULT_CAST.forEach((def, index) => {
        localDB.put<CharacterDoc>('characters', {
          ...def,
          _id: def.id,
          _creationTime: Date.now() + index,
        });
      });
    }
    const mapDoc = localDB.all<MapDoc>('maps').find((m) => m.isDefault)!;
    this.game = new Game({ worldMap: mapDoc.map });
    this.game.pause();
    await this.syncCastFromDb();
    await this.persist();
  }

  private wireGame() {
    this.game.onNotify = () => this.notify();
    this.game.onArchivedConversation = (conversation) => this.archiveConversation(conversation);
    this.game.onOperation = (name, args) =>
      this.enqueueOperation(name as keyof AgentOperations, args);
    for (const operation of this.game.flushOperations()) {
      this.enqueueOperation(operation.name, operation.args);
    }
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined') {
      this.visibilityHandler && document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.unloadHandler && window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler && window.removeEventListener('pagehide', this.unloadHandler);
    }
    this.unsubscribeSettings?.();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------- loop

  private syncTimer() {
    const state = this.state();
    const wantRunning = state === 'running' && this.hasWork();
    if (wantRunning && this.timer === null) {
      const hz = Math.max(1, Math.min(120, getSettings().sim.tickHz));
      this.timer = setInterval(() => this.frame(), Math.round(1000 / hz));
    } else if (!wantRunning && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private hasWork() {
    return this.game.world.players.size > 0 || this.opQueue.length > 0;
  }

  private frame() {
    try {
      const now = Date.now();
      // Don't try to simulate a whole weekend when a tab wakes up.
      const maxJump = 250;
      const target = Math.min(now, this.game.currentTime + maxJump);
      this.game.tick(target);
      this.game.currentTime = Math.max(this.game.currentTime, target);
      this.drainOperations();
      if (now - this.lastSave > getSettings().sim.saveIntervalMs) {
        this.lastSave = now;
        void this.persist();
      }
      if (now - this.lastNotify > 16) {
        this.lastNotify = now;
        this.notify();
      }
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      console.error('Simulation frame failed', e);
      this.game.pause();
      this.notify();
    }
  }

  private drainOperations() {
    const concurrency = Math.max(1, getSettings().ai.concurrency);
    while (this.opQueue.length > 0 && this.activeOps < concurrency) {
      const operation = this.opQueue.shift()!;
      this.activeOps++;
      this.notify();
      this.runOperation(operation.name, operation.args)
        .catch((e) => {
          console.warn(`Operation ${operation.name} failed`, e);
          this.lastLlmError = e?.message ?? String(e);
        })
        .finally(() => {
          this.activeOps--;
          // Give the engine a beat to apply the input the operation produced.
          void sleep(0).then(() => this.notify());
          this.notify();
          this.syncTimer();
        });
    }
  }

  private async runOperation(name: keyof AgentOperations, args: any): Promise<void> {
    const started = Date.now();
    try {
      switch (name) {
        case 'agentGenerateMessage':
          await generateConversationMessage(this, args);
          break;
        case 'agentRememberConversation':
          await rememberConversation(this, args);
          break;
        case 'agentDoSomething':
          await doSomething(this, args);
          break;
        default:
          console.warn(`Unknown operation ${String(name)}`);
      }
      this.llmCalls++;
      this.lastLlmMs = Date.now() - started;
    } catch (e: any) {
      this.llmCalls++;
      this.lastLlmError = e?.message ?? String(e);
      this.lastLlmMs = Date.now() - started;
      throw e;
    }
  }

  /** Called by the engine whenever it schedules async work. */
  enqueueOperation(name: keyof AgentOperations, args: any) {
    this.opQueue.push({ name, args });
    this.syncTimer();
  }

  // ----------------------------------------------------------------- inputs

  async sendInput<Name extends keyof import('../engine/inputs').InputHandlers>(
    name: Name,
    args: any,
  ) {
    const result = await this.game.insertInput(name, args);
    this.notify();
    return result;
  }

  /** Fire and forget, swallowing "not in a conversation"-style errors. */
  fireInput(name: any, args: any) {
    this.game.insertInput(name, args).catch((e) => console.warn(`Input ${name}: ${e?.message}`));
    this.notify();
  }

  // -------------------------------------------------------------- casting

  characters(): CharacterDef[] {
    return localDB.all<CharacterDoc>('characters').map(({ _id, _creationTime, ...rest }) => ({
      ...rest,
      id: _id,
    }));
  }

  /** Adds/updates a cast member and (re)spawns them in the world. */
  async upsertCharacter(def: CharacterDef, options: { respawn?: boolean } = {}) {
    const existing = localDB.get<CharacterDoc>('characters', def.id);
    localDB.put<CharacterDoc>('characters', { ...def, _id: def.id } as CharacterDoc);
    const respawn = options.respawn ?? true;
    if (respawn) {
      if (existing) {
        const playerId = [...this.game.castIds.entries()].find(([, id]) => id === def.id)?.[0];
        if (playerId) {
          await this.sendInput('despawnCharacter', { playerId });
        }
      }
      if (def.enabled) {
        await this.sendInput('spawnCharacter', { character: def });
      }
    } else if (def.enabled) {
      const playerId = [...this.game.castIds.entries()].find(([, id]) => id === def.id)?.[0];
      const agent = playerId && this.game.world.agentForPlayer(playerId);
      await this.sendInput('updateCharacterDescriptions', {
        playerId,
        agentId: agent?.id,
        name: def.name,
        description: def.description,
        character: def.character,
        identity: def.identity,
        plan: def.plan,
        styleNotes: def.styleNotes,
      });
    }
    await this.persist();
  }

  async removeCharacter(id: string) {
    const playerId = [...this.game.castIds.entries()].find(([, cid]) => cid === id)?.[0];
    if (playerId) await this.sendInput('despawnCharacter', { playerId });
    localDB.delete('characters', id);
    await this.persist();
  }

  /** Re-spawns every enabled cast member (after import / reset / map change). */
  async syncCastFromDb() {
    for (const def of this.characters()) {
      try {
        await this.sendInput('spawnCharacter', { character: def });
      } catch (e: any) {
        console.warn(`Failed to spawn ${def.name}: ${e?.message}`);
      }
    }
    await this.persist();
  }

  // ------------------------------------------------------------------- map

  currentMap(): SerializedWorldMap {
    return this.game.worldMap.serialize();
  }

  async saveMap(map: SerializedWorldMap, options: { name?: string; applyToWorld?: boolean } = {}) {
    const normalized = normalizeMap(map);
    const existing =
      localDB.all<MapDoc>('maps').find((m) => m.isDefault) ?? localDB.all<MapDoc>('maps')[0];
    localDB.put('maps', {
      _id: existing?._id ?? 'map-default',
      name: options.name ?? existing?.name ?? 'My map',
      map: normalized,
      updatedAt: Date.now(),
      isDefault: true,
    });
    if (options.applyToWorld !== false) {
      await this.sendInput('updateWorldMap', { map: normalized });
      await this.persist();
    }
  }

  async saveMapAsNew(name: string, map: SerializedWorldMap) {
    localDB.put('maps', {
      _id: `map-${Date.now().toString(36)}`,
      name,
      map: normalizeMap(map),
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async activateMap(mapId: string) {
    const doc = localDB.get<MapDoc>('maps', mapId);
    if (!doc) throw new Error(`Unknown map ${mapId}`);
    for (const other of localDB.all<MapDoc>('maps')) {
      if (other.isDefault && other._id !== mapId) {
        localDB.patch('maps', other._id, { isDefault: false });
      }
    }
    localDB.patch('maps', mapId, { isDefault: true });
    await this.sendInput('updateWorldMap', { map: doc.map });
    await this.persist();
  }

  // --------------------------------------------------------------- messages

  async sendHumanMessage(playerId: string, conversationId: string, text: string) {
    const messageUuid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    localDB.put('messages', {
      _id: `msg-${messageUuid}`,
      _creationTime: Date.now(),
      conversationId,
      messageUuid,
      author: playerId,
      text,
      worldId: 'world',
    });
    await this.sendInput('finishSendingMessage', {
      playerId,
      conversationId,
      // The conversation tracks the simulation clock, not the wall clock.
      timestamp: this.game.currentTime,
    });
    await this.persist();
  }

  messagesFor(conversationId: string) {
    return localDB
      .all<any>('messages')
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a._creationTime - b._creationTime);
  }

  // ------------------------------------------------------------ persistence

  archiveConversation(conversation: {
    id: string;
    creator: string;
    created: number;
    ended: number;
    numMessages: number;
    participants: string[];
  }) {
    localDB.put<ArchivedConversation>('conversations', {
      ...conversation,
      _id: `conv-${conversation.id}`,
      worldId: 'world',
    } as ArchivedConversation);
    const participants = conversation.participants;
    for (let i = 0; i < participants.length; i++) {
      for (let j = 0; j < participants.length; j++) {
        if (i === j) continue;
        localDB.put('participatedTogether', {
          _id: `pt-${conversation.id}-${participants[i]}-${participants[j]}`,
          worldId: 'world',
          conversationId: conversation.id,
          player1: participants[i],
          player2: participants[j],
          ended: conversation.ended,
        });
      }
    }
  }

  async persist() {
    if (!this.game) return;
    const snapshot = this.game.snapshot();
    localDB.put<WorldDoc>('world', {
      _id: 'world',
      savedAt: Date.now(),
      simulation: snapshot,
      engineTime: this.game.currentTime,
    } as WorldDoc);

    if (this.game.descriptionsModified) {
      this.game.descriptionsModified = false;
      for (const description of snapshot.playerDescriptions) {
        localDB.put('playerDescriptions', { ...description, _id: description.playerId });
      }
      for (const description of snapshot.agentDescriptions) {
        localDB.put('agentDescriptions', { ...description, _id: description.agentId });
      }
    }
    if (this.game.mapModified) {
      this.game.mapModified = false;
      await this.saveMap(snapshot.worldMap, { applyToWorld: false });
    }
    await localDB.flush();
  }

  /** Best-effort synchronous-ish flush during unload. */
  private persistSync() {
    try {
      void this.persist();
      if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
        // IndexedDB can't be flushed synchronously; a microtask is the best we get,
        // and the loop persists every couple of seconds anyway.
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- human play

  get humanPlayerId(): GameId<'players'> | undefined {
    const identity = `human:me`;
    return [...this.game.world.players.values()].find((p) => p.human === identity)?.id;
  }

  async joinHuman() {
    if (this.humanPlayerId) return this.humanPlayerId;
    const player = getSettings().player;
    const playerId = await this.sendInput('join', {
      name: player.name,
      character: player.character,
      description: player.description,
      human: 'human:me',
    });
    await this.persist();
    return playerId as GameId<'players'>;
  }

/** Push the "You" settings (name / sprite / description) onto the live player. */
  async applyHumanSettings() {
    const playerId = this.humanPlayerId;
    if (!playerId) return;
    const player = getSettings().player;
    try {
      await this.sendInput('updateCharacterDescriptions', {
        playerId,
        name: player.name,
        description: player.description,
        character: player.character,
      });
    } catch (e: any) {
      console.warn(`Could not apply your player settings: ${e?.message}`);
    }
  }

  async leaveHuman() {
    const playerId = this.humanPlayerId;
    if (!playerId) return;
    await this.sendInput('leave', { playerId });
    await this.persist();
  }

  // ----------------------------------------------------------------- status

  state(): EngineState['status'] {
    if (this.error) return 'error';
    if (!this.game.running) return 'paused';
    return 'running';
  }

  status(): EngineState {
    return {
      status: this.state(),
      error: this.error ?? undefined,
      currentTime: this.game.currentTime,
      uptimeMs: Date.now() - this.bootedAt,
      activeOps: this.activeOps,
      queuedOps: this.opQueue.length,
      llmCalls: this.llmCalls,
      lastLlmMs: this.lastLlmMs,
      lastLlmError: this.lastLlmError ?? undefined,
      isLeader: true,
    };
  }

  pause() {
    this.game.pause();
    void this.persist();
    this.syncTimer();
    this.notify();
  }

  resume() {
    this.error = null;
    this.game.resume();
    this.game.currentTime = Date.now();
    this.syncTimer();
    this.notify();
  }

  toggle() {
    if (this.game.running) this.pause();
    else this.resume();
  }

  /** Simulate a single tick (useful while paused). */
  stepOnce(ms = 500) {
    this.game.tick(this.game.currentTime + ms);
    this.drainOperations();
    this.notify();
  }

  /** Run N ticks without waiting for the model (used by the "hurry up" button). */
  async fastForward(ticks = 60) {
    for (let i = 0; i < ticks; i++) {
      this.game.tick(this.game.currentTime + 250);
      this.drainOperations();
      await sleep(0);
    }
    await this.persist();
    this.notify();
  }

  async resetWorld(options: { keepMemories?: boolean } = {}) {
    localDB.delete('world', 'world');
    for (const conversation of localDB.all('conversations')) localDB.delete('conversations', conversation._id);
    for (const message of localDB.all('messages')) localDB.delete('messages', message._id);
    for (const edge of localDB.all('participatedTogether')) {
      localDB.delete('participatedTogether', edge._id);
    }
    if (!options.keepMemories) localDB.clear('memories');
    const mapDoc = localDB.all<MapDoc>('maps').find((m) => m.isDefault);
    this.game = new Game({ worldMap: mapDoc?.map ?? this.game.worldMap.serialize() });
    this.game.pause();
    this.wireGame();
    await this.syncCastFromDb();
    await this.persist();
    if (getSettings().sim.autoStart) this.game.resume();
    this.notify();
  }

  log(level: LogDoc['level'], source: string, message: string, data?: unknown) {
    // Debug noise is sampled; the log table is kept bounded so a long-running
    // tab can't blow out IndexedDB.
    if (level === 'debug' && Math.random() > 0.35) return;
    localDB.put<LogDoc>('logs', { level, source, message, data, _creationTime: Date.now() } as LogDoc);
    const count = localDB.count('logs');
    if (count > LOG_LIMIT) {
      for (const stale of localDB.all<LogDoc>('logs').slice(0, count - LOG_LIMIT)) {
        localDB.delete('logs', stale._id);
      }
    }
    this.onLog?.({ level, source, message, data });
  }

  onLog: ((entry: Omit<LogDoc, '_id' | '_creationTime'>) => void) | null = null;

  // ------------------------------------------------------------ subscribers

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

function applySettingsToConstants() {
  const settings = getSettings();
  overrideConstants({
    MOVEMENT_SPEED: settings.sim.movementSpeed,
    CONVERSATION_COOLDOWN: settings.sim.conversationCooldownMs,
  });
}
