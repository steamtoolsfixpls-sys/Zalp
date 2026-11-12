# Package `vehrig`: vehicle part hierarchies and their animation

## You own
`tools/vehicle-rig.mjs` (called from `tools/optimize-assets.mjs` as `rigVehicle(doc, key)`), the vehicle
GLBs `individual_models/08..14_*.glb`, `src/vehicles/parts.js` (`vehicleParts` module). You may add
`lods` to the vehicle entries of `PROFILES` in `tools/optimize-assets.mjs` (vehicle lines only).

Raw inputs are in `raw_models/`. Rebuild one vehicle with
`node tools/optimize-assets.mjs --only 12_vehicle`. The `ktx` CLI
is installed.

## Requirements (user's words)
- Separate turret and gun barrel hierarchies on all vehicles: independent horizontal rotation of the 3D
  turret mesh and vertical elevation of the barrel mantlet aimed at the player/AI target, instead of
  firing from an invisible forward point.
- Physical barrel recoil inside the turret (125mm gun on T-90M/T-72B3M and 30mm 2A42 autocannon) after
  every shot.
- Two-plane gun stabilizer: keeping the tank barrel locked onto the aim line while the hull pitches and
  rolls over uneven terrain.
- Live wheel and track animation: spinning all 8 wheels on BTR-80 and 4 wheels on Humvee/UAZ according to
  speed, front-axle steering angles, per-wheel vertical suspension travel driven by
  `suspPoints.compression`, and UV-scrolling track belts.
- Opening hatches (rear BMP-2 doors / Bradley ramp / BTR-80 side hatches) as animatable parts where the
  model allows it.

## Facts
- The GLBs are merged by material, not by part: BTR-80 has 4 mesh nodes, T-90M 11, T-72B3 17, Bradley 3,
  UAZ 2 (`Uaz_01`, `Uaz_glass`), BMP-2 145 (`Object_N`), Humvee 19 including four wheel nodes
  (`hmmwvkfor_wheel.smd…`) and a skin with joints `mashingun_turret_yaw_01` and
  `mashingun_cannon_pitch_02`.
- Runtime normalization (`AssetManager._fill` in `src/core/assets.js`): scale so the longest bounding-box
  side equals `STATS.VEHICLE_SPECS[key].span`, centre on XZ, rest on y = 0. After it every vehicle faces
  -Z.

## Design guidance
- Pipeline (gltf-transform Document API; `bakeLods` in `optimize-assets.mjs` shows the API in use): bake
  the runtime normalization into the file so node coordinates are metres in the vehicle frame (origin on
  the ground under the hull centre, forward -Z) and the runtime normalization becomes an identity; verify
  that. Then split geometry into parts by **connected components** (mesh islands welded by position),
  classified by per-vehicle rules on island centroid and bounds in the vehicle frame: turret = islands
  above the deck inside the turret footprint; gun = long thin islands ahead of the ring; wheels =
  disc-like islands at the axle positions; tracks = side belts; hatches where identifiable. If an island
  spans regions (hull welded to turret) fall back to per-triangle classification. Keep materials.
- Emit this hierarchy: hull root -> `turret` pivot at the ring centre -> `gun` pivot at the trunnion;
  `wheel_<i>` pivots at the axle centres. Pivots are EMPTY nodes with mesh children, so LOD meshes can sit
  beside LOD 0 under the same pivot. Put `extras` on the pivots (`{ part, side, index, radius, steer }`)
  and `extras.rig` on the root (`muzzle` in gun space, ring centre, limits); three exposes extras as
  `userData`. Keep the per-vehicle configuration as data at the top of `vehicle-rig.mjs`.
- Check every split visually: a debug page or scenario that loads one vehicle, tints parts by class,
  yaws the turret 60 degrees, elevates the gun 15 degrees and renders side / top / front views. Iterate
  until no hull triangle travels with the turret. Order: T-90M, T-72B3M, BMP-2, BTR-80, Bradley, then
  Humvee (existing joints or a re-split) and UAZ (wheels only).
- Runtime `parts.js`: when a vehicle is created or its model arrives (`asset:ready`), build
  `vehicle.parts = { turret, gun, wheels[], tracks[], hatches[] }`. Every frame: slew
  `vehicle.turretYawActual` towards `vehicle.turretYaw` (a world-space yaw target) at a per-vehicle
  traverse rate and elevate towards `vehicle.turretPitch` within limits; stop when
  `vehicle.modules?.turret` is `'destroyed'` or `'jammed'`. Stabilizer: derive the turret and gun local
  angles from the world-space aim direction each frame, so the barrel holds its line while the hull
  pitches and rolls. Recoil on `vehicle:fired` (also `vehicleParts.recoil(vehicle)`): the gun slides back
  along the bore (about 0.3 m for 125 mm, 0.05 m for autocannons) and returns on a spring.
  `getMuzzle(vehicle, outPos, outDir)` returns `true` and the real muzzle of the actual barrel (the
  gameplay code already asks through `engine.getVehicleMuzzle`). Wheels spin from forward speed and
  radius (`vehicle.wheelSpin` when the physics package provides it), steer the front axles from
  `vehicle.controls.steer` (BTR-80: the first two axles), and travel vertically with the nearest
  `suspPoints[i].compression`. Tracks: scroll a cloned material's texture offset when the belt UVs run
  along the track; otherwise rotate road wheels only and report it. `setHatch(vehicle, name, open01)`.
- A vehicle without a usable rig keeps working: virtual turret angles, `getMuzzle` returns `false`.

## Verify
For each vehicle: turret at 0 / 90 degrees and gun elevated, wheels turned, as screenshots. Assert that
`getMuzzle` follows the turret, that the muzzle direction stays within a degree of the aim line while the
hull is tilted 10 degrees, and that recoil returns to rest.
