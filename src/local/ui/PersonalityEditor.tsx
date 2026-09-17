import { useMemo, useState } from 'react';
import { useDbRevision, useRuntime, useSettings, useTown } from '../state.tsx';
import { localDB } from '../db/local.ts';
import type { CharacterDoc } from '../db/schema.ts';
import type { CharacterDef } from '../engine/descriptions.ts';
import { characters as SPRITES } from '../data/characters.ts';
import {
  DEFAULT_PROMPTS,
  PROMPT_HINTS,
  PROMPT_KEYS,
  PROMPT_LABELS,
  PROMPT_VARIABLES,
  getPrompts,
  isPromptModified,
  resetPrompts,
  setPrompt,
} from '../ai/prompts.ts';
import { chatCompletion } from '../ai/chat.ts';
import { downloadPrompts, uploadPrompts } from '../db/transfer.ts';
import { uuid } from '../engine/object.ts';

/**
 * Personality editor. Edits the cast list (IndexedDB `characters`), which the
 * engine spawns/despawns as players + agents, plus the shared prompt templates.
 */
export default function PersonalityEditor() {
  const runtime = useRuntime();
  useDbRevision();
  const settings = useSettings();
  const { game } = useTown();
  const cast = useMemo(() => localDB.all<CharacterDoc>('characters'), [useDbRevision()]);
  const [editing, setEditing] = useState<string | null>(cast[0]?._id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPrompts, setShowPrompts] = useState(false);

  const spawnState = (id: string) => {
    const playerId = [...game.castIds.entries()].find(([, castId]) => castId === id)?.[0];
    return playerId ? { playerId, present: game.world.players.has(playerId) } : { playerId: undefined, present: false };
  };

  const save = async (def: CharacterDef) => {
    setBusy(def.id);
    try {
      await runtime.upsertCharacter(def);
    } finally {
      setBusy(null);
    }
  };

  const addAgent = () => {
    const id = `cast-${uuid().slice(0, 8)}`;
    const def: CharacterDef = {
      id,
      name: 'New agent',
      description: 'New agent is new here.',
      identity: 'New agent is polite, curious, and a little shy.',
      plan: 'You want to make one friend.',
      character: SPRITES[Math.floor(Math.random() * SPRITES.length)].name,
      enabled: true,
    };
    localDB.put<CharacterDoc>('characters', { ...def, _id: id } as CharacterDoc);
    setEditing(id);
  };

  const remove = async (id: string) => {
    await runtime.removeCharacter(id);
    setEditing((current) => (current === id ? null : current));
  };

  return (
    <div className="mx-auto grid max-w-[1400px] gap-4 p-4 lg:grid-cols-[280px_1fr]">
      <aside className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl">Cast</h2>
          <button className="btn" onClick={() => void addAgent()}>
            + Add
          </button>
        </div>
        <p className="text-xs text-brown-200">
          Stored in the <code>characters</code> table (IndexedDB). Saving respawns the agent with the
          new personality; disabling them walks them out of the world.
        </p>
        <ul className="flex flex-col gap-1">
          {cast.map((doc) => {
            const state = spawnState(doc._id);
            return (
              <li key={doc._id}>
                <button
                  onClick={() => setEditing(doc._id)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm ${
                    editing === doc._id ? 'bg-clay-700' : 'bg-brown-900/40 hover:bg-brown-900/70'
                  }`}
                >
                  <span className="truncate">{doc.name}</span>
                  <span className="text-[10px] uppercase opacity-70">
                    {doc.enabled ? (state.present ? 'in town' : 'off-stage') : 'disabled'}
                  </span>
                </button>
              </li>
            );
          })}
          {cast.length === 0 && <li className="text-sm opacity-70">Empty cast.</li>}
        </ul>
        <div className="mt-2 flex gap-2">
          <button
            className="btn"
            onClick={() =>
              void runtime
                .sendInput('join', {
                  name: settings.player.name,
                  character: settings.player.character,
                  description: settings.player.description,
                  human: 'human:me',
                })
                .catch(() => null)
            }
          >
            + You
          </button>
          <button className="btn" onClick={() => setShowPrompts((v) => !v)}>
            {showPrompts ? 'Hide prompts' : 'Edit prompts'}
          </button>
        </div>
      </aside>

      <div className="flex flex-col gap-4">
        {showPrompts && <PromptEditor />}
        {editing ? (
          cast
            .filter((doc) => doc._id === editing)
            .map((doc) => (
              <CharacterCard
                key={doc._id}
                initial={doc}
                busy={busy === doc._id}
                onGenerate={async (seed) => {
                  setBusy(doc._id);
                  try {
                    const content = await chatCompletion({
                      messages: [
                        {
                          role: 'system',
                          content:
                            'You write character bibles for a life-sim. Reply with three sections, each prefixed exactly: "NAME:", "DESCRIPTION:", "IDENTITY:", "PLAN:". Keep IDENTITY under 500 characters and PLAN a short sentence starting with "You want to".',
                        },
                        { role: 'user', content: `Character seed: ${seed}` },
                      ],
                      maxTokens: 400,
                      context: { kind: 'generic', input: seed },
                    });
                    const grab = (label: string) => {
                      const match = content.match(new RegExp(`${label}:\\s*([^\\n]+(?:\\n(?!NAME:|DESCRIPTION:|IDENTITY:|PLAN:)[^\\n]+)*)`, 'i'));
                      return match?.[1]?.trim();
                    };
                    return {
                      name: grab('NAME') ?? doc.name,
                      description: grab('DESCRIPTION') ?? doc.description,
                      identity: grab('IDENTITY') ?? doc.identity,
                      plan: grab('PLAN') ?? doc.plan,
                    };
                  } finally {
                    setBusy(null);
                  }
                }}
                onSave={(def) => void save(def)}
                onDelete={() => void remove(doc._id)}
              />
            ))
        ) : (
          <p className="p-6 text-sm opacity-70">Pick someone on the left to edit.</p>
        )}
      </div>
    </div>
  );
}

function CharacterCard({
  initial,
  busy,
  onSave,
  onDelete,
  onGenerate,
}: {
  initial: CharacterDoc;
  busy: boolean;
  onSave: (def: CharacterDef) => void;
  onDelete: () => void;
  onGenerate: (seed: string) => Promise<Partial<CharacterDef>>;
}) {
  const [def, setDef] = useState<CharacterDef>(() => stripDoc(initial));
  const [seed, setSeed] = useState('');
  const dirty = JSON.stringify(def) !== JSON.stringify(stripDoc(initial));
  const set = <K extends keyof CharacterDef>(key: K, value: CharacterDef[K]) =>
    setDef((current) => ({ ...current, [key]: value }));

  return (
    <section className="rounded border border-brown-700 bg-brown-900/40 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-display text-2xl">{def.name || '…'}</h3>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={def.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          in town
        </label>
        <label className="flex items-center gap-1 text-xs">
          sprite
          <select
            className="rounded bg-brown-800 px-1 py-0.5 text-xs"
            value={def.character}
            onChange={(e) => set('character', e.target.value)}
          >
            {SPRITES.map((sprite) => (
              <option key={sprite.name} value={sprite.name}>
                {sprite.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            if (!seed.trim()) return;
            void onGenerate(seed).then((patch) => setDef((current) => ({ ...current, ...patch })));
          }}
        >
          {busy ? '…' : '✨ Draft with model'}
        </button>
        <button className="btn" onClick={onDelete}>
          🗑
        </button>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" hint="Shown above the sprite and in chat.">
          <input className="input" value={def.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field
          label="Public description"
          hint="What the UI (and other players) see; fed to nobody unless you reference it."
        >
          <input
            className="input"
            value={def.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field label="Identity / personality" hint="Becomes “About you: …” in every prompt.">
          <textarea
            className="input min-h-[140px] font-system"
            value={def.identity}
            onChange={(e) => set('identity', e.target.value)}
          />
        </Field>
        <Field label="Plan / goal" hint="What they steer conversations toward.">
          <textarea
            className="input min-h-[70px] font-system"
            value={def.plan}
            onChange={(e) => set('plan', e.target.value)}
          />
        </Field>
        <Field label="Style notes (optional)" hint="Appended to the system prompt: tone, taboos, catchphrases.">
          <textarea
            className="input min-h-[70px] font-system"
            value={def.styleNotes ?? ''}
            onChange={(e) => set('styleNotes', e.target.value)}
          />
        </Field>
        <Field label="Prompt seed for ✨ Draft" hint="e.g. “a paranoid lighthouse keeper who loves puns”.">
          <input className="input" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </Field>
      </div>

      <footer className="mt-3 flex items-center gap-2">
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => onSave(def)}>
          Save & respawn
        </button>
        <button className="btn" disabled={!dirty} onClick={() => setDef(stripDoc(initial))}>
          Revert
        </button>
        <span className="text-xs opacity-70">{dirty ? 'unsaved changes' : 'saved'}</span>
      </footer>
    </section>
  );
}

function stripDoc(doc: CharacterDoc): CharacterDef {
  const { _id, _creationTime, ...rest } = doc as any;
  return { ...rest, id: doc._id };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-brown-200">{label}</span>
      {children}
      {hint && <span className="text-[11px] opacity-60">{hint}</span>}
    </label>
  );
}

export function PromptEditor() {
  const prompts = getPrompts();
  const [draft, setDraft] = useState<Record<string, string>>(prompts);
  return (
    <section className="rounded border border-brown-700 bg-brown-900/40 p-4">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-display text-xl">Prompt templates</h3>
        <button className="btn" onClick={() => void downloadPrompts()}>
          ⬇ Export
        </button>
        <label className="btn cursor-pointer">
          ⬆ Import
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadPrompts(file).then(() => window.location.reload());
            }}
          />
        </label>
        <button
          className="btn"
          onClick={() => {
            resetPrompts();
            setDraft(DEFAULT_PROMPTS);
          }}
        >
          Reset to defaults
        </button>
      </header>
      <div className="grid gap-3 lg:grid-cols-2">
        {PROMPT_KEYS.map((key) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-brown-200">
              {PROMPT_LABELS[key]}
              {isPromptModified(key) && <em className="ml-1 normal-case text-brown-300">(edited)</em>}
            </span>
            <span className="text-[11px] opacity-60">{PROMPT_HINTS[key]}</span>
            <span className="text-[11px] opacity-60">
              vars: {PROMPT_VARIABLES[key].map((v) => `{{${v}}}`).join(' ')}
            </span>
            <textarea
              className="input min-h-[150px] font-system text-[12px]"
              value={draft[key] ?? ''}
              onChange={(e) => {
                setDraft({ ...draft, [key]: e.target.value });
                setPrompt(key, e.target.value);
              }}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
