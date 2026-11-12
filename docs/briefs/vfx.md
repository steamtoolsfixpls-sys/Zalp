# Package `vfx`: particles and effects

## You own
`src/vfx/**` except `decals.js`: `index.js` is the `vfx` module; `legacy_fx.js` is a mixin with
`spawnBrassCasing`, `spawnTracerBeam`, `spawnImpactParticles`, `updateEffects`. Keep those four method
names working as thin wrappers over the new system (other packages' legacy code calls them).

## Requirements (user's words)
- Replace primitive particle cubes (BoxGeometry) with sprite atlases / instanced billboards featuring
  fade-out animations, rotation, and velocity-based stretching.
- Multi-layered explosions (PG-7V / 125mm HE-FRAG / FPV): initial fireball sphere, rising plume of black
  smoke and dirt, scattering incandescent shrapnel with smoke trails, and a ground-hugging expanding
  shockwave dust ring.
- RPG-7V2 backblast: rear cone of flame and dust upon launch (the injury logic is `ballistics`').
- Complex muzzle flashes: star-shaped gas vents through the muzzle brake on the AK-12 / M4A1 / AK-74M and
  V-shaped blast from the T-90M muzzle brake with dynamic lighting on nearby objects.
- Blood: mist cloud on body penetration, directional exit-wound spray behind the target (pools and stains
  are `surface`'s decals).
- Burning and smoking vehicles: thick black diesel smoke plumes, flames shooting out of open hatches, and
  ammo cook-off spark fountains for 2-4 seconds prior to turret blowout.
- Armor sparks and ricochets: a shower of molten sparks when a round glances off sloped armor.
- ERA detonation visual: blow-off and flash of the struck brick.
- Smoke grenades and screens (Tucha launchers, RDG-2): dense expanding volumetric cloud dispersed by wind.
- Dust and mud trails from tracks and wheels at speed (persistent marks are `surface`'s).
- Rocket and missile contrails: dense grey smoke trail behind RPG-7 rockets and Javelin ATGMs.
- Tactical laser designators and flashlights: green laser beam visible through smoke, laser dot projected
  onto the target, weapon-mounted flashlight beam (`P` laser, `L` flashlight).
- Spalling debris, wood splinters, concrete chunks chipping off HESCO and Dragon's Teeth under autocannon
  fire.
- Belt link ejection and smoking brass casings with realistic spin, and wisps of propellant smoke.
- Object pooling: no runtime `new` / `dispose()` in combat; preallocated ring buffer / InstancedMesh pool.

## Design guidance
- One GPU-instanced billboard system: an instanced quad with a ShaderMaterial; per-instance attributes
  (position, velocity for stretch, size, rotation, colour/alpha, atlas frame, age/life) live in
  preallocated typed arrays used as a ring buffer. CPU simulation with gravity, drag, buoyancy, wind
  (`engine.wind`), size and alpha over life. Two draw calls (alpha-blended and additive). The sprite atlas
  is generated on a canvas at startup (several soft smoke puffs, flame, spark streak, dust, blood mist,
  debris chip, glow, shockwave ring): no image files exist. Budget and emission scale come from
  `quality.particles`.
- Dynamic lights: a fixed pool of PointLights created at install with intensity 0
  (`lighting.maxDynamicLights`). Adding or removing lights at runtime recompiles every shader.
- Tracers: an instanced pool of stretched quads. `bulletTracer()` returns `{ set(pos, vel), release() }`
  for physical bullets; `tracer({ from, to, color })` is the instant beam.
- Casings: an InstancedMesh pool (rifle brass, belt links, 30 mm) with ballistic motion, ground bounce and
  spin; emit `casing:bounce`.
- Smoke screens: persistent cloud objects fed over their lifetime, drifting and thinning with wind. Keep
  `engine.vfx.smokeClouds` (`{ pos, radius, density }`) and `smokeDensity(a, b)` (0..1 along a segment)
  for AI vision.
- Vehicle fire and dust: use `vehicle.chassisPos/chassisQuat`, `vehicle.suspPoints[i].local/grounded`,
  `vehicle.speedKmh`; hatch positions from `vehicle.parts?.hatches` when present.
- Laser and flashlight: mounted on the player's weapon (`engine.viewmodelRoot` / camera). The flashlight
  SpotLight is created once at install. The laser end point comes from `engine.raycaster` against
  `engine.staticShootableMeshes` and `engine.physics.hitboxMeshes`.
- Subscribe to: `explosion`, `impact`, `shot`, `vehicle:fired`, `launch`, `unit:hit`, `vehicle:hit`,
  `vehicle:destroyed`, `vehicle:module`, `era:detonated`, `smoke:deployed`. Legacy code may both call
  `spawnImpactParticles` and emit `impact` for the same hit: avoid doubled effects.
- Public API is listed in `docs/ARCHITECTURE.md` (module slots table): implement those names.

## Verify
Screenshots at `quality=high`: an explosion at three moments, a muzzle flash, a burning vehicle, a smoke
screen after 10 s, tracers in flight. Report particle counts and draw calls. Confirm that a long firefight
allocates no geometries or materials (`renderer.info.memory` stays flat).
