# Package `surface`: decals, destructible cover, world layout

## You own
`src/vfx/decals.js` (`decals`), `src/world/destructibles.js` (`destructibles`), and the methods
`populateMilitaryLineupRows` and `addStaticObstacleCollider` in `src/world/proving_ground.js`.

## Requirements (user's words)
- Projective decals: scorched blast craters on the ground, bullet holes in walls and concrete, HEAT
  penetration holes in armor with molten edges, and blood stains.
- Blood pools forming on the ground beneath corpses, and blood splatter on APC armor when mounted
  infantry are hit.
- Persistent tread/track marks left on the terrain.
- Destructible minor cover: splintering ammo crates, breaching/collapsing HESCO sandbags under tank
  rounds, shattering trench duckboards, and toppling Dragon's Teeth from explosions.

## Design guidance
- Decals: a fixed budget (`quality.decals.budget`) of oriented quads in one or two InstancedMesh batches
  with a canvas-generated atlas (bullet holes for concrete / metal / dirt, scorch, crater ring, blood
  splats, pool, HEAT hole with an emissive molten rim whose glow fades over about 6 s through a
  per-instance attribute). Ring-buffer recycling of the oldest, fade before reuse, polygon offset against
  z-fighting. Decals on moving objects (vehicle hulls) are stored in the object's local space and follow
  it. True projection (`DecalGeometry`) allocates: avoid it during combat.
- Listen to `impact` (surface type picks the decal), `explosion` (scorch and crater by radius),
  `unit:hit` / `unit:killed` (stains, and a pool that grows for 6-10 s once the body rests at
  `unit.root.position`), `vehicle:hit` (HEAT hole when `ammo` is a shaped charge and `penetrated`).
  Provide `decals.add({ kind, pos, normal, size, object? })`.
- Track marks: stamp quads (or a ribbon ring buffer) at track / wheel contact points every half metre
  while a vehicle moves (`vehicle.suspPoints`, `vehicle.chassisPos/chassisQuat`), faded over time and
  budgeted.
- Destructibles: crates (wood, splinter), HESCO (sandbag fill: breach into a lower collapsed pile),
  duckboards, dragon's teeth (topple). React to `explosion` and heavy `impact`. Use
  `engine.physics.spawnDebris(mesh, opts)` for flying chunks and `engine.physics.addDynamicProp?.(...)` /
  `removeStaticCollider?.(...)` when the physics package provides them, with a simple animated fallback.
  After destruction remove the mesh from `engine.staticShootableMeshes` and rebuild `engine.octree` from
  the remaining static meshes (keep your own list; this is rare). Provide
  `destructibles.damageAt(pos, radius, energy)`. Tag props with `userData.surface` and thin ones with
  `userData.penetrable = { mm, material }` so bullets can pass through.
- World layout (keep every existing position: other code and tests refer to them): ammo crates near both
  lines tagged `userData.ammoCrate = true`, duckboards across the trench model area, a sandbag / earth
  parapet line with firing gaps in front of the UA infantry (about z = -28..-30) that gives real cover
  (static colliders plus shootable meshes with surface `sandbag`), and a dirt road strip from the vehicle
  row towards the enemy line (visual only; mines are placed on it by another package). Keep draw calls
  low (merge or instance).

## Notes
- The `gfx` package also edits `src/world/proving_ground.js`, but only `setupLighting` and
  `buildCleanPolygonFloorAndRamps`: stay inside your two methods.
- The existing "trench system" model is a flat decorative layout, not a dug trench; the ground is a flat
  collider at y = 0.

## Verify
Screenshots at `quality=high`: bullet holes on a HESCO wall, a scorch crater after an RPG hit, track
marks behind a driven BTR, a blood pool under a body, a breached HESCO, a toppled dragon's tooth. Assert
budgets hold (decal count never exceeds the budget) and that destroyed cover no longer blocks bullets.
