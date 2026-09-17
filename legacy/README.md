# legacy/

The original Convex-backed client (`src/App.tsx`, `src/components`, `src/hooks`) kept for
reference after the local rewrite. Nothing here is built or typechecked: `tsconfig.json`
and `vite.config.ts` exclude it, and `index.html` enters through `src/main.tsx` →
`src/local/` instead.

Ports of these files that ARE live: `src/local/ui/*` (Pixi renderer, viewport, chat UI)
and `src/local/engine/*` (the `convex/aiTown` + `convex/engine` game logic, now running in
the browser).
