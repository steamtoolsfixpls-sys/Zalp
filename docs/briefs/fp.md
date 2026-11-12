# Package `fp`: first-person arms, weapon handling, sights

## You own
`src/player/weapons.js`, `src/player/controller.js`, `src/player/arms.js` (`arms` module) and new files
in `src/player/` other than `health.js` and `loot.js`.

## Requirements (user's words)
- First-person arms viewmodel: right now the weapon just floats in mid-air; detailed uniform sleeves,
  tactical gloves, magazine swap animations, bolt racking, RPG-7 rocket loading, and FPV controller
  handling are needed.
- Collimator and optical sights: functional 1P87 / EOTech reticles (parallax holographic dot strictly
  inside the lens glass) and PGO-7V optical zoom for the RPG-7.
- Free-aim / deadzone: slight barrel shift inside the screen before turning the full body for an
  authentic bodycam feel.
- Fire selector, magazine check, and weapon jams: semi/full-auto toggle ([X]), tactile mag check without
  HUD counters ([Y]), and barrel overheating on 100+ round sustained bursts.

## Facts
- The viewmodel is the weapon GLB under `engine.viewmodelRoot` (a camera child) placed by
  `STATS.WEAPONS[k].hipPos / adsPos`. Weapon GLBs also contain hidden LOD nodes (`userData.lod` 1/2):
  ignore them.
- Weapon parts: AK-74M has named nodes (`Magazine_lowT…`, `ModeSwitch_lowT…`, ...); AK-12 has 8 nodes
  named `Object_N` (split by material); M4A1 has 2; RPG-7 has 2 (`Cube_4…`, `Cylinder_2…`).
- Soldier GLBs are Mixamo rigs in T-pose with no clips (RU has index, middle and thumb finger bones).
  `engine.assets.instantiateSkinned(key, 1.82)` returns `{ model }`.

## Design guidance
- Arms: reuse the faction's soldier model so sleeves and gloves come from the real uniform textures.
  Attach a clone under the camera and show only shoulder / arm / hand geometry (split the geometry once by
  dominant skin bone, or collapse other vertices in the vertex shader). Pose with analytic 2-bone IK
  towards grip points defined per weapon in weapon space (right hand on the pistol grip, left on the
  handguard or magazine) and curl the fingers. Fall back to simple capsule arms if the model is missing.
- Handling animations are procedural and time-based (they drive the IK targets and weapon part
  transforms): tactical reload, dry reload with bolt rack, weapon raise / lower on switch, RPG reload
  (rocket into the muzzle), magazine check [Y] (tilt the weapon, pull the magazine, then a *tactile*
  estimate through `engine.notify`: «ПОЧТИ ПОЛНЫЙ / ОКОЛО ПОЛОВИНЫ / ПОЧТИ ПУСТ»). Animate the real
  magazine node where one exists, otherwise a proxy mesh. FPV: a short "controller in hands" pose at
  launch.
- Sights: AK-12 -> 1P87 collimator, M4A1 -> EOTech, AK-74M -> irons, RPG-7 -> PGO-7V 2.7x. The collimator
  is a small lens quad at the sight window whose shader draws the reticle along the weapon's bore
  direction (appears at infinity) and is clipped to the lens, so with sway the dot moves inside the glass
  and vanishes outside it. PGO-7V: FOV zoom (`camera.fov = engine.baseFov / 2.7`), scope overlay with
  range stadia, restore on release. [Z] toggles magnification where sensible.
- Free-aim (`settings.freeAim`): inside a small deadzone the mouse moves the weapon (a few degrees)
  before the camera turns. Shots follow the barrel: implement `getAimRay(outOrigin, outDir)` in
  `controller.js` (the combat code already calls it).
- Fire selector [X]: per-weapon modes (AK-12 semi / 2-round burst / auto, AK-74M and M4A1 semi / auto);
  semi fires once per trigger pull. Store `weaponStates[k].fireMode` and show it in the weapon HUD state
  line.
- Heat and jams: heat rises per shot and cools over time; past roughly 100 sustained rounds accuracy
  drops and the jam chance rises; a jam needs [R] (tap-rack) to clear. Store `weaponStates[k].heat`
  (0..1) and `jammed`, emit `weapon:overheat`.
- Apply the modifiers in the controller and weapon code: `playerSpeed`, `canSprint`, `canFire`, `aimSway`,
  `recoil` (`engine.modifier(name)`).
- Keep these method names: `setupViewmodelMeshes`, `switchWeapon`, `triggerTacticalReload`,
  `updateReloadStateMachine`, `tryFireCurrentWeapon`, `updateViewmodelTransform`,
  `selectFactionAndStart`, `bindEvents`, `handleKeyDown/Up`, `handlePointerDown/Up`, `applyLookDelta`,
  `setFiring`, `setAiming`, `getAimRay`, `requestPointerLock`, `updatePlayerController`. The controller
  must keep honouring `engine.controlOverride`, `engine.lookOverride` and `engine.input.axes`.

## Verify
First-person screenshots at `quality=high` for each weapon (hip and aimed), two mid-reload frames, the
collimator dot inside the lens, the PGO-7V zoomed view. Assert fire-mode behaviour, heat build-up and jam
clearing in a scenario.
