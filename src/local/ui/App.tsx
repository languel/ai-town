import { useState } from 'react';
import { useSettings, useTown } from '../state.tsx';
import TownView from './TownView.tsx';
import PersonalityEditor from './PersonalityEditor.tsx';
import MapEditor from './MapEditor.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import DataPanel from './DataPanel.tsx';
import MemoryPanel from './MemoryPanel.tsx';
import type { GameId } from '../engine/ids.ts';

type Tab = 'town' | 'cast' | 'map' | 'memory' | 'data' | 'settings';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'town', label: '🏠 Town', hint: 'The living simulation' },
  { id: 'cast', label: '🎭 Personalities', hint: 'Agents, prompts, goals' },
  { id: 'map', label: '🗺️ Map', hint: 'Paint the world' },
  { id: 'memory', label: '🧠 Memories', hint: 'What the agents remember' },
  { id: 'data', label: '💾 Data', hint: 'Import / export / wipe' },
  { id: 'settings', label: '⚙️ Model', hint: 'Inference + simulation' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('town');
  const [selected, setSelected] = useState<GameId<'players'> | undefined>();
  const { status, runtime } = useTown();
  const settings = useSettings();

  return (
    <div className="flex h-screen flex-col bg-brown-900 font-body text-brown-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-brown-700 bg-brown-800 px-3 py-2">
        <h1 className="mr-2 font-display text-2xl leading-none">
          <span className="game-title">AI Town</span>
          <span className="ml-1 align-super text-[10px] uppercase tracking-widest text-brown-200">
            local
          </span>
        </h1>
        <nav className="flex flex-wrap gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              title={entry.hint}
              onClick={() => setTab(entry.id)}
              className={`rounded px-2 py-1 text-sm ${
                tab === entry.id ? 'bg-clay-500 text-white' : 'bg-brown-900/50 hover:bg-brown-900'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          <StatusChip
            tone={status.status === 'running' ? 'good' : status.status === 'error' ? 'bad' : 'warn'}
            label={
              status.status === 'running'
                ? `simulating ${new Date(status.currentTime).toLocaleTimeString()}`
                : status.status === 'error'
                  ? `error: ${status.error}`
                  : 'paused'
            }
          />
          <StatusChip
            tone={settings.ai.enabled ? 'info' : 'warn'}
            label={`${settings.ai.provider}${
              settings.ai.provider === 'mock' ? '' : ` · ${settings.ai.chatModel || settings.ai.webgpu.chatModel}`
            }`}
          />
          <StatusChip
            tone={status.activeOps ? 'info' : 'muted'}
            label={`model: ${status.activeOps} active${status.queuedOps ? `, ${status.queuedOps} queued` : ''}${
              status.lastLlmMs ? `, last ${Math.round(status.lastLlmMs)}ms` : ''
            }`}
          />
          <StatusChip
            tone={runtime.llmCalls ? 'muted' : 'muted'}
            label={`${runtime.llmCalls} calls`}
          />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_0%,#2b2f4a,#141521_60%)]">
        {tab === 'town' && <TownView selectedPlayerId={selected} onSelectPlayer={setSelected} />}
        {tab === 'cast' && <PersonalityEditor />}
        {tab === 'map' && <MapEditor />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'data' && <DataPanel />}
        {tab === 'settings' && <SettingsPanel />}
      </main>
    </div>
  );
}

function StatusChip({ label, tone }: { label: string; tone: 'good' | 'bad' | 'warn' | 'info' | 'muted' }) {
  const colors = {
    good: 'bg-green-900/60 text-green-200',
    bad: 'bg-red-900/70 text-red-200',
    warn: 'bg-amber-900/60 text-amber-200',
    info: 'bg-sky-900/60 text-sky-200',
    muted: 'bg-brown-900/60 text-brown-200',
  } as const;
  return (
    <span className={`rounded px-2 py-0.5 font-system ${colors[tone]}`} title={label}>
      {label.length > 44 ? `${label.slice(0, 41)}…` : label}
    </span>
  );
}
