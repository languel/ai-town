import { useEffect, useState } from 'react';
import { PROVIDER_PRESETS, resetSettings, updateSettings, type ProviderKind } from '../db/settings.ts';
import { useSettings } from '../state.tsx';
import { probeProvider } from '../ai/chat.ts';
import { getModelStatus, hasWebgpu, subscribeModelStatus, warmupWebgpu } from '../ai/webgpu.ts';
import { characters as SPRITES } from '../data/characters.ts';

/** Model + simulation configuration. Everything here is localStorage-backed. */
export default function SettingsPanel() {
  const settings = useSettings();
  const ai = settings.ai;
  const [probe, setProbe] = useState<{ running: boolean; ok?: boolean; detail?: string }>({
    running: false,
  });
  const [webgpuOk, setWebgpuOk] = useState<boolean | null>(null);
  const modelStatus = useModelStatus();
  const [warm, setWarm] = useState<{ running: boolean; error?: string }>({ running: false });

  useEffect(() => {
    void hasWebgpu().then(setWebgpuOk);
  }, []);

  const preset = PROVIDER_PRESETS[ai.provider];

  return (
    <div className="mx-auto grid max-w-[1200px] gap-4 p-4 md:grid-cols-2">
      <Card title="Inference provider">
        <p className="mb-2 text-xs opacity-80">{preset.hint}</p>
        <div className="grid grid-cols-2 gap-1">
          {(Object.keys(PROVIDER_PRESETS) as ProviderKind[]).map((kind) => (
            <button
              key={kind}
              onClick={() => updateSettings({ ai: { provider: kind, ...PROVIDER_PRESETS[kind].patch } as any })}
              className={`rounded px-2 py-1 text-left text-xs ${
                ai.provider === kind ? 'bg-clay-500' : 'bg-brown-900/60 hover:bg-brown-900'
              }`}
            >
              {PROVIDER_PRESETS[kind].label}
            </button>
          ))}
        </div>

        {ai.provider !== 'mock' && ai.provider !== 'webgpu' && (
          <div className="mt-3 grid gap-2">
            <Row label="Base URL">
              <input
                className="input"
                value={ai.baseUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(e) => updateSettings({ ai: { baseUrl: e.target.value } })}
              />
            </Row>
            <Row label="API key">
              <input
                className="input"
                type="password"
                value={ai.apiKey}
                placeholder="only stored in this browser's localStorage"
                onChange={(e) => updateSettings({ ai: { apiKey: e.target.value } })}
              />
            </Row>
            <Row label="Model">
              <input
                className="input"
                value={ai.chatModel}
                onChange={(e) => updateSettings({ ai: { chatModel: e.target.value } })}
              />
            </Row>
          </div>
        )}

        {ai.provider === 'webgpu' && (
          <div className="mt-3 grid gap-2">
            <Row label="Chat model (HF repo)">
              <input
                className="input"
                value={ai.webgpu.chatModel}
                onChange={(e) => updateSettings({ ai: { webgpu: { chatModel: e.target.value } } })}
              />
            </Row>
            <Row label="transformers.js URL">
              <input
                className="input"
                value={ai.webgpu.cdnUrl}
                onChange={(e) => updateSettings({ ai: { webgpu: { cdnUrl: e.target.value } } })}
              />
            </Row>
            <Row label="Device">
              <select
                className="input"
                value={ai.webgpu.device}
                onChange={(e) =>
                  updateSettings({ ai: { webgpu: { device: e.target.value as 'webgpu' | 'wasm' } } })
                }
              >
                <option value="webgpu">webgpu</option>
                <option value="wasm">wasm</option>
              </select>
            </Row>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={ai.webgpu.quantized}
                onChange={(e) => updateSettings({ ai: { webgpu: { quantized: e.target.checked } } })}
              />
              quantized weights (smaller download)
            </label>
            <p className="text-[11px] opacity-70">
              WebGPU in this browser:{' '}
              <strong>{webgpuOk === null ? 'checking…' : webgpuOk ? 'available ✓' : 'not available — use wasm'}</strong>
            </p>
            <button
              className="btn"
              disabled={warm.running}
              onClick={() => {
                setWarm({ running: true });
                void warmupWebgpu().then(
                  () => setWarm({ running: false }),
                  (e: Error) => setWarm({ running: false, error: e.message }),
                );
              }}
            >
              {warm.running ? 'loading model…' : '⬇ Download / warm model'}
            </button>
            {warm.error && <p className="text-[11px] text-red-300">{warm.error}</p>}
            {(modelStatus.files.length > 0 || modelStatus.ready) && (
              <ul className="max-h-40 overflow-y-auto text-[11px]">
                {modelStatus.files.slice(-8).map((file, i) => (
                  <li key={`${file.file}-${i}`} className="truncate">
                    {file.status} · {file.file} · {Math.round(file.progress)}%
                  </li>
                ))}
                {modelStatus.ready && <li className="text-green-300">model ready ✓</li>}
                {modelStatus.error && <li className="text-red-300">{modelStatus.error}</li>}
              </ul>
            )}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Row label="Temperature">
            <input
              className="input"
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={ai.temperature}
              onChange={(e) => updateSettings({ ai: { temperature: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Max tokens">
            <input
              className="input"
              type="number"
              min={16}
              max={4096}
              value={ai.maxTokens}
              onChange={(e) => updateSettings({ ai: { maxTokens: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Offline delay / word (ms)">
            <input
              className="input"
              type="number"
              min={0}
              max={200}
              value={ai.mockLatencyMs}
              onChange={(e) => updateSettings({ ai: { mockLatencyMs: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Concurrency">
            <input
              className="input"
              type="number"
              min={1}
              max={8}
              value={ai.concurrency}
              onChange={(e) => updateSettings({ ai: { concurrency: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Timeout (ms)">
            <input
              className="input"
              type="number"
              min={5000}
              step={1000}
              value={ai.requestTimeoutMs}
              onChange={(e) => updateSettings({ ai: { requestTimeoutMs: Number(e.target.value) } })}
            />
          </Row>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(e) => updateSettings({ ai: { enabled: e.target.checked } })}
            />
            AI on
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={ai.stream}
              onChange={(e) => updateSettings({ ai: { stream: e.target.checked } })}
            />
            stream tokens
          </label>
          {(['chat', 'memories', 'importance', 'reflections'] as const).map((key) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={(ai.useFor as any)[key]}
                onChange={(e) => updateSettings({ ai: { useFor: { [key]: e.target.checked } } as any})}
              />
              {key}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            className="btn btn-primary"
            disabled={probe.running}
            onClick={() => {
              setProbe({ running: true });
              void probeProvider().then((result) => setProbe({ running: false, ...result }));
            }}
          >
            {probe.running ? 'testing…' : '🔌 Test connection'}
          </button>
          {probe.detail && (
            <span className={`text-[11px] ${probe.ok ? 'text-green-300' : 'text-red-300'}`}>
              {probe.detail.slice(0, 180)}
            </span>
          )}
        </div>
      </Card>

      <Card title="Embeddings (memory search)">
        <Row label="Source">
          <select
            className="input"
            value={ai.embeddingSource}
            onChange={(e) =>
              updateSettings({ ai: { embeddingSource: e.target.value as any } })
            }
          >
            <option value="hash">local hash (offline, no download)</option>
            <option value="provider">provider /v1/embeddings</option>
            <option value="webgpu">in-browser (transformers.js)</option>
            <option value="off">off (rank by recency + importance)</option>
          </select>
        </Row>
        {ai.embeddingSource === 'provider' && (
          <>
            <Row label="Embedding model">
              <input
                className="input"
                value={ai.embeddingModel}
                onChange={(e) => updateSettings({ ai: { embeddingModel: e.target.value } })}
              />
            </Row>
            <Row label="Embedding base URL (optional)">
              <input
                className="input"
                placeholder={ai.baseUrl}
                value={ai.embeddingBaseUrl}
                onChange={(e) => updateSettings({ ai: { embeddingBaseUrl: e.target.value } })}
              />
            </Row>
            <Row label="Embedding key (optional)">
              <input
                className="input"
                type="password"
                value={ai.embeddingApiKey}
                onChange={(e) => updateSettings({ ai: { embeddingApiKey: e.target.value } })}
              />
            </Row>
          </>
        )}
        {ai.embeddingSource === 'webgpu' && (
          <Row label="Embedding model (HF repo)">
            <input
              className="input"
              value={ai.webgpu.embeddingModel}
              onChange={(e) => updateSettings({ ai: { webgpu: { embeddingModel: e.target.value } } })}
            />
          </Row>
        )}
        <p className="mt-2 text-[11px] opacity-70">
          Every embedding is cached in the <code>embeddingsCache</code> table, so a sentence costs at
          most one request per browser, ever.
        </p>
      </Card>

      <Card title="Simulation">
        <div className="grid grid-cols-2 gap-2">
          <Row label="Ticks / second">
            <input
              className="input"
              type="number"
              min={1}
              max={120}
              value={settings.sim.tickHz}
              onChange={(e) => updateSettings({ sim: { tickHz: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Autosave (ms)">
            <input
              className="input"
              type="number"
              min={250}
              step={250}
              value={settings.sim.saveIntervalMs}
              onChange={(e) => updateSettings({ sim: { saveIntervalMs: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Movement (tiles/s)">
            <input
              className="input"
              type="number"
              step={0.1}
              min={0.1}
              value={settings.sim.movementSpeed}
              onChange={(e) => updateSettings({ sim: { movementSpeed: Number(e.target.value) } })}
            />
          </Row>
          <Row label="Chat cooldown (ms)">
            <input
              className="input"
              type="number"
              step={1000}
              min={0}
              value={settings.sim.conversationCooldownMs}
              onChange={(e) => updateSettings({ sim: { conversationCooldownMs: Number(e.target.value) } })}
            />
          </Row>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.player.joinOnLoad}
            onChange={(e) => updateSettings({ player: { joinOnLoad: e.target.checked } })}
          />
          join the town as a player on load
        </label>
        <label className="mt-1 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.sim.autoStart}
            onChange={(e) => updateSettings({ sim: { autoStart: e.target.checked } })}
          />
          run the simulation immediately
        </label>
      </Card>

      <Card title="You">
        <Row label="Display name">
          <input
            className="input"
            value={settings.player.name}
            onChange={(e) => updateSettings({ player: { name: e.target.value } })}
          />
        </Row>
        <Row label="Sprite">
          <select
            className="input"
            value={settings.player.character}
            onChange={(e) => updateSettings({ player: { character: e.target.value } })}
          >
            {SPRITES.map((sprite) => (
              <option key={sprite.name} value={sprite.name}>
                {sprite.name}
              </option>
            ))}
          </select>
        </Row>
        <Row label="How others see you">
          <input
            className="input"
            value={settings.player.description}
            onChange={(e) => updateSettings({ player: { description: e.target.value } })}
          />
        </Row>
        <p className="mt-2 text-[11px] opacity-70">
          Applied live if you're already in the town (the panel updates as you type); otherwise when
          you next join. Your sprite sheet is one of the eight folk sheets in <code>assets/</code>.
        </p>
        <button className="btn mt-3 text-red-300" onClick={() => resetSettings()}>
          Reset all settings
        </button>
      </Card>
    </div>
  );
}

function useModelStatus() {
  const [, bump] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeModelStatus(() => bump((n) => n + 1));
    return () => {
      unsubscribe();
    };
  }, []);
  return getModelStatus();
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-brown-700 bg-brown-900/50 p-3">
      <h2 className="mb-2 font-display text-lg">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-xs">
      <span className="uppercase tracking-wide text-brown-200">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
