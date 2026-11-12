# Package `vehsys`: vehicle damage modules, gunnery, crew AI

## You own
`src/vehicles/systems.js` (`vehicleSystems`), `src/vehicles/crew_ai.js` (`crewAi`),
`src/vehicles/gameplay.js` (mixin) and new files in `src/vehicles/` other than `parts.js`.

## Requirements (user's words)
- Modular vehicle damage: knocked-out track, blown-out BTR tires, jammed turret traverse, shattered
  optics triplex, and engine bay fires (you own the damage state; the physics package applies the
  driving effects from `vehicle.mobility`).
- Ammo cook-off for 2-4 seconds prior to turret blowout.
- Smoke screens: TDA / "Tucha" 3D6 launchers on APCs/tanks ([J]).
- Authentic vehicle gunner optics HUD: hull-to-turret orientation indicator, laser rangefinder readout,
  loaded shell type, 125mm autoloader cycle timer, and live status of all mounted desant seats.
- "Sosna-U" ballistic reticle with magnification toggle inside tanks ([Z]).
- Smart armored crew AI: BTR-80/Bradley units maneuver between cover, pop smoke when targeted by RPGs,
  and hold overwatch fire-support positions after dismounting infantry.
- Opening rear BMP-2 doors / Bradley ramp / BTR-80 side hatches ([O]) with infantry leaving through them.

## Design guidance
- `vehicle.modules = { trackL, trackR, tires[], turret, gun, optics, engine, ammo }`, each `'ok' |
  'damaged' | 'destroyed'` (turret may be `'jammed'`). `vehicleSystems.applyHit(vehicle, hit)` is called
  by `engine.damageVehicle` (`hit: { amount, pos, dir, zone, penetrated, ammo, kind, attacker }`): pick a
  module from the hit position in vehicle space (rear -> engine, low sides -> track or tire, ring ->
  turret traverse, front top -> optics, hull centre -> ammo) with chances that grow with damage and
  penetration; mines (`kind: 'mine'`) take tracks or tires. Emit `vehicle:module` on every change and
  write `vehicle.mobility = { trackL, trackR, tires: [...], engine }` (1..0) for the physics package.
  Until that package lands, also apply a simple fallback yourself (bias `controls.steer`, scale
  `controls.throttle`) and say so in the report.
- Effects of modules: a destroyed or jammed turret stops traversing (the rig package reads
  `vehicle.modules.turret`); destroyed optics crack the gunner sight and blind the crew AI; an engine fire
  burns hp over time (`engine.vfx?.vehicleFire?.(vehicle, { engine: true })`); an ammo hit or hp reaching
  zero starts the cook-off: `beginCookOff(vehicle, hit)` returns `true`, runs 2-4 s
  (`engine.vfx?.cookOff?.(vehicle, seconds)`, `vehicle:module` with state `'cookoff'`), dismounts riders,
  then calls `engine.destroyVehicle(vehicle, hit)`.
- Weapons: per-vehicle ammunition instead of the infinite counter. Tanks select HE-FRAG / APFSDS / HEAT
  with [1][2][3] in the gunner seat and the coaxial PKT with [4]; the autoloader cycles in about 7 s.
  Fire through `engine.ballistics?.fireVehicleWeapon?.(vehicle, origin, dir, shellType)` when it exists,
  else the legacy path. Always take the muzzle from `this.getVehicleMuzzle(vehicle, pos, dir)` and emit
  `vehicle:fired` with the shell type.
- Gunner HUD (DOM / canvas overlay in the first-person gunner view): a Sosna-U style reticle with range
  stadia, magnification toggle [Z] (`camera.fov = engine.baseFov / zoom`, restore on exit), laser
  rangefinder (range under the crosshair by a ray cast against the shootable meshes, shown after a short
  delay), hull-versus-turret indicator (hull icon with a turret line from `turretYawActual ?? turretYaw`
  and the chassis heading), shell type and autoloader progress, desant seat status per slot, module
  damage icons, speed and `vehicle.gear` when present.
- Smoke: [J] `popSmoke(vehicle)` fires a salvo (4-6 grenades in a forward arc 25-40 m ahead of the
  turret) as `smoke:deployed` events with `kind: 'tucha'`, with limited salvos and a reload time. The
  crew AI uses it too.
- Crew AI: every vehicle the player is not driving gets a brain with states idle / advance / overwatch /
  retreat; it picks targets (enemy vehicles first for cannons, infantry for HE and machine guns), aims
  through `vehicle.turretYaw / turretPitch`, fires through the same weapon API with reaction delay and
  dispersion, and drives through `vehicle.controls` towards waypoints (`engine.ai?.nav?.findPath?.()`
  when available, else straight steering with simple avoidance). It pops smoke and backs off when a
  `launch` of kind `rpg` / `javelin` is aimed at it or it takes a shaped-charge hit, and holds an
  overwatch position near cover after the squad dismounts. The legacy [T] autopilot keeps working. By
  default enemy vehicles stay near their start positions (defensive) so the existing regression scenario
  still makes sense.
- Hatches: [O] toggles doors through `engine.vehicleParts?.setHatch?.()`; dismount positions are behind
  the rear doors for BMP-2 / Bradley and beside the hull for BTR-80.
- Keep these method names: `mountSquadOnVehicle`, `dismountSquadFromVehicle`,
  `toggleSquadTransportOnNearestVehicle`, `enterVehicleAsDriver`, `enterVehicleAsArmorDesant`,
  `exitCurrentVehicle`, `toggleVehicleAutopilot`, `getVehicleMuzzle`, `tryFireVehicleWeapon`,
  `updateNearestVehiclePrompt`, `updatePlayerInVehicle`.

## Verify
A scenario that damages a track and a tire and checks `vehicle.mobility`, jams a turret, runs a cook-off
to destruction, fires each shell type with the autoloader delay, pops smoke, and lets an enemy BMP-2
engage. Screenshots of the gunner HUD at both magnifications.
