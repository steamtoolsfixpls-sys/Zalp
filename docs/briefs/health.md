# Package `health`: player health, medicine, looting

## You own
`src/player/health.js` (`health` module) and `src/player/loot.js` (`loot` module).

## Requirements (user's words)
- Real player health, bleeding, and injury system: right now `playerHp` never decreases from AI fire;
  needs hit pain vignettes, blood loss, tourniquet/bandage application, painkillers, and limping on leg
  hits.
- Looting weapons, ammo, and ATGMs from fallen soldiers and resupplying from ammo crates inside
  BTR-80/BMP-2 vehicles.

## Design guidance
- `health.applyDamage({ amount, zone: 'HEAD'|'TORSO'|'ARM'|'LEG', pos, dir, attacker, source })` is the
  single entry: `engine.damagePlayer(hit)` forwards to it. The ballistics package (which makes AI bullets
  hit the player) is a stub in your worktree, so drive your tests through `applyDamage` directly and add
  one honest fallback: on `explosion` events apply blast damage to the player by distance unless the
  payload says the player was already handled (`handledPlayer`).
- State (`health.state`): hp, blood volume, bleeding sources per body part (light / heavy), pain 0..1,
  limb status (ok / wounded / tourniquet), consciousness. Keep `engine.playerHp` in sync for legacy
  readers.
- Effects: a DOM vignette that pulses red on a hit with a directional indicator from `dir`, tunnel vision
  and desaturation with blood loss, heartbeat-style pulsing; aim sway grows with pain (modifier
  `aimSway`); leg wounds slow the player and block sprint (modifiers `playerSpeed`, `canSprint`); arm
  wounds raise recoil (modifier `recoil`). Death at zero hp or blood: `player:died`, a short death
  screen, respawn at the start position after about 5 s (leave any vehicle or drone first, reset the
  collider and state), `player:respawned`.
- Medicine with limited supplies (2 bandages, 2 tourniquets, 2 painkillers): [8] bandage stops light
  bleeding (3 s), [9] tourniquet stops heavy limb bleeding (2.5 s, the limb stays impaired), [0]
  painkiller suppresses pain for 60 s. Actions take time, show progress, are interrupted by sprinting or
  firing, and block firing meanwhile (modifier `canFire`). Bleeding that is not treated keeps draining
  blood.
- HUD panel of your own (health, blood, bleeding and limb icons, supplies) placed so it does not cover
  the existing bottom-left controls panel or the weapon panel.
- Loot: on `unit:killed` register a lootable body (it follows `unit.root.position`; drop it when the unit
  respawns) carrying its weapon and ammo (rockets / ATGM for `role === 'at'`). Static crates are objects
  with `userData.ammoCrate` (another package places them: also scan `engine.scene` lazily) and BTR-80 /
  BMP-2 vehicles act as resupply points when the player stands next to or sits in them. Bind [F] with a
  higher priority than vehicle entry and consume it only when a lootable is within 2.2 m and nearer than
  any vehicle. Looting refills reserve ammo of compatible weapons, RPG rounds, grenades
  (`engine.ordnance?.inventory`) and medical items; picking up an enemy weapon makes that weapon slot
  usable with the looted ammo. Show a prompt («[F] ОБЫСКАТЬ …») and a short result through
  `engine.notify`. Scan for the nearest lootable a few times per second, not every frame, without
  allocating.

## Verify
A scenario that applies a leg hit and checks bleeding, the speed modifier and blocked sprint; applies a
tourniquet and checks bleeding stops; drains blood to death and checks respawn; kills an enemy, walks to
the body, loots and checks reserve ammo; resupplies at a BTR-80. Screenshots of the vignette, the HUD
panel and the loot prompt.
