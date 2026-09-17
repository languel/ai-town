import { useEffect, useId, useMemo, useState } from 'react';
import {
  builtinChoices,
  isStale,
  readModelList,
  describeChoice,
  refreshModelList,
  refreshServerModels,
  type ModelChoice,
  type ServerModel,
} from '../ai/modelList.ts';
import { fetchModelDetail, formatBytes, type ModelDetail } from '../ai/hub.ts';

type Slot = 'chat' | 'embeddings' | 'server';

/**
 * Free-text model field with a live list behind it.
 *
 * Typing narrows the `<datalist>` the way a browser combobox should, `Refresh`
 * re-reads the source (hub scan for the in-browser provider, your own server's
 * model endpoint for the HTTP ones), and the chips under the input show which
 * precisions that repo actually publishes - which is how you discover that
 * LFM2.5 needs q4 and not the q8 we used to always ask for.
 */
export default function ModelField({
  slot,
  value,
  onSelect,
  dtype,
  onDtype,
  placeholder,
}: {
  slot: Slot;
  value: string;
  onSelect: (id: string) => void;
  /** Only for the in-browser slots: passing this enables the precision chips. */
  dtype?: string;
  onDtype?: (dtype: string) => void;
  placeholder?: string;
}) {
  const listId = useId();
  const [hubChoices, setHubChoices] = useState<ModelChoice[]>(() =>
    slot === 'server' ? [] : builtinChoices(slot === 'chat' ? 'text-generation' : 'feature-extraction'),
  );
  const [serverModels, setServerModels] = useState<ServerModel[]>([]);
  const [meta, setMeta] = useState<{ fetchedAt?: number; offline?: boolean; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ loading: boolean; data?: ModelDetail; error?: string }>({
    loading: false,
  });

  // Start from whatever the last scan left in localStorage, and quietly re-scan
  // in the background if that scan is more than a day old.
  useEffect(() => {
    if (slot === 'server') return;
    const cached = readModelList();
    if (cached) {
      const next = slot === 'chat' ? cached.chat : cached.embeddings;
      if (next?.length) setHubChoices(next);
      setMeta({ fetchedAt: cached.fetchedAt, offline: cached.offline, error: cached.error });
    }
    if (cached && !isStale(cached)) return;
    let cancelled = false;
    void refreshModelList().then((list) => {
      if (cancelled) return;
      const next = slot === 'chat' ? list.chat : list.embeddings;
      if (next?.length) setHubChoices(next);
      setMeta({ fetchedAt: list.fetchedAt, offline: list.offline, error: list.error });
    });
    return () => {
      cancelled = true;
    };
  }, [slot]);

  const choices = useMemo<ModelChoice[]>(() => {
    if (slot === 'server') {
      return serverModels.map((m) => ({
        id: m.id,
        label: m.label,
        source: 'server',
        task: 'text-generation',
        note: [m.note, m.bytes ? formatBytes(m.bytes) : null].filter(Boolean).join(' · '),
      }));
    }
    const trimmed = value.trim().toLowerCase();
    // Built-in entries come first, then hub hits the catalogue does not know.
    const merged = new Map<string, ModelChoice>();
    for (const choice of hubChoices) if (!merged.has(choice.id)) merged.set(choice.id, choice);
    return [...merged.values()]
      .filter((c) => !trimmed || c.id.toLowerCase().includes(trimmed) || c.label.toLowerCase().includes(trimmed))
      .slice(0, 120);
  }, [slot, hubChoices, serverModels, value]);

  async function refresh() {
    setBusy(true);
    try {
      if (slot === 'server') {
        const result = await refreshServerModels();
        setServerModels(result.models);
        setMeta({ error: result.error, offline: result.models.length === 0 });
      } else {
        const list = await refreshModelList({ force: true });
        const next = slot === 'chat' ? list.chat : list.embeddings;
        setHubChoices(next);
        setMeta({ fetchedAt: list.fetchedAt, offline: list.offline, error: list.error });
      }
    } finally {
      setBusy(false);
    }
  }

  // Precision chips: one hub call per selected repo, cached by the hub client.
  useEffect(() => {
    if (!onDtype || slot === 'server') return;
    const id = value.trim();
    if (!id || !id.includes('/')) {
      setDetail({ loading: false });
      return;
    }
    let cancelled = false;
    setDetail({ loading: true });
    fetchModelDetail(id)
      .then((data) => !cancelled && setDetail({ loading: false, data }))
      .catch((e: any) => !cancelled && setDetail({ loading: false, error: e?.message ?? String(e) }));
    return () => {
      cancelled = true;
    };
  }, [value, slot, onDtype]);

  const selected = choices.find((c) => c.id === value.trim());

  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1">
        <input
          className="input w-full"
          list={listId}
          value={value}
          placeholder={placeholder ?? 'org/model'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onSelect(e.target.value)}
        />
        <button className="btn whitespace-nowrap" onClick={() => void refresh()} disabled={busy}>
          {busy ? 'scanning…' : 'Refresh list'}
        </button>
      </div>
      <datalist id={listId}>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {[choice.label !== choice.id ? choice.label : null, choice.note]
              .filter(Boolean)
              .join(' — ')}
          </option>
        ))}
      </datalist>
      <p className="text-[11px] opacity-70">
        {slot === 'server'
          ? `${choices.length} model(s) reported by this server`
          : `${choices.length} model(s): built-in + hub scan`}
        {meta.fetchedAt ? `, updated ${new Date(meta.fetchedAt).toLocaleString()}` : ''}
        {meta.offline && slot !== 'server' ? ' · hub unreachable, showing built-in list' : ''}
        {meta.error ? ` · ${meta.error}` : ''}
      </p>
      {selected && (
        <p className="text-[11px] opacity-80">
          {[describeChoice(selected), selected.note].filter(Boolean).join(' - ')}
        </p>
      )}
      {selected && !selected.supported && (
        <p className="text-[11px] text-[#e6b450]">{selected.note ?? 'Not drivable by the town yet.'}</p>
      )}

      {onDtype && slot !== 'server' && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          <span className="opacity-70">precision:</span>
          <button
            className={`chip ${!dtype || dtype === 'auto' ? 'chip-on' : ''}`}
            onClick={() => onDtype('auto')}
            title="Look up the repo and take the smallest export this device can run"
          >
            auto
          </button>
          {(detail.data?.variants ?? []).map((variant) => (
            <button
              key={variant.dtype}
              className={`chip ${dtype === variant.dtype ? 'chip-on' : ''} ${
                variant.webgpuSafe ? '' : 'chip-warn'
              }`}
              onClick={() => onDtype(variant.dtype)}
              title={[
                variant.entry,
                variant.bytes ? formatBytes(variant.bytes) : null,
                variant.sharded ? 'multi-part weights' : null,
                variant.webgpuSafe ? null : 'no WebGPU kernels for this export',
                variant.legacyQuantized ? 'legacy model_quantized.onnx naming' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {variant.dtype} {variant.bytes ? formatBytes(variant.bytes) : ''}
            </button>
          ))}
          {detail.loading && <span className="opacity-60">checking repo…</span>}
          {!detail.loading && detail.error && (
            <span className="opacity-60" title={detail.error}>
              repo not reachable
            </span>
          )}
          {selected?.dtype && !detail.data && (
            <span className="opacity-60">built-in suggestion: {selected.dtype}</span>
          )}
        </div>
      )}
    </div>
  );
}
