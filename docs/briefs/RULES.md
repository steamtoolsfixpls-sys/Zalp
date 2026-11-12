# Working rules for package engineers

You are one of ~14 engineers upgrading a browser tactical shooter in parallel (three.js r170 + Rapier3D
0.14, static ES modules, no bundler). Each engineer owns one package. The integrator merges all branches
afterwards, so the shared contract matters more than anything else.

## Workspace

- Your private git worktree is `/tmp/hoplite/wt/<pkg>` on local branch `agent/<pkg>` (created from the
  kernel commit). Work ONLY there. Never edit `/tmp/hoplite/workspace` (integration tree) or another
  engineer's worktree. Never push, never touch remotes, never create or switch branches or worktrees.
- `node_modules` is a symlink: do not run `npm install`; no new dependencies and no new CDN imports beyond
  the import map in `index.html`.
- Commit early and often on your branch (`git add -A && git commit -q -m "..."`). The final state must be
  committed with a clean `git status`; uncommitted work is lost.

## Read first

1. `docs/ARCHITECTURE.md` in your worktree: the contract (events, entities, module slots, stable methods,
   keys, ownership). Other packages are being written against it right now. Follow it exactly.
2. `battle_engine.js` (kernel), `src/modules.js`, the files you own, and whatever you call.
3. Your brief: `/tmp/hoplite/briefs/<pkg>.md`.

## Engineering rules

- You own the files named in your brief. Everything else is read-only, except a minimal hook (a few lines)
  when there is truly no other way; list every such edit in your report. Never edit `battle_engine.js`,
  `src/modules.js` or `docs/ARCHITECTURE.md`. If the contract lacks something, work within it and report
  the gap.
- Other packages' modules are STUBS in your worktree (for example `engine.vfx` is `{ name: 'vfx' }`) and
  become real after integration. Therefore: emit the documented events, call other modules only
  defensively (`engine.vfx?.explosion?.(...)`), and keep a sane fallback so your feature works alone.
- Keep the documented engine method names and signatures working. Restructure your own files freely.
- Performance target is low-end phones. No allocations in per-frame hot paths (reuse module-level temp
  vectors; pools and ring buffers from `src/core/pool.js`). Never create or dispose geometries, materials,
  textures, lights or DOM nodes per shot/particle/frame. Honour `engine.quality.profile` budgets and the
  `quality:changed` event.
- A missing model, bone, node or DOM element must never throw. Guard and degrade.
- Style: match the existing code (4-space indent, single quotes, semicolons, ES2022). Comments are brief
  and only for non-obvious intent. Player-facing text is Russian, like the existing HUD.
- Create your DOM and CSS from your module (under `engine.hudLayer`). Only the `ui` package edits
  `index.html`.

## Verification (required)

- `npm run smoke` (regression) must pass: no `[pageerror]`, `[console.error]` or `[smoke]` lines.
- Write `tools/scenarios/<pkg>.mjs` that exercises your features through `window.BATTLE_ENGINE.instance`
  and `window.BATTLE_ENGINE.step(n, dt)`, asserts outcomes (throw an Error on failure) and takes a few
  screenshots. Run it with
  `node tools/smoke.mjs tools/scenarios/<pkg>.mjs --out /tmp/shots/<pkg> --query "quality=low&dynamicResolution=false"`
  (use `quality=high` only when judging visuals).
- LOOK at your screenshots with the Read tool before claiming that a visual feature works.
- The machine has 2 CPU cores shared by all engineers and headless Chrome renders in software: a run
  takes 0.5-2 minutes and may wait for a free slot. Batch changes, test deliberately (about 25 browser
  runs in total), use `node --check file.js` for syntax, and put pure logic (math, tables, state machines)
  under Node tests in `tests/<pkg>.test.mjs` (`node --test tests/`) where that is cheaper than a browser.
- `tools/scenarios/views.mjs` renders free-camera viewpoints. Headless Chrome has no pointer lock: set
  `e.isPointerLocked = true` and call engine methods directly.

## Scope and time

Implement your brief in priority order. Prefer a complete, verified core over a broad untested surface.
Whatever you cannot finish or verify, leave cleanly disabled and report honestly. Aim for roughly
60-90 minutes of work.

## Final report (your last message, at most 450 words)

1. Requirement checklist: each brief bullet as done / partial / not done, with one line on how.
2. Files added or changed; hooks you added in files you do not own.
3. Public API, events emitted and consumed, keys bound, settings and quality fields used.
4. Verification: commands run, pass or fail, screenshot paths worth looking at.
5. Known issues and suggested follow-ups.
