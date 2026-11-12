# Package `drones`: FPV, Mavic bomber, electronic warfare

## You own
`src/drones/**`: `index.js` (`droneOps` module) and `drones.js` (mixin: `spawnAutonomousDrones`,
`togglePlayerFpvDrone`, `exitPlayerFpvDrone`, `detonatePlayerFpvDrone`, `updatePlayerFpvFlight`,
`updateAutonomousDrones`).

## Requirements (user's words)
- Acro-mode aerodynamics and ground effect: true 4-motor FPV quadcopter physics, unstabilized dive
  angles, high-RPM propeller vibration, and spinning rotor motion-blur discs.
- DJI Mavic 3 bomber mode: hovering at 50-100 m altitude, switching to a downward nadir drop camera with
  wind-drift reticle, and dropping VOG-17/grenades into tank hatches or trenches.
- Dome EW jammers and trench electronic warfare: signal degradation and loss-of-control zones when an FPV
  drone closes within range of an EW-equipped T-90M or trench jammer (exposing hooks for future glitch
  shaders).
- Enemy/allied EW operators, anti-drone rifles, and small-arms interception: a physical hitbox on flying
  FPV drones allowing infantry to shoot them down with AK-12 bursts.
- Pre-launch warhead selection: shaped-charge PG-7VL anti-armor / thermobaric / high-explosive
  fragmentation with ball bearings against trench infantry.
- Post-impact recon cut: automatic 1.5 s static frame / feed switch to an overhead Mavic 3 observing the
  impact site right after the FPV video link cuts out on detonation.

## Design guidance
- FPV flight (rate mode): state is position, velocity, orientation quaternion and angular rates. Mouse
  commands pitch and roll (or yaw) rates, A/D the remaining axis, W/S move a persistent throttle, Space
  punches. Thrust acts along the body's up axis as the sum of four motors with command mixing and a short
  spool lag; gravity; quadratic drag; ground effect (up to about 25 % extra thrust within half a rotor
  span of the ground or a roof); camera uptilt of about 30 degrees; vibration and battery sag scaling
  with RPM; impact fuse on contact, manual detonation with LMB. Pick a mapping that is actually flyable
  with mouse and keyboard and keep `settings.fpvSensitivity`. Keep the legacy `engine.fpvMode` fields
  alive (`active, position, velocity, yaw, pitch, roll, battery, droneMesh, droneType, motorAudio`):
  other code reads them. Rotor discs: four pooled translucent discs at the motor positions whose opacity
  follows RPM (the FPV model is a single mesh: derive motor positions from its bounds).
- Lancet [N]: keep the existing fixed-wing behaviour, tidied.
- Warhead selection: a compact pre-launch panel on [V] (1 кумулятивная ПГ-7ВЛ, 2 термобарическая, 3
  осколочно-фугасная с шариками; launch with Enter / LMB / [V] again; Esc cancels) that remembers the
  last choice. The warhead changes the detonation: always call
  `engine.triggerHighExplosiveBlast(pos, radius, force, damage, label, opts)` with
  `opts = { kind, warhead, fragments, attacker, faction }`, and for the shaped charge also
  `engine.damageVehicle(vehicle, { ..., ammo: 'fpv_heat', penetrated })` on a direct vehicle hit.
- Registry: `engine.droneOps.drones[]` holds every flying drone, player and NPC: `{ id, kind:
  'fpv'|'lancet'|'mavic', faction, pos, vel, radius, hp, isPlayer, mesh }`. The ballistics package tests
  bullets against these spheres and calls `damageDrone(drone, amount, attacker)`; a killed drone falls or
  explodes and emits `drone:destroyed`. Emit `drone:launched` and, when an enemy FPV starts its dive, a
  `callout` `{ key: 'air_fpv' }`.
- NPC drones: move the existing kamikaze, Lancet and recon Mavic onto the registry. An NPC Mavic that
  sees enemy units or vehicles emits `recon:spotted` `{ pos, kind, faction, ttl }`.
- Mavic 3 bomber [U] for the player: climb to about 60 m above the player; WASD moves horizontally
  (position hold), Space / C change altitude (20-120 m), the mouse turns and tilts the gimbal; [K]
  toggles the nadir camera (zoom with the wheel or [Z]); the reticle shows the predicted impact point for
  the current altitude, munition drag and `engine.wind`; LMB drops one of four VOG-17 rounds that fall
  physically (gravity and wind) and explode on contact, with a top-armor bonus when they land on a
  turret roof; [U] again recalls it. Use `engine.controlOverride` and `engine.lookOverride` for control
  and camera and hide the viewmodel.
- EW: jammers `{ pos | vehicle, radius, power, faction }`: a dome jammer on T-90M tanks (about 45 m) and
  a trench jammer near the UA line protect their own side. `jamLevelAt(pos, faction)` gives 0..1. On the
  player's drone it adds video noise, attenuates and delays control, and at full strength cuts the link
  (the drone flies on ballistically). Expose `engine.droneOps.signal = { quality, jam }`, emit
  `drone:jammed`, draw a static overlay now and offer `droneOps.onGlitch(fn)` for future shaders. One
  soldier per faction carries an anti-drone rifle (`unit.ewGun = true`, set by you at install): with an
  enemy drone inside 150 m and in sight he jams it directionally for a few seconds and it drifts and
  sinks.
- Recon cut: when the player's FPV detonates or loses link, hold a static-noise frame for 1.5 s, cut to
  an overhead view about 45 m above the impact for roughly 3.5 s, then return control. Any key skips it.
- Create extra OSD elements under `engine.hudLayer`; the existing `#fpv-osd` ids stay in use.

## Verify
A scenario: launch an FPV with each warhead and compare the blast effects; fly into the T-90M jammer
zone and assert that signal quality falls and control degrades; assert `droneOps.drones` contains the
player drone and that `damageDrone` brings it down; run the recon cut; fly the Mavic, drop a VOG-17 and
assert the impact lands near the reticle prediction. Screenshots of the FPV OSD with static, the nadir
camera with its reticle, and the recon cut.
