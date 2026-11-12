# Package `anim`: soldier skeletal animation

## You own
`src/anim/**` (`anim` module) and `src/units/soldiers.js` (`instantiateSkinnedSoldier`,
`spawnSoldierUnit`, `respawnDeadSoldier`).

## Requirements (user's words)
- Full skeletal soldier animations (AnimationMixer + blending state machine) replacing the current
  Math.sin() hip/leg oscillation.
- 2-bone arm inverse kinematics for AI soldiers: hard locking of the left hand onto the handguard and the
  right hand onto the pistol grip of the rifle.
- Foot IK: planting feet accurately onto terrain slopes, ramps, trench parapets, and curved BTR-80 armor.
- Mounted infantry (desant) animations: realistic straddling/sitting poses on APC/tank hulls, holding grab
  rails with one hand while firing with the other, and secondary torso inertia sway during hard braking
  and bumps.
- Active pre-death ragdoll: on lethal/heavy hits the soldier doubles over, clutches chest/stomach,
  staggers 1-2 momentum steps, and only then collapses into the full physical ragdoll without an abrupt
  root quaternion snap.
- Mounting/dismounting with physical infantry vaulting onto and off the hull.
- Gear detachment and scatter: beyond helmet pop-offs, detaching armor plates, pouches, backpacks, and
  dropped weapons on ragdoll transition.

## Facts
- Both soldier GLBs are Mixamo rigs in T-pose with ZERO animation clips. RU has 50 joints (index, middle
  and thumb fingers), UA has 42 (index and thumb). Bone names look like `mixamorig:LeftArm_08` (three
  strips the colon; the numeric suffix differs per rig): match by substring as `extractSoldierBones` in
  `physics_ragdoll.js` does. The model is scaled to 1.82 m, `root` is at the feet and faces +Z.
- Today soldiers stand in T-pose and the rifle is a separate model parented to `root`
  (`root.userData.rifleMesh`). Mesh nodes carry `userData.lod` 0/1/2 (the `gfx` package switches them).

## Design guidance
- Clips must be generated in code. Describe key poses by **bone directions in character space** (for
  example "upper arm points down and slightly forward") plus twist, and convert them to local quaternions
  through the bind pose, so the result does not depend on the rig's axis conventions. Bake the poses into
  `THREE.AnimationClip`s (quaternion tracks per bone plus a hips position track) once per rig and cache
  them per template.
- One `AnimationMixer` per unit with cross-fades. Layers with disjoint tracks: lower body (hips, legs:
  idle, walk, run, crouch, crouch-walk, prone if time allows) and upper body (spine, arms, head:
  low-ready, aim, reload, throw, drag, bandage), plus additive recoil / flinch / breathing. The state
  machine is driven by actual movement (derive velocity from `root.position` deltas: AI code moves the
  root directly; also honour `unit.velocity`), `unit.stance`, `unit.aimPoint`, `unit.mountedVehicle` and
  triggers. Public surface: see `unit.animator` in `docs/ARCHITECTURE.md`.
- IK pass after `mixer.update`: analytic 2-bone IK for both arms to grip points defined per weapon on the
  rifle; the rifle sits in a socket that follows the chest / right hand; spine twist and pitch towards the
  aim point; `animator.muzzleWorld(out)` and `eyeWorld(out)` for the AI. Foot IK by ray casts down from
  the hips (`engine.octree.rayIntersect(ray)` covers the static world including ramps; y = 0 otherwise).
  `quality.anim.ik` is `off | arms | full`; lower the mixer rate for far units (`quality.anim.farUpdateHz`,
  `farDistance`, `engine.lod?.levelOf?.(unit)`).
- Mounted: physics places `root` on the slot each frame. Use sitting variants by slot side, one hand to a
  virtual grab-rail point beside the slot, the other keeps the rifle; torso sway from vehicle acceleration
  (derive it from `vehicle.frameDeltaPos`) through a spring.
- Pre-death: `animator.beginDeath(info, startRagdoll)` is already called by the combat code; return `true`
  to play 0.5-0.9 s of clutch-and-stagger (move `root` one or two short steps along the impulse) and then
  call `startRagdoll()`. Head shots, blasts and vehicle rams should skip it (return `false`).
- Mount / dismount: gameplay code teleports the unit when `mountedVehicle` changes. Detect the change and
  play a vault by offsetting `modelNode` (not `root`) along an arc for about 0.9 s, so gameplay state is
  untouched.
- Gear scatter on death: a few small meshes (plate, pouch, backpack, magazine) and the dropped rifle
  through `engine.physics.spawnDebris(mesh, { shape, mass, linvel, angvel, ttl })`, capped by
  `quality.debris.max`. Share geometries and materials; never allocate them per death.
- `engine.anim.setWeapon(unit, weaponKey)` swaps the carried weapon model (rifle, RPG-7).
- Respawn rebuilds the model: dispose the old animator and mixer, emit `unit:respawned`.
- Do not edit `physics_ragdoll.js` (the `physics` package fixes the ragdoll root snap) or the legacy AI,
  which pokes leg bones directly: your mixer runs later in the frame and overrides it.

## Verify
Contact sheets: render one soldier from the side and the front at several times (advance with
`BATTLE_ENGINE.step`) for idle, walk, run, crouch, aim, reload, seated on the BTR, and the death stagger.
Inspect the images: no T-pose anywhere, both hands on the rifle, feet on the ground.
