# Package `ai`: infantry navigation and tactics

## You own
`src/ai/**`: `index.js` (`ai` module) and `squad_ai.js` (mixin: `updateUnitsAndSquadAI`,
`issueSquadAssaultOrder`).

## Requirements (user's words)
- NavMesh navigation (three-pathfinding): obstacle avoidance around Dragon's Teeth, burning wrecks, and
  strict pathing along trench communication lines.
- Tactical Cover & Peek AI: bots take cover behind HESCO walls and trench parapets, stay crouched out of
  open fields, lean out only for short bursts, and duck while reloading.
- Suppression AI: heavy suppressive fire near bots degrades their accuracy and pins them behind cover.
- Dedicated ATGM (Javelin) / RPG-7 tank-hunter teams prioritizing armored threats and displacing after
  firing.
- AI grenade throws into trenches and under armor, plus diving/scattering behavior away from incoming
  grenades.
- Casualty evacuation: dragging wounded squadmates by plate-carrier straps into cover and bandaging under
  smoke cover.

## Design guidance
- Navigation: `three-pathfinding` is not available (no new dependencies). Build your own navigation grid
  at install from the static world (`engine.staticShootableMeshes` bounds; vehicles as dynamic blockers;
  wrecks on `vehicle:destroyed`; removed cover when destructibles change): cells of about 0.5 m over the
  play area (x -60..60, z -70..45), A* with path smoothing, cost layers (open ground is expensive under
  fire, covered lanes are cheap, cells around burning wrecks are blocked) and incremental updates. Expose
  `engine.ai.nav = { findPath(from, to, opts), isBlocked(x, z), raycast(a, b) }`. Budget and time-slice
  path requests.
- Cover: generate cover points beside blockers, score them against known threats, reserve them per unit.
  Peek cycle: stay crouched and hidden, rise or lean to fire a 3-6 round burst, duck again, reload while
  ducked. No standing around in the open once enemies are known.
- Shooting: real rounds through `engine.ballistics?.fire?.({ origin, dir, ammo, shooter: unit, faction,
  spread })` when it exists (dispersion from skill, range, movement and suppression); otherwise the
  legacy tracer plus hit roll. Bots also engage the PLAYER when he belongs to the other faction: aim at
  the eye point (`engine.playerCollider.end`); a driver inside a vehicle is not a rifle target, a rider
  on the armor is. In the fallback path a hit calls `engine.damagePlayer({ amount, zone, pos, dir,
  attacker })`. Muzzle: `unit.animator?.muzzleWorld?.(out)` else `root.position + (0, 1.38, 0)`. Emit
  `shot`.
- Animation interface: write `unit.velocity`, `unit.stance`, `unit.aimPoint` and call
  `unit.animator?.trigger?.('fire' | 'reload' | 'throw')`. You move `unit.root.position` (y stays on the
  ground; mounted units are placed by physics). Drop the legacy bone pokes but keep a tiny fallback when
  there is no animator.
- Suppression: `bullet:nearmiss` on a unit, `impact` within 3 m and `explosion` in range raise
  `unit.suppression`; it decays over a few seconds, reduces accuracy and forces a duck above about 0.6.
  Expose `engine.ai.suppress(pos, radius, amount)`.
- Roles at install: per faction two anti-tank gunners (RU: RPG-7; UA: Javelin), one medic, the rest
  riflemen (`unit.role`, `unit.weaponKey`, `engine.anim?.setWeapon?.(unit, key)`). Tank hunters
  prioritize enemy vehicles, move to a firing position with line of sight at 40-120 m, fire
  (`engine.ordnance?.launchMissile?.()` or the legacy rocket projectile; emit `launch`), then displace
  15-25 m to new cover.
- Grenades: against enemies behind cover at 12-30 m or a vehicle at 8-15 m call
  `engine.ordnance?.throwGrenade?.({ from, target, type, thrower })` (fallback: a delayed small
  `triggerHighExplosiveBlast`). On a `launch` of kind `grenade` landing within 8 m, units sprint away and
  drop, and a `callout` `{ key: 'grenade' }` is emitted.
- Casualty evacuation: a unit that survives below 25 hp goes down (`isWounded`, prone, cannot act,
  `unit:wounded`). The medic or the nearest mate pops smoke when exposed (`engine.ordnance?.throwSmoke`
  or a `smoke:deployed` event), drags the casualty to the nearest cover (the casualty follows at arm's
  length, both slow), bandages for about 4 s, and the casualty returns at 40 hp.
- Orders: keep the [G] assault / hold behaviour of the allied squad and react to `order` events of type
  `MOVE` with a position. Enemies defend their line by default. Mounted units fire real rounds too.
- Performance: units think at 5-10 Hz staggered across frames; visibility checks use the grid ray cast
  and `engine.vfx?.smokeDensity?.(a, b)`; no per-frame allocation.
- Node tests for the grid and A* in `tests/ai_nav.test.mjs`.

## Verify
A scenario: order an assault and assert that units reach cover points, crouch there and fire in bursts;
that a path goes around the dragon's teeth; that suppression pins a unit; that a tank hunter fires at a
vehicle and then moves; that a wounded unit is dragged and recovers. Screenshots of bots behind cover.
