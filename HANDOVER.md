# Handover

State of the project at the point work was handed to another agent. Read this first, then
`docs/ARCHITECTURE.md` (the module contract) and `docs/briefs/` (the remaining work, split into packages).

## What this is

Browser tactical battle sandbox: three.js r170 + Rapier3D 0.14, static ES modules, no bundler.
`index.html` loads `battle_engine.js`; libraries come from the jsDelivr import map.

## Run and test

```
npm install                 # dev tooling only (asset pipeline, headless smoke runner)
npm start                   # http://127.0.0.1:8080/  (must be served over http, not file://)
npm run smoke               # headless regression: boots a match, fires, drives, flies an FPV
```

`npm run smoke` needs Chrome (`CHROME_BIN`, default `/usr/local/bin/google-chrome`). Graphics preset
and other settings can be forced from the URL: `?quality=low|medium|high|ultra&dynamicResolution=false`
(all keys of `SETTING_DEFAULTS` in `src/core/settings.js` work as query parameters).

## Done

1. **Engine split.** The original 2,373-line `battle_engine.js` is now a small kernel (state, boot, frame
   loop) plus per-system mixins under `src/` and 19 named feature-module slots registered in
   `src/modules.js`. The split was mechanical: gameplay behaviour is the original code.
2. **Kernel services** (`src/core/`): event bus, persisted settings with URL overrides, quality presets,
   key routing with priorities and virtual key presses, asset manager, pools, plus the seams the
   remaining features need: gameplay modifiers, control/look overrides, `getAimRay`, `getVehicleMuzzle`,
   `damagePlayer`, `damageVehicle` / `destroyVehicle`, `physics.spawnDebris`, the `animator.beginDeath`
   pre-death hook, `notify`, analog movement axes, and combat events (`shot`, `impact`, `explosion`,
   `unit:hit`, `unit:killed`, `vehicle:fired`, `vehicle:destroyed`, `order`).
3. **Asset pipeline** (`tools/optimize-assets.mjs`, `npm run assets`): weld + meshopt simplification,
   KTX2 textures at 512/1024 px (ETC1S colour, UASTC normals), mesh quantization and meshopt compression.
   The 20 models went from **107.1 MB to 23 MB**. Soldiers and weapons also carry baked LOD meshes
   (nodes with `userData.lod` 1/2, hidden at load).
4. **Loading**: meshopt + KTX2 decoding, Cache API persistence keyed by content hash
   (`individual_models/manifest.json`), and progressive streaming: soldiers, weapons and small
   fortifications block the start, vehicles/drones/trench stream in behind box placeholders.
5. **Quality presets** `low / medium / high / ultra / auto` (`src/core/quality.js`): pixel ratio cap,
   MSAA, shadow on/off + map size (1024 / 1024 / 2048 / 4096) + filter + camera-following shadow frustum,
   draw distance, texture mip skipping and anisotropy, and dynamic resolution scaling towards 30/60 FPS.
   The other preset fields (particles, decals, LOD distances, ragdolls, post-fx, audio) are budgets for
   modules that are not written yet.
6. **Tooling**: static dev server, headless smoke runner with scenarios and screenshots, a deterministic
   test hook `window.BATTLE_ENGINE.step(n, dt)`.

Verified: `npm run smoke` passes on this tree with no page errors (low preset). The high preset was
rendered once for a visual spot check of the simplified BMP-2 and trench. `medium` and `ultra` were never
run. The simplified T-72B3 and drone models were not inspected visually. Real devices and phones were
not tested; everything ran in software-rendered headless Chrome.

## Not done

**None of the feature list in sections 1-9 of the request is implemented yet** beyond the items above.
All 19 module files (`src/vfx/index.js`, `src/anim/index.js`, `src/ai/index.js`, ...) are empty stubs.
Concretely, the game still has: box particles, T-posed soldiers with sine-wave legs, instant raycast
bullets, a player who cannot be hurt, synthetic oscillator audio, no turret/wheel animation, no settings
menu, map, lobby or touch controls. There is no in-game UI for the graphics presets (URL parameter only),
and LOD meshes exist in the files but nothing switches to them at runtime.

The remaining work is specified as 14 packages in `docs/briefs/` (one brief each, written against
`docs/ARCHITECTURE.md`): `gfx`, `vfx`, `surface`, `audio`, `anim`, `fp`, `ballistics`, `health`,
`physics`, `vehrig`, `vehsys`, `ai`, `drones`, `ui`. Each lists the user's requirements verbatim, the
files it owns, design guidance and how to verify. `docs/briefs/RULES.md` holds the working rules they
were written for (parallel engineers in separate git worktrees); the `/tmp/hoplite/...` paths in it
belong to the previous sandbox and should be read as "your checkout". A parallel run of these packages
was started and stopped before anything was merged: no package code exists.

Suggested order if done sequentially: `physics` and `vehrig` (others build on them), `ballistics`,
`anim`, `vfx`, `gfx`, then `ai`, `vehsys`, `fp`, `health`, `surface`, `audio`, `drones`, `ui`.

## Things to know

- `raw_models/` (the 20 original GLBs, 107 MB) is git-ignored. To rebuild assets, unpack the six model
  archives into `raw_models/`, install the `ktx` CLI (KTX-Software >= 4.3) and run `npm run assets`.
- `tools/vehicle-rig.mjs` is a no-op placeholder for the turret / gun / wheel split (`vehrig` package).
  The vehicle GLBs are merged by material, not by part, so that split has to be geometric.
- Soldier GLBs are Mixamo rigs in T-pose with zero animation clips; clips must be authored in code or
  supplied as new assets.
- There are no audio files in the project.
- `STATS` vehicle masses are roughly ten times too light (T-90M is 4.8 t); the `physics` brief covers it.
- A regression frame is about 650 draw calls and 1.1 M triangles on `low`: every AI soldier carries a
  full-detail rifle and nothing is instanced yet.
- The KTX2 transcoder, three.js and Rapier load from jsDelivr, so the game needs network access.
- The smoke run logs one harmless 404 for `/favicon.ico`.

## Git

- `baseline`: the four original files exactly as uploaded.
- `hoplite/thourioi-0687076c`: this work. `git diff baseline` shows everything that changed.
