# Package `physics`: worker-side Rapier, drivetrain, mobility damage

## You own
`physics_ragdoll.js` and `src/physics/**`.

## Requirements (user's words)
- Offloading Rapier3D physics and raycasts to a Web Worker so heavy ragdoll solvers and 8-ray vehicle
  suspension don't stall the render thread on mobile CPUs.
- Full gearbox and transmission: gear shifting, torque drop on steep climbs, wheel/track slip, and
  realistic 46-ton tank collision momentum when ramming a light UAZ-452 or concrete obstacles.
- Modular vehicle damage physics (the driving side): knocked-out track (tank pivots in circles on one
  track), blown-out BTR tires (pulling to one side and dropping clearance).
- Active ragdoll limit (`quality.ragdolls.max`) and ragdoll start without an abrupt root quaternion snap.
- Dynamic props for destructible cover (toppling dragon's teeth, crates).

## Design guidance
- Split the simulation from the game: `src/physics/core.js` holds the Rapier world, vehicles, ragdolls,
  debris and props with NO three.js and NO DOM (plain numbers and typed arrays). `physics_ragdoll.js`
  keeps exporting `RagdollPhysicsEngine` as the main-thread facade with every existing name the game
  uses (grep the repo): `vehicles[]`, `ragdolls[]`, `hitboxMeshes`, `ready`, `init`, `step(dt, units,
  onRoadkill)`, `createPhysicalVehicle`, `applyCannonRecoil`, `applyVehicleImpulse`,
  `spawnBlownTurretDebris`, `spawnFlyingHelmet`, `spawnDebris`, `triggerArticulatedRagdoll`,
  `removeRagdoll`, `applyExplosionBlastToRagdolls`, `addStaticBoxCollider`, `extractSoldierBones`,
  `attachAnatomicalHitboxes`, `syncSoldierHitboxes`, `removeUnitHitboxes`. Hitboxes, rider placement on
  vehicles and the roadkill callback stay on the main thread and use mirrored transforms.
- Transport: `src/physics/worker.js` is a module worker (`new Worker(new URL(...), { type: 'module' })`).
  Import maps do not apply inside workers: import Rapier there by its absolute URL
  (`https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/+esm`). Commands are batched per frame
  (create / destroy / impulses / controls); the worker answers with a Float32Array snapshot (vehicle
  transforms, velocities, suspension compression, gear, rpm, slip; ragdoll body transforms; debris and
  prop transforms) that is transferred back and forth. The worker steps at `quality.physics.hz` with an
  accumulator and the facade interpolates.
- One code path: when `settings.physicsWorker` is false (`?physicsWorker=false`), worker creation fails,
  or the page runs from `file:`, the facade drives the same core synchronously through the same commands
  and snapshots. The test hook `BATTLE_ENGINE.step(n)` advances time synchronously, so in worker mode it
  cannot wait for the worker: make stepping deterministic in the synchronous mode (tests use it) and
  verify the worker mode with a real-time scenario (`wait`-based). Both modes must pass the regression.
- Vehicle mirror objects keep the fields in `docs/ARCHITECTURE.md` and gain read-only telemetry:
  `gear`, `rpm`, `slip`, `linvel` (Vector3), `forwardSpeed`, `angvelY`, `wheelSpin[]` (accumulated
  rotation per suspension point). Input written by the game: `controls` every frame and
  `vehicle.mobility = { trackL, trackR, tires: [...], engine }` (1 = healthy, 0 = destroyed): a dead
  track gives no drive and heavy drag on that side (the tank pivots), a dead tire shortens its spring and
  drags (pull to that side, lower clearance), `engine` scales power. Treat a missing `mobility` as healthy.
- Drivetrain: `STATS` masses are about ten times too small. Put real masses and tuning in
  `src/physics/vehicle_tuning.js` (T-90M and T-72B3M 46 t, Bradley 30 t, BMP-2 14 t, BTR-80 13.6 t,
  Humvee 3.5 t, UAZ-452 2 t) and rescale suspension, engine, brake and steering forces so handling stays
  stable. Gearbox with 4-7 forward gears and reverse, a torque curve, shift delay with torque cut,
  traction limited by friction times normal load with a reported slip ratio, realistic top speeds
  (T-90M about 60 km/h, BTR-80 about 80, UAZ about 95), visible slowdown on climbs, neutral steer for
  tracked vehicles. Ramming works through real masses and CCD.
- Props: `addDynamicProp({ object3d, shape, mass, friction })` -> handle mirrored onto `object3d`,
  `removeProp(handle)`, `applyPropImpulse(handle, impulse, point)`, `removeStaticCollider(handle)`
  (`addStaticBoxCollider` returns such a handle), and the existing `spawnDebris`.
- Ragdolls: cap live ragdolls at `quality.ragdolls.max` (freeze the oldest settled one in place and free
  its bodies); remove the root "collapse" rotation that snaps the model when the ragdoll starts; keep the
  bone sync allocation-free.

## Verify
The regression in both modes. A scenario that rams the UAZ with the T-90M (the UAZ is thrown, the tank
barely slows), climbs the bumps at z = -2 / -8, kills one track and checks the tank yaws in place under
throttle, blows two BTR tires and checks the pull and the lower ride height. Report top speeds reached
and the main-thread time spent in `physics.step` in both modes.
