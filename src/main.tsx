import React from 'react';
import { createRoot } from 'react-dom/client';
import 'react-toastify/dist/ReactToastify.css';
import './index.css';
import { localDB } from './local/db/local.ts';
import { SimRuntime } from './local/sim/runtime.ts';
import { TownProvider } from './local/state.tsx';
import App from './local/ui/App.tsx';

/**
 * Entry point for the fully-local build: open a handle on the browser
 * database, boot the simulation, and only then render (the UI reads from the
 * runtime synchronously, so it must exist first).
 */
async function boot() {
  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root element');
  const params = new URLSearchParams(window.location.search);
  const hideUI = params.get('hide_ui') === 'true';

  await localDB.init();
  const runtime = new SimRuntime();
  await runtime.init();

  if (hideUI) {
    container.innerHTML =
      '<div style="padding:2rem;font:14px ui-monospace,monospace;color:#cbb">simulating — add <b>?hide_ui=false</b> for the editor</div>';
  } else {
    createRoot(container).render(
      <React.StrictMode>
        <TownProvider runtime={runtime}>
          <App />
        </TownProvider>
      </React.StrictMode>,
    );
  }

  // Expose for debugging and automation (this is a local app: no API surface
  // other than the page itself).
  (window as unknown as { aiTown: unknown }).aiTown = {
    runtime,
    db: localDB,
    /** Force a synchronous save before closing/navigating. */
    save: () => localDB.flush(),
    status: () => runtime.status(),
    step: (ms?: number) => runtime.stepOnce(ms),
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'p' && e.shiftKey) {
      e.preventDefault();
      runtime.toggle();
    }
    if (e.key === 's' && e.shiftKey) {
      e.preventDefault();
      void localDB.flush();
    }
  });
}

void boot().catch((e) => {
  console.error('Failed to boot', e);
  const el = document.getElementById('root');
  if (el) {
    el.innerHTML = `<pre style="padding:1rem;color:#f88;font:13px ui-monospace,monospace;white-space:pre-wrap">AI Town (local) failed to start:\n${String(
      (e as Error).stack ?? e,
    )}</pre>`;
  }
});
