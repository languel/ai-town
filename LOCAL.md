# AI Town — fully local build

Everything that used to live on a server now lives in your browser tab: the simulation engine, the
database, the vector search, the model calls, the personality editor and the map editor. `npm run
dev`, point it at a model (or don't), and the town is alive. The world persists in IndexedDB on
your machine.

```bash
npm install                    # no native builds or backend services to install
npm run dev                    # http://localhost:5173
```

A static copy is also built to GitHub Pages on every push:

**https://languel.github.io/ai-town/**

Open that URL in its own tab. The Arena / Codespaces preview is an iframe, and Chromium will refuse
WebGPU (`navigator.gpu`) plus some Hugging Face downloads there — it looks like CORS. A top-level
`github.io` origin does not have that restriction. The workflow is
`.github/workflows/pages.yml` (deploys `arena/01a0aae7-ai-town`, and `aitownarena` if the branch is
renamed).

There is no `.env`, no `npx convex dev`, no Docker, no API proxy. The only thing you can configure
is in-app (⚙️ Model tab).

## What's in the app

| Tab | What it does |
| --- | --- |
| 🏠 Town | The live world. Click to walk, click an agent to select them, "Talk to"/"Accept"/"Decline" in the panel, pause / fast-forward / collision overlay in the toolbar. |
| 🎭 Personalities | Full CRUD on the cast: name, sprite, description, identity, plan, style notes, enabled toggle — plus the six prompt templates the model is given. Edits respawn the agent immediately. |
| 🗺️ Map | Paint the town: brush/erase/fill/pick, layers, zoom, tileset presets or your own PNG, resize, undo/redo, save as a new map, apply to the running world. Imports the legacy `data/*.js` map files too. |
| 🧠 Memories | What each agent currently retrieves (type, importance, last access), a live retrieval test, force a reflection, recent conversations, and the event log. |
| 💾 Data | Row counts per table, storage estimate, export/import a single JSON world file (with or without your API key), download the map or settings, reset the world, wipe everything. |
| ⚙️ Model | Provider + model + key, embeddings, WebGPU model management, generation settings, and simulation knobs (tick rate, movement speed, cooldowns, autosave). |

## Running a model

Pick a provider in ⚙️ Model. The key never leaves your browser — requests go straight from the
page to the endpoint you configure.

- **Built-in improviser** (default): no model, no network, no key. Agents still walk around, start
  conversations, remember them and reflect on their memories using the same prompt pipeline, with a
  rule-based generator answering instead of an LLM. It exists so the app is *useful the first
  second you open it*, and so the tests are deterministic. Set "Offline delay / word" to 0 to make
  the town think instantly.
- **Ollama** — `http://localhost:11434/v1` (also the default for embeddings via `mxbai-embed-large`
  or `nomic-embed-text`). Enable "Allow access from browser"/CORS in Ollama if your build needs it.
- **LM Studio** — `http://localhost:1234/v1` with "Serve on localhost" enabled.
- **OpenAI / OpenRouter** — paste `sk-…`. Note that `api.openai.com` rejects browser origins for
  some keys; **OpenRouter works from the browser** and is the easiest hosted option. Anything that
  speaks the OpenAI protocol fits "OpenAI-compatible" (vLLM, llama.cpp server, Groq, Fireworks…).
- **In-browser WebGPU / ONNX** - transformers.js runs a quantized 1B-3B model on your GPU with no
  server at all. Pick a model, hit *Download / warm up*, and it stays cached by the browser. Needs a
  Chromium-ish browser with `--enable-unsafe-webgpu` on some setups; the panel tells you whether
  WebGPU was detected. See *Choosing a model* below.

### Choosing a model

Both model fields (chat and embeddings) are comboboxes with a **Refresh list** button. Nothing is
hardcoded: the list is three sources merged, in this order, and de-duplicated by repo id.

1. **Built-in catalogue** (`src/local/ai/webgpuCatalog.ts`) - repos verified to load in a tab, with a
   recommended precision and rough size each. Works with the network off, which is why the picker is
   never empty.
2. **Hub scan** (`src/local/ai/hub.ts`) - `GET /api/models?library=transformers.js&pipeline_tag=…`
   (plus `search=<what you typed>`), sorted by downloads, capped at 50 rows, cached for 6 h and
   mirrored into `localStorage` so the panel opens instantly. Set `Hub API base URL` to point at a
   mirror (`https://hf-mirror.com`) or your own static `models.json` host on an air-gapped box.
3. **Your own server**, for the HTTP providers: Ollama's `/api/tags` (size, quantisation, parameter
   count included) or `<base>/models` for LM Studio / vLLM / llama.cpp server, and OpenRouter's
   public catalogue with context length and price.

Typing narrows the list; the browser's native combobox does the filtering, and you can always type a
repo id that is in no list at all.

**Precision.** `auto` (default) reads the chosen repo's `onnx/model*.onnx` listing and takes the
smallest export the device can run - on WASM that is usually `q8`, on WebGPU whatever quantized
variant exists, falling back to `fp16`/`fp32`. The chips under the field show what the repo actually
publishes (`q4 811MB · q8 1.2GB · fp16 1.9GB …`) and clicking one pins that dtype for the slot.

That lookup is not cosmetic: **Liquid AI's LFM2.5 exports have no WebGPU kernels for q8** - their own
card says "use q4 or fp16" - so a build that always asks for q8 fails to load LFM2.5 models. They are
all in the catalogue (`LFM2.5-1.2B-Instruct`, `-230M`, `-2.6B`, `-1.2B-Thinking`) and need
transformers.js **4.x** (the `lfm2` / `lfm2_vl` / `lfm2_moe` architectures landed in 4.0.0), which is
what the default CDN URL now points at; change the version in *transformers.js URL* to pin another.
The `-Thinking` variants and Qwen3 like to narrate their reasoning before answering, so the
`Strip thinking blocks` option (on by default) removes the `<thinking>` wrapper and keeps the
actual line - including when the model runs out of tokens mid-thought.

Embeddings are used for memory retrieval only. If the embedding source fails, the app falls back to
a local hashed bag-of-words vector (384-dim), which is worse but keeps retrieval working. A broken
embedding config never bricks the town.

## Where the data lives

`src/local/db` is a reactive document store over IndexedDB (database `ai-town-local`), with a
synchronous in-memory mirror on top so the 30 Hz simulation and React never await. Writes are
queued and flushed every 250 ms and on `visibilitychange`/`beforeunload`. If IndexedDB is
unavailable (private windows), it degrades to a memory-only session and says so in 💾 Data.

Tables intentionally mirror the old Convex schema — `world`, `maps`, `characters`,
`playerDescriptions`, `agentDescriptions`, `messages`, `conversations`, `participatedTogether`,
`memories`, `embeddingsCache`, `logs`, `images`. Settings and prompt overrides live in
`localStorage` (`aifavella.settings`, `aifavella.prompts`, `aifavella.modelList`, `aifavella.hubCache`)
because they must be readable before the database opens.

**Portability:** 💾 Data → *download world* writes one JSON file with every table plus settings
(there's a "no key" variant for sharing). Import on another browser/machine and the world —
positions, chats, memories, map, cast — resumes where you left it.

## How it's put together

```
src/local/
  constants.ts          engine constants, overridable from Settings
  engine/               ported game logic (was convex/aiTown + convex/engine)
    game.ts             input queue, tick loop, snapshots, operation scheduling
    world.ts player.ts conversation.ts conversationMembership.ts agent.ts
    movement.ts         A* pathfinding + movement interpolation
    worldMap.ts         tiles, solidity, serialization     geometry.ts ids.ts types.ts
    inputs.ts           input handlers (join/move/invite/spawn/edit map…)
    descriptions.ts     character/personality definitions
  ai/
    chat.ts             one chatCompletion() → dispatches to a provider
    providers.ts        OpenAI-compatible HTTP, OpenRouter, Ollama, embeddings
    webgpu.ts           transformers.js runtime (lazy import, model cache, status)
    hub.ts              Hugging Face hub client: model search, file lists, variant/precision maths,
                        browser-cache scan. Pure helpers so the test can feed fixtures.
    webgpuCatalog.ts    the built-in (offline) list of models that are known to load
    modelList.ts        merges built-in + hub scan + your server's own /models into one dropdown
    mock.ts             the offline improviser
    prompts.ts          the 6 editable templates ({{var}} rendering)
    http.ts             fetch + SSE parsing, retries, stop-word cutting
    memory.ts           insert / retrieve (relevance+recency+importance) / reflect / vacuum
    embeddings.ts       sha256-keyed embedding cache
    operations.ts       what the engine awaits: message generation, remembering, "do something"
  db/                   IndexedDB store, settings, export/import bundles
  sim/runtime.ts        SimRuntime: 30 Hz loop, op queue with concurrency, autosave, seed
  data/                 default cast, sprite sheets, map loading, tileset presets
  ui/                   Pixi renderer, viewport, chat panel, personality + map editors, settings,
                        data browser, ModelField (the model dropdown with Refresh list)
  state.tsx             useTown/useSettings/… on top of useSyncExternalStore
```

Design notes worth knowing before you change things:

- **One process.** There is no client/server split, no historical-object replay, and no
  `useHistoricalValue` smoothing: sprites render straight from live engine state, and the editors
  mutate that same state through inputs.
- **The simulation clock is `game.currentTime`, in epoch ms.** Anything the engine compares against
  (activity expiry, conversation timeouts, cooldowns) must be stamped with `game.currentTime`, *not*
  `Date.now()`. `Date.now()` is only for DB row timestamps and display. Mixing them is the classic
  way to make agents freeze or stampede. It is also what makes a backgrounded tab (throttled to one
  timer per second) and the smoke test's fast-forward both behave: the town slows down or speeds up,
  but nothing expires early and no operation times out while you are on another tab.
- **Async work runs outside the tick.** The engine schedules operations (`agentGenerateMessage`,
  `agentDoSomething`, `agentRememberConversation`); `SimRuntime` executes them with bounded
  concurrency and feeds the result back as an input (`agentFinishSendingMessage`, …). If an agent
  vanishes mid-operation the finish input must still release the agent, otherwise it hangs "thinking"
  until `ACTION_TIMEOUT`.
- **Talking works because of two small nudges in `Conversation.tick`:** a participant stuck in
  `walkingOver` (failed A*, blocked doorway) is re-sent towards the other person every 1.5s of sim
  time, and a human's counterpart may stop one tile outside the exact `CONVERSATION_DISTANCE`. A
  single failed walk used to mean the invite expired at `INVITE_TIMEOUT` with no explanation. Both
  live in the engine rather than the UI, so the "hurry up" fast-forward exercises them too.
- **Paused ≠ dead.** While the loop is paused, `insertInput` applies immediately so the editors feel
  live. Boot therefore parks the game (`game.pause()`) until the world has been seeded, or the
  `await sendInput()` inside seeding would never resolve.

## Tests

```sh
npm test             # headless end-to-end: boots the stack in Node, simulates ~4 town-minutes
npm run test:invite  # stress: 25 rounds of inviting an agent and getting an answer
```

`scripts/smoke.ts` (bundled by esbuild, so no test framework is needed) boots the real stack in
Node - `MemoryKVStore` instead of IndexedDB, the mock provider instead of a model - and runs 50
assertions (the model-list ones feed it captured hub payloads, so a response-format change is caught
here and not in the dropdown): the map serializes back identically including tile `0`, the cast spawns and persists
across a reload, agents actually walk around and talk to each other, conversations get archived and
become memories that cosine retrieval finds, a human can join, be asked to talk, send a message and
get a reply, personality edits reach the live agent, activities expire against the simulation clock,
and an exported bundle can wipe a runtime and be re-imported into a fresh one. It fails loudly if any
of that stops being true; writing it caught a stuck "thinking" state, a tile-indexing bug in the map
editor, and an invite race. `npm run build` typechecks (`tsc --noEmit`) and `npm run lint` is clean.

## Deliberate differences from upstream

- No Convex, no Clerk auth, no Replicate music generation, no multiplayer, no server-side rate
  limiting. `legacy/convex-ui/` keeps the original client for reference (excluded from the build).
- Vector search is a cosine scan instead of HNSW — at a few thousand rows per browser tab that's
  faster than maintaining an index, and it removes the native `hnswlib-node` dependency.
- Humans are never kicked for idling; `CONVERSATION_COOLDOWN` and activity durations are shortened so
  a fresh tab gets interesting within ~20 seconds.
- The map is data, not code: it lives in the `maps` table, the editor owns it, and the object layer's
  solidity comes from the tileset's collision grid.

## Known limits

- ~24 agents on a mid-size map is comfortable; the tick is O(agents) but A* and memory retrieval are
  not free. Turn "Max agents" down in ⚙️ Model if a low-end device struggles.
- A browser tab is a bad place for a 70B model. WebGPU chat is capped by your VRAM (the quantized
  1B–3B range is the sweet spot), and hosted providers need a CORS-friendly endpoint.
- Exported worlds are plain JSON and can contain your API key. Use the *shareable (no key)* export
  when sending a world to somebody else.
- If you edit the map while agents are mid-route, they re-path on the next tick; standing inside a
  newly painted wall just makes them step out.
