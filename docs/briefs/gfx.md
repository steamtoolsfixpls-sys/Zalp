# Package `gfx`: graphics presets, environment, LOD, post-processing

## You own
`src/world/environment.js` (`environment`), `src/world/lod.js` (`lod`), `src/gfx/**` (`postfx`),
`src/core/quality.js`, `src/core/assets.js`, the methods `setupLighting` and
`buildCleanPolygonFloorAndRamps` in `src/world/proving_ground.js`, `tools/optimize-assets.mjs` (not the
vehicle rig) and the non-vehicle GLBs in `individual_models/`.

## Requirements (user's words)
- "make ... graphics (low, medium, high, ultra)": four presets with real visual and performance
  differences, switchable at runtime through `engine.settings.set('quality', name)`.
- Dynamic Resolution Scaling targeting steady 30/60 FPS and reduced shadow map resolution (4096x4096 is
  too heavy for mobile GPUs; switch to 1024-2048 or culled Cascaded Shadow Maps).
- LOD and GPU instancing: swap soldiers/vehicles to low-poly LODs at 40-80 m and batch repeated
  fortifications into single draw calls.
- GLB compression, asset caching and progressive streaming already exist in the kernel
  (`tools/optimize-assets.mjs`, `src/core/assets.js`: 107 MB -> 23 MB, Cache API, priority tier): verify,
  polish, and take remaining cheap wins only.

## Current state and problems
- No environment map: metallic PBR materials render black. Flat grey background, flat dark floor with a
  debug grid, no fog. Shadows are disabled on `low`.
- A regression frame costs about 650 draw calls and 1.1 M triangles. Every AI soldier carries a
  full-detail rifle (AK-12 = 28k triangles each).
- Soldier and weapon GLBs contain baked LOD meshes: nodes with `userData.lod` = 0/1/2 (levels above 0 are
  hidden by `assets.js`). Weapon LOD 1/2 are the "world model" variants.

## Tasks, in priority order
1. `environment`: procedural sky (three/addons `Sky` or a gradient dome) aligned with `engine.sunLight`,
   a PMREM environment map generated from it for image-based lighting (`profile.lighting.envMap`; on low
   use a cheap ambient boost instead), distance fog matched to the horizon and `drawDistance`, a tiling
   procedural ground material (canvas-generated dirt/grass albedo and normal) instead of the flat colour.
   Keep the ground flat at y=0 and do not change collision. Hide or soften the debug grid. Aim for an
   overcast "bodycam" look; tune exposure so vehicles and soldiers read clearly.
2. `quality`: make every preset field real. Shadows: the frustum already follows the camera; fix
   acne/peter-panning per map size; cascades on ultra only if robust. On low add cheap blob shadows under
   soldiers and vehicles (one instanced quad batch). Verify the dynamic resolution logic, keep it from
   oscillating, expose the current scale.
3. `lod`: switch soldier meshes by camera distance using `profile.lod` with hysteresis and staggered
   updates (not every unit every frame); cull beyond `cullDistance`; stop shadow casting beyond
   `shadowCasterDistance`. Rifles carried by AI soldiers (`unit.root.userData.rifleMesh` and anything
   registered as `'worldWeapon'`) must never render LOD 0. Units are rebuilt on respawn (`unit.root` is
   replaced) and vehicles arrive late (`asset:ready`): handle both. Provide
   `engine.lod.register(object3D, kind)` and `engine.lod.levelOf(unit)`.
4. Instancing: collapse repeated static props (dragon's teeth x9, HESCO x6, pedestals) into instanced or
   batched draws where it is safe; the `surface` package may later make some of them destructible, so
   expose per-instance hide/show and do not touch colliders.
5. `postfx` (medium and above): EffectComposer from three/addons with subtle bloom (muzzle flashes, fire),
   vignette + film grain in one cheap pass, optional ambient occlusion on ultra if stable, OutputPass.
   Install through `window.BATTLE_ENGINE.setCustomRenderHook`. Handle resize and pixel-ratio changes. Low
   uses no composer.
6. A small FPS / resolution-scale readout when `settings.showFps` is on.

## Verify
Render the same viewpoints at all four presets (`views.mjs --query quality=<x>`), compare the images, and
report draw calls and triangles per preset from `renderer.info` as a table.
