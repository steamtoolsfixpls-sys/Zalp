# Package `ballistics`: projectiles, penetration, explosives

## You own
`src/combat/**`: `combat.js` (mixin), `ballistics.js` (`ballistics` module), `ordnance.js` (`ordnance`
module) and new data files there.

## Requirements (user's words)
- Physical ballistic projectiles and bullets instead of instant Raycaster: real muzzle velocity travel
  time, gravitational bullet drop, kinetic energy loss over distance, and wind drift.
- Differentiated armor penetration: millimetre-based armor zones (T-90M turret front resists 30mm
  autocannons and non-tandem RPG-7s; BTR-80 side resists 5.45mm at 200 m but is penetrated by 14.5mm KPVT
  and APFSDS; UAZ-452 is penetrated straight through by any caliber).
- Material penetration (wallbang): shooting through thin wood planks, crates, bushes, and UAZ sheet metal
  with reduced damage and trajectory deflection.
- Armor sparks and ricochets: a tracer striking sloped T-90M / BTR-80 armor at a shallow angle ricochets
  upward (you decide and emit; visuals are `vfx`').
- ERA (Relikt / Kontakt-5) detonation of the specific brick struck by an RPG/FPV.
- RPG-7V2 backblast that knocks back or injures infantry standing behind the launcher.
- Hand grenades F-1 / RGD-5 with flying pin/spoon and 40+ physical shrapnel sub-rays; TM-62 anti-tank
  mines on roads (blowing tracks/wheels on contact).
- AI fire must really hurt the player (today `playerHp` never decreases).

## Design guidance
- Data: `ammo_data.js` (5.45x39, 5.56x45, 7.62x54R, 12.7, 14.5, 25 mm, 30 mm AP/HE, 125 mm APFSDS /
  HE-FRAG / HEAT, PG-7VL, PG-7VR tandem, FPV warheads, VOG-17, F-1, RGD-5: mass, muzzle velocity, drag,
  penetration in mm RHA versus range, damage, explosive and HEAT/tandem flags, tracer colour) and a map
  from `STATS.WEAPONS` ids and vehicle spec keys to ammo. `armor_data.js`: per-vehicle zones in mm (hull
  and turret: front, side, rear, top) and ERA coverage (T-90M Relikt, T-72B3M Kontakt-5).
- Simulation: pooled projectiles, fixed sub-steps, a swept segment test per step against soldier hitboxes
  (broad-phase by a unit sphere first; `physics.syncSoldierHitboxes(unit)` lazily, once per frame per
  candidate), vehicle proxies (`hitProxyMesh` box -> zone from the local hit point, incidence angle ->
  effective thickness, ricochet beyond about 70 degrees unless overmatched), `engine.staticShootableMeshes`
  (`userData.surface`, `userData.penetrable`), drones (`engine.droneOps?.drones`: spheres `{ pos, radius }`
  -> `damageDrone`), the player capsule when the shooter is not the player, and the ground at y = 0.
  Velocity decays with drag; damage scales with remaining energy; a penetration slows, deflects and
  continues (at most two). Emit `impact`, `vehicle:hit`, `unit:hit`, `bullet:nearmiss` (within about
  1.5 m of the player's head or of an AI unit).
- API: `engine.ballistics.fire({ origin, dir, ammo, shooter, faction, isPlayer, spread, vehicle })`,
  `ballistics.fireVehicleWeapon(vehicle, origin, dir, shellType)` (the vehicle code calls it
  defensively), `ballistics.raycast(origin, dir, maxDist)`. Tracers through `engine.vfx?.bulletTracer?.()`
  with the legacy beam as fallback.
- Keep the stable engine methods listed in `docs/ARCHITECTURE.md`, including the `beginDeath` block in
  `killSoldierWithRagdoll` and `getAimRay` in the player shot paths. `performBallisticRaycast(wStat)`
  becomes "fire one physical round for the player". AI rifles currently roll dice in `src/ai` (another
  owner): they will call `engine.ballistics.fire`; keep the legacy path valid meanwhile.
- Explosions: `triggerHighExplosiveBlast(pos, radius, force, damage, label, opts)` = blast with cover
  occlusion (line of sight against static meshes reduces damage) plus fragmentation rays traced through
  the same hit code (40+ for grenades, scaled by quality), player included. Vehicles go through the armor
  model and `damageVehicle`.
- ERA: discrete bricks per zone; a HEAT hit on an intact brick detonates it (`era:detonated` with
  position and normal) and defeats a single charge; a tandem warhead spends its precursor and penetrates.
- Backblast: on an RPG launch hurt and push units inside a rear cone (about 30 degrees, 8 m) and emit
  `launch` `{ kind: 'rpg', ... }`.
- Ordnance: [5] frag grenade (hold to cook, throw on release; arc and bounces against
  `engine.octree.sphereIntersect` or the ground; 3.2-4 s fuse; pin and spoon as tiny pooled meshes or
  `engine.vfx?.debris`), [6] RDG-2 smoke (`smoke:deployed`), [7] TM-62 mine (pressure fuse under moving
  vehicles; writes `vehicle.mobility` / calls `damageVehicle` with `kind: 'mine'`). For the AI:
  `ordnance.throwGrenade({ from, target, type, thrower })`, `ordnance.throwSmoke(...)`,
  `ordnance.liveGrenades[]`, `ordnance.inventory` (player counts).
- Node tests for drop, energy and penetration tables in `tests/ballistics.test.mjs`.

## Verify
Assert in a scenario: a 5.45 round takes measurable time to reach 100 m and drops; 5.45 does not
penetrate the BTR-80 side but 14.5 does; 30 mm fails against the T-90M turret front; an RPG on an intact
ERA brick is defeated and the second hit on the same brick penetrates; a wooden crate is shot through;
a grenade's fragments wound units behind no cover and spare those behind HESCO; bullets aimed at the
player reduce `playerHp` (or call `health.applyDamage`).
