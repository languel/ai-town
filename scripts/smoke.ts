/**
 * Headless smoke test for the local build: boots the whole stack (in-memory
 * IndexedDB substitute, mock provider, ported engine) in Node, runs the world
 * forward, and asserts the interesting things happened.
 *
 *   npm run smoke
 */
import { localDB } from '../src/local/db/local.ts';
import { SimRuntime } from '../src/local/sim/runtime.ts';
import { normalizeMap, WorldMap } from '../src/local/engine/worldMap.ts';
import { proceduralMap } from '../src/local/data/maps.ts';
import { hashEmbedding } from '../src/local/ai/providers.ts';
import { updateSettings } from '../src/local/db/settings.ts';
import { improvise } from '../src/local/ai/mock.ts';
import { memoryCount } from '../src/local/ai/memory.ts';
import {
  chooseVariant,
  formatBytes,
  parseModelDetail,
  toModelSummary,
  variantsFromSiblings,
} from '../src/local/ai/hub.ts';
import { mergeChoices, refreshModelList } from '../src/local/ai/modelList.ts';
import { stripReasoning } from '../src/local/ai/webgpu.ts';
import {
  DEFAULT_CHAT_MODEL,
  WEBGPU_CATALOG,
  isKnownArchitecture,
  webgpuBlockedDtypes,
} from '../src/local/ai/webgpuCatalog.ts';
import { getSettings } from '../src/local/db/settings.ts';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  // The offline improviser normally fakes per-word latency so the typing bubble
  // behaves; the harness wants the whole town to think instantly.
  updateSettings({ ai: { mockLatencyMs: 0 } });

  // --- map primitives -----------------------------------------------------
  const raw = proceduralMap(24, 16);
  const worldMap = new WorldMap(normalizeMap(raw));
  const solid = (() => {
    for (let y = 0; y < worldMap.height; y++) {
      for (let x = 0; x < worldMap.width; x++) if (worldMap.isSolid(x, y)) return true;
    }
    return false;
  })();
  check('procedural map has obstacles', solid);
  // Tile 0 is a real tile, not "empty" — the editor depends on that.
  const zero = normalizeMap(proceduralMap(6, 6));
  zero.bgTiles[0][2][3] = 0;
  const zeroMap = new WorldMap(zero);
  zeroMap.setTile('bg', 0, 4, 5, 7);
  check(
    'tile index 0 survives setTile (no falsy clobbering)',
    zeroMap.tileAt('bg', 0, 2, 3) === 0 && zeroMap.tileAt('bg', 0, 4, 5) === 7,
  );
  const flip = (worldMap.tileAt('bg', 0, 3, 3) ?? 0) === 1 ? 2 : 1;
  worldMap.setTile('bg', 0, 3, 3, flip);
  const roundtrip = new WorldMap(normalizeMap(worldMap.serialize()));
  check(
    'map edits survive a serialize roundtrip',
    roundtrip.tileAt('bg', 0, 3, 3) === flip,
    `${roundtrip.tileAt('bg', 0, 3, 3)} === ${flip}`,
  );

  // --- world boot ---------------------------------------------------------
  const runtime = new SimRuntime();
  await runtime.init();
  runtime.pause(); // drive the loop by hand so the test is deterministic
  const spawned = runtime.game.world.players.size;
  check('default cast spawned', spawned >= 4, `${spawned} players`);
  check('default map stored in the local db', localDB.count('maps') === 1);
  check('cast persisted', localDB.count('characters') >= 4);
  check('world snapshot written', !!localDB.get('world', 'world'));

  const startPositions = new Map(
    [...runtime.game.world.players.values()].map((p) => [p.id as string, { ...p.position }]),
  );

  // --- human player -------------------------------------------------------
  const humanId = await runtime.joinHuman();
  check('human can join', !!humanId);
  const human = humanId ? runtime.game.world.players.get(humanId) : undefined;
  check('human has a description', !!humanId && !!runtime.game.playerDescriptions.get(humanId));
  if (human && humanId) {
    const from = { x: human.position.x, y: human.position.y };
    const nearby = [...runtime.game.world.players.values()].find(
      (p) => p.id !== humanId && Math.abs(p.position.x - from.x) + Math.abs(p.position.y - from.y) > 1,
    );
    if (nearby) {
      // Aim at a walkable tile next to them rather than their exact (possibly
      // blocked) tile, which is what the click-to-move handler does too.
      const target = { x: Math.floor(nearby.position.x), y: Math.floor(nearby.position.y) };
      let spot: { x: number; y: number } | undefined;
      outer: for (let r = 0; r < 4; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const x = target.x + dx;
            const y = target.y + dy;
            if (!runtime.game.worldMap.isSolid(x, y)) {
              spot = { x, y };
              break outer;
            }
          }
        }
      }
      await runtime.sendInput('moveTo', { playerId: humanId, destination: spot ?? target });
      await runtime.fastForward(600);
      const after = runtime.game.world.players.get(humanId)!;
      check(
        'click-to-move routes the human',
        Math.abs(after.position.x - from.x) + Math.abs(after.position.y - from.y) > 0.5,
      );
    }
    // Invite an agent exactly like the "Talk to" button does, then step the
    // world until they actually meet. With the instant mock model a chat can be
    // over in seconds, so poll instead of running a fixed number of ticks.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (predicate: () => boolean, maxTicks = 600) => {
      for (let done = 0; done < maxTicks; done += 5) {
        if (predicate()) return true;
        await runtime.fastForward(5);
      }
      return predicate();
    };
    const agentPlayers = [...runtime.game.world.agents.values()]
      .map((a) => runtime.game.world.players.get(a.playerId)!)
      .filter((p) => !!p);
    let partner: (typeof agentPlayers)[number] | undefined;
    let conversationId: string | undefined;
    // Walking across town can drop the human into a chat on its own; if so,
    // there's nothing to invite.
    const existing = runtime.game.playerConversation(humanId);
    if (existing) {
      conversationId = existing.id;
      partner = agentPlayers.find((p) => existing.participants.has(p.id));
    }
    for (let attempt = 0; attempt < 8 && !partner; attempt++) {
      const free = agentPlayers.filter((p) => !runtime.game.world.playerConversation(p));
      const candidate = free[0] ?? agentPlayers[0];
      if (!candidate) {
        await runtime.fastForward(20);
        continue;
      }
      if (free[0]) {
        try {
          await runtime.sendInput('startConversation', { playerId: humanId, invitee: candidate.id });
          partner = candidate;
        } catch {
          await runtime.fastForward(20); // they got busy between the check and the input
        }
      } else {
        // The whole town is chatting: end one conversation so there is somebody
        // free to invite, the way the "Talk to" button would after they finish.
        const theirs = runtime.game.playerConversation(candidate.id);
        if (theirs) {
          await runtime.sendInput('leaveConversation', {
            playerId: candidate.id,
            conversationId: theirs.id,
          });
        }
        await runtime.fastForward(20);
      }
    }
    // An agent may have invited *us* while we were walking around — answer the way
    // the "Accept" button in the panel does.
    const pending = runtime.game.playerConversation(humanId);
    if (pending && pending.participants.get(humanId)?.status.kind === 'invited') {
      await runtime.sendInput('acceptInvite', { playerId: humanId, conversationId: pending.id });
      conversationId = pending.id;
      partner = agentPlayers.find((p) => pending.participants.has(p.id)) ?? partner;
    }
    const met =
      conversationId !== undefined ||
      (partner
        ? await waitFor(() => {
            conversationId = runtime.game.playerConversation(humanId)?.id;
            return !!conversationId;
          }, 900)
        : false);
    check('human shares a conversation with an agent', met);
    if (met) {
      // Wait until they're standing face to face — messages only flow once both
      // memberships are `participating` — then trade a line each.
      let replied = false;
      for (let attempt = 0; attempt < 8 && !replied; attempt++) {
        if (attempt > 0 && !runtime.game.playerConversation(humanId)) {
          // We're on our own again (they left, or we declined by walking off):
          // ask somebody to talk, exactly like the panel button. Six agents
          // pair up fast, so wait for one to be free instead of giving up.
          let free = agentPlayers.find((p) => !runtime.game.world.playerConversation(p));
          for (let w = 0; !free && w < 6; w++) {
            await runtime.fastForward(25);
            free = agentPlayers.find((p) => !runtime.game.world.playerConversation(p));
          }
          if (free) {
            await runtime
              .sendInput('startConversation', { playerId: humanId, invitee: free.id })
              .catch(() => null);
            partner = free;
          }
        }
        const chatting = await waitFor(() => {
          const c = runtime.game.playerConversation(humanId);
          if (!c) return false;
          conversationId = c.id;
          if (![...c.participants.values()].every((m) => m.status.kind === 'participating')) {
            return false;
          }
          // Don't talk over an unfinished reply — the op queue is async.
          const theirAgent = partner
            ? runtime.game.world.agents.get(
                [...runtime.game.world.agents.values()].find(
                  (a) => a.playerId === partner!.id,
                )?.id ?? ('a:none' as any),
              )
            : undefined;
          return !theirAgent?.inProgressOperation;
        }, 600);
        if (!chatting || !conversationId) {
          await runtime.fastForward(60);
          continue;
        }
        // Streaming rows are created empty and patched with text, so "new rows"
        // alone isn't enough — a reply in this conversation counts even if the
        // placeholder predates our message.
        const rows = localDB.all<any>('messages');
        const before = new Set(rows.map((m) => m._id as string));
        // Streaming placeholders start empty and are patched in place, so a row
        // we've already seen still counts if it had no text yet.
        const blankBefore = new Set(
          rows.filter((m) => !m.text).map((m) => m._id as string),
        );
        await runtime.sendHumanMessage(humanId, conversationId, 'hello there');
        check(
          'the human message landed in the log',
          localDB
            .all<any>('messages')
            .some((m) => m.conversationId === conversationId && m.text.includes('hello there')),
        );
        // Accept a reply in *either* this conversation or the next one they
        // start — with the instant mock model an 8-message chat can wrap up
        // between our send and their turn.
        const sawReply = () =>
          localDB.all<any>('messages').some(
            (m) =>
              m.conversationId === conversationId &&
              m.author !== humanId &&
              !m.text.includes('hello there') &&
              m.text.length > 4 &&
              (!before.has(m._id as string) || blankBefore.has(m._id as string)),
          );
        // The reply has to survive the op queue, which is paced by *real* time
        // (the provider sleeps), so fast-forwarding alone can outrun it.
        for (let i = 0; i < 120 && !replied; i++) {
          replied = sawReply();
          if (replied) break;
          await sleep(25);
          await runtime.fastForward(10);
        }
        replied = replied || sawReply();
        if (!replied) {
          console.log(
            `   (no reply: queue=${(runtime as any).opQueue.length} active=${
              (runtime as any).activeOps
            } calls=${runtime.status().llmCalls} err=${runtime.status().lastLlmError ?? '-'})`,
          );
        }
        if (!replied) await runtime.fastForward(60); // maybe the chat just ended
      }
      const last = localDB
        .all<any>('messages')
        .filter((m) => m.conversationId === conversationId && m.author !== humanId)
        .at(-1);
      check('an agent replied to the human', replied, last?.text ?? '');
      // Humans aren't driven by an Agent, so the *agent* is the one who files
      // the memory once the conversation wraps.
      const memoriesBefore = memoryCount();
      check(
        'the agent remembers the human afterwards',
        await waitFor(() => memoryCount() > memoriesBefore, 2400),
        `${memoryCount()} memories in the town`,
      );
    }
  }

  // --- simulate -----------------------------------------------------------
  // 250ms per tick => ~5 simulated minutes; enough for an activity, a walk
  // across town, a conversation and the memories that follow.
  await runtime.fastForward(1200);
  const moved = [...runtime.game.world.players.values()].filter((p) => {
    const before = startPositions.get(p.id as string);
    return !!before && Math.abs(p.position.x - before.x) + Math.abs(p.position.y - before.y) > 0.5;
  });
  check('agents walk around', moved.length > 0, `${moved.length}/${spawned} moved`);
  check(
    'agents talk to each other',
    localDB.count('messages') > 0,
    `${localDB.count('messages')} messages`,
  );
  check(
    'conversations get archived afterwards',
    localDB.count('conversations') > 0,
    `${localDB.count('conversations')} archived`,
  );
  check('memories are written', memoryCount() > 0, `${memoryCount()} memories`);
  check(
    'agents remember who they talked to',
    localDB.count('participatedTogether') > 0,
    `${localDB.count('participatedTogether')} pairs`,
  );
  check('no simulation errors', runtime.error === null, runtime.error ?? '');
  check('model calls were made', runtime.llmCalls > 0, `${runtime.llmCalls} calls`);
  check('the event log is kept', localDB.count('logs') > 0, `${localDB.count('logs')} rows`);

  // --- editing the world --------------------------------------------------
  const cast = runtime.characters();
  const first = cast[0]!;
  await runtime.upsertCharacter({ ...first, identity: 'A retired lighthouse keeper who counts gulls.' });
  const respawnedPlayerId = [...runtime.game.castIds.entries()].find(([, id]) => id === first.id)?.[0];
  const respawnedAgent = respawnedPlayerId
    ? runtime.game.world.agentForPlayer(respawnedPlayerId)
    : undefined;
  check(
    'personality edits reach the live agent',
    (respawnedAgent && runtime.game.agentDescriptions.get(respawnedAgent.id)?.identity)
      ?.includes('lighthouse') === true,
    respawnedAgent ? respawnedAgent.id : 'agent not respawned',
  );
  const beforeRemove = runtime.game.world.players.size;
  await runtime.removeCharacter(first.id);
  check(
    'cast member can be removed',
    runtime.game.world.players.size === beforeRemove - 1,
    `${beforeRemove} → ${runtime.game.world.players.size}`,
  );

  const edited = normalizeMap(proceduralMap(18, 12));
  await runtime.saveMapAsNew('Smoke map', edited);
  const saved = localDB.all<any>('maps').find((m) => m.name === 'Smoke map');
  check('map editor can save a new map', !!saved);
  await runtime.activateMap(saved._id);
  check(
    'map activation replaces the live world',
    runtime.game.worldMap.width === edited.width && runtime.game.worldMap.height === edited.height,
  );

  // --- persistence --------------------------------------------------------
  await runtime.persist();
  const bundle = await localDB.exportBundle();
  const json = JSON.stringify(bundle);
  check(
    'bundle export includes every table',
    json.includes('"memories"') && json.length > 500,
    `${json.length} bytes`,
  );
  const beforeWipe = { characters: localDB.count('characters'), messages: localDB.count('messages') };
  await localDB.wipeAll();
  check('wipe clears the mirror', localDB.count('characters') === 0);
  await localDB.importBundle(JSON.parse(json), { replace: true });
  check(
    'bundle import restores the world',
    localDB.count('characters') === beforeWipe.characters && localDB.count('messages') === beforeWipe.messages,
    `${localDB.count('characters')} cast / ${localDB.count('messages')} messages`,
  );
  const restored = new SimRuntime();
  await restored.init();
  restored.pause();
  check(
    'a fresh runtime resumes from the stored snapshot',
    restored.game.world.players.size >= 4 && restored.game.worldMap.width > 10,
    `${restored.game.world.players.size} players, ${restored.game.worldMap.width}×${restored.game.worldMap.height} map`,
  );
  restored.destroy();
  runtime.destroy();

  // --- offline improvise + hashed embeddings ------------------------------
  const line = improvise({
    messages: [
      {
        role: 'system',
        content:
          "You are Alex, chatting with Sam.\nAbout you: loves tides.\nYour goals for the conversation: You want to trade a rope.",
      },
      { role: 'user', content: 'Sam: I have a spare rope.' },
    ],
    context: {
      kind: 'continue',
      speaker: 'Alex',
      listener: 'Sam',
      identity: 'loves tides',
      plan: 'trade a rope',
      lastMessage: 'Sam: I have a spare rope.',
    },
  });
  check('mock improviser produces a line', line.length > 4 && !line.includes('{'), JSON.stringify(line));
  const a = hashEmbedding('a rope and a lantern');
  const b = hashEmbedding('a rope and a lantern');
  const c = hashEmbedding('entirely different sentence about soup');
  check('hashed embeddings are deterministic', JSON.stringify(a) === JSON.stringify(b));
  check('and differentiate text', JSON.stringify(a) !== JSON.stringify(c) && a.length === 384);

  // --- webgpu / onnx model list -------------------------------------------
  // Shapes below are the hub API's own payloads (captured 2026-09-17), so a
  // response-format change shows up here rather than as a broken dropdown.
  const liquidSiblings = [
    { rfilename: 'README.md', size: 6508 },
    { rfilename: 'chat_template.jinja', size: 1783 },
    { rfilename: 'onnx/model.onnx', size: 140810 },
    { rfilename: 'onnx/model.onnx_data', size: 2063007744 },
    { rfilename: 'onnx/model.onnx_data_1', size: 2072240128 },
    { rfilename: 'onnx/model_fp16.onnx', size: 140027 },
    { rfilename: 'onnx/model_fp16.onnx_data', size: 2067623936 },
    { rfilename: 'onnx/model_q4.onnx', size: 183173 },
    { rfilename: 'onnx/model_q4.onnx_data', size: 850059264 },
    { rfilename: 'onnx/model_q8.onnx', size: 150000 },
    { rfilename: 'onnx/model_q8.onnx_data', size: 1300000000 },
  ];
  const liquidVariants = variantsFromSiblings(liquidSiblings, 'lfm2');
  check(
    'a repo\'s file list becomes loadable precisions',
    ['fp32', 'fp16', 'q4', 'q8'].every((d) => liquidVariants.some((v) => v.dtype === d)),
    liquidVariants.map((v) => `${v.dtype}:${formatBytes(v.bytes)}`).join(' '),
  );
  const liquidQ4 = liquidVariants.find((v) => v.dtype === 'q4');
  check(
    'weights shards are counted towards the variant size',
    !!liquidQ4 && liquidQ4.sharded && liquidQ4.bytes > 850_000_000,
    liquidQ4 ? formatBytes(liquidQ4.bytes) : '-',
  );
  check('and the cheapest export is offered first', liquidVariants[0].dtype === 'q4');
  check(
    'LFM2.5 q8 is marked unusable on WebGPU',
    liquidVariants.find((v) => v.dtype === 'q8')?.webgpuSafe === false &&
      webgpuBlockedDtypes('llama').length === 0,
    `lfm2 blocks ${webgpuBlockedDtypes('lfm2').join('/')}`,
  );
  check('so auto precision picks q4 there', chooseVariant(liquidVariants, 'webgpu')?.dtype === 'q4');

  const legacyVariants = variantsFromSiblings(
    [
      { rfilename: 'onnx/model.onnx', size: 900_000_000 },
      { rfilename: 'onnx/model_quantized.onnx', size: 300_000_000 },
      { rfilename: 'onnx/model_fp16.onnx', size: 200_000_000 },
    ],
    'llama',
  );
  check(
    'legacy model_quantized.onnx maps to q8',
    legacyVariants.some((v) => v.dtype === 'q8' && v.legacyQuantized),
    legacyVariants.map((v) => v.dtype).join(','),
  );
  check(
    'WebGPU takes the smallest safe export, WASM the int8 one',
      chooseVariant(legacyVariants, 'webgpu')?.dtype === 'fp16' &&
      chooseVariant(legacyVariants, 'wasm')?.dtype === 'q8',
  );

  const summary = toModelSummary({
    id: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    tags: ['transformers.js', 'onnx', 'lfm2', 'text-generation', 'webgpu', 'conversational', 'en', 'ja', 'license:other'],
    downloads: 3979,
    likes: 36,
    pipeline_tag: 'text-generation',
    library_name: 'transformers.js',
    lastModified: '2026-02-17T13:59:09.000Z',
    config: { architectures: ['Lfm2ForCausalLM'], model_type: 'lfm2' },
  });
  check(
    'a hub listing parses into a picker entry',
    !!summary &&
      summary.webgpu &&
      summary.transformersJs &&
      summary.conversational &&
      summary.modelType === 'lfm2' &&
      summary.license === 'other' &&
      summary.languages.join(',') === 'en,ja',
    JSON.stringify({ id: summary?.id, downloads: summary?.downloads, langs: summary?.languages }),
  );
  const detail = parseModelDetail({
    id: 'some/repo',
    config: { model_type: 'llama' },
    siblings: liquidSiblings,
    downloads: 5,
  });
  check(
    'repo detail reports the chat template and size',
    !!detail?.hasChatTemplate && (detail?.bytes ?? 0) > 8_000_000_000,
    `${detail?.variants.length} variants, ${formatBytes(detail?.bytes ?? 0)}`,
  );
  check('empty hub rows are dropped', toModelSummary({ tags: [] }) === null);

  check(
    'thinking blocks never reach the town',
    stripReasoning('<thinking>hmm, what to say</thinking>Sure, I can help.') === 'Sure, I can help.',
    JSON.stringify(stripReasoning('<thinking>a</thinking>b')),
  );
  check(
    'an unterminated block still leaves a line',
    stripReasoning('<thinking>a').length > 0 && stripReasoning('Hello there.') === 'Hello there.',
  );

  const builtin = mergeChoices(
    [{ id: 'a/b', label: 'A B', source: 'builtin', task: 'text-generation', dtype: 'q8', note: 'why' }],
    [
      { id: 'a/b', label: 'A B (hub)', source: 'hub', task: 'text-generation', downloads: 10 },
      { id: 'c/d', label: 'C D', source: 'hub', task: 'text-generation', webgpu: true },
    ],
  );
  check(
    'the built-in hint wins over the hub row for the same repo',
    builtin.length === 2 &&
      builtin[0].dtype === 'q8' &&
      builtin[0].downloads === 10 &&
      builtin[1].id === 'c/d',
    builtin.map((b) => `${b.id}:${b.source}`).join(' '),
  );

  // Refresh, with fetch stubbed both ways: the panel must fill from the hub when
  // it can, and from the catalog when it cannot.
  const realFetch = globalThis.fetch;
  const providerBefore = getSettings().ai.provider;
  updateSettings({ ai: { provider: 'webgpu' } } as any);
  const hubRows = [
    {
      id: DEFAULT_CHAT_MODEL,
      tags: ['transformers.js', 'onnx', 'llama', 'conversational'],
      downloads: 310910,
      likes: 222,
      pipeline_tag: 'text-generation',
      library_name: 'transformers.js',
    },
    {
      id: 'someone/one-off-finetune',
      tags: ['transformers.js', 'webgpu', 'onnx'],
      downloads: 9,
      likes: 1,
      pipeline_tag: 'text-generation',
    },
  ];
  const hubResponse = { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(hubRows) };
  globalThis.fetch = () => Promise.resolve(hubResponse) as any;
  const scanned = await refreshModelList({ force: true });
  check(
    'refresh lists built-in models plus what the hub scan found',
    scanned.chat.some((c) => c.source === 'builtin') &&
      scanned.chat.some((c) => c.id === 'someone/one-off-finetune') &&
      !scanned.offline,
    `${scanned.chat.length} chat / ${scanned.embeddings.length} embedding options`,
  );
  check(
    'scan results keep the precision we recommend for that repo',
    scanned.chat.find((c) => c.id === DEFAULT_CHAT_MODEL)?.dtype === 'q8',
    String(scanned.chat.find((c) => c.id === DEFAULT_CHAT_MODEL)?.dtype),
  );
  globalThis.fetch = (() => Promise.reject(new Error('no network'))) as any;
  const stranded = await refreshModelList({ force: true });
  check(
    'an unreachable hub still offers the built-in list',
    stranded.offline &&
      !!stranded.error &&
      stranded.chat.length >= 5 &&
      WEBGPU_CATALOG.length > 8 &&
      WEBGPU_CATALOG.every((e) => isKnownArchitecture(e.modelType)),
    `${stranded.chat.length} offline options, ${
      new Set(WEBGPU_CATALOG.map((e) => e.id)).size
    } unique catalogue ids`,
  );
  globalThis.fetch = realFetch;
  updateSettings({ ai: { provider: providerBefore } } as any);

  const defaults = getSettings().ai;
  check(
    'the in-browser backend defaults to a transformers.js build with lfm2 kernels',
    /@4\.\d+\.\d+/.test(defaults.webgpu.cdnUrl) &&
      defaults.webgpu.chatModel === DEFAULT_CHAT_MODEL &&
      defaults.webgpu.dtype === 'auto',
    `${defaults.webgpu.cdnUrl.split('/').slice(-2).join('/')} · ${defaults.webgpu.chatModel}`,
  );

  console.log(failures === 0 ? '\nSMOKE TEST PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main().catch((e) => {
  console.error('smoke test crashed', e);
  process.exitCode = 1;
});
