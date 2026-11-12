# Package `ui`: menus, tactical map, lobby, HUD, touch controls

## You own
`src/ui/**` (`ui` and `touch` modules, `hud.js` mixin) and `index.html`.

## Requirements (user's words)
- Mobile touch HUD: on-screen movement/look joysticks, fire, ADS, APC mount ([B]/[F]), FPV launch
  buttons, and optional gyroscope fine-aiming.
- Tactical map / tablet ([M]): real-time positions of friendly armor, dismounted infantry, waypoints, and
  recon marks spotted by DJI Mavic 3.
- Performance & controls settings menu ([Esc]): mouse/FPV sensitivity sliders, FOV, shadow quality,
  active ragdoll limit, and audio volume controls; plus the graphics preset selector
  (low / medium / high / ultra).
- Deployment lobby: vehicle selection, weapon/ammo loadout customization, and spawn point selection with
  3D model previews.

## Design guidance
- Settings menu: an overlay that pauses the game (`engine.isPaused = true`), releases pointer lock, and
  on close resumes and re-requests it (`engine.requestPointerLock()`). Controls map to the keys in
  `src/core/settings.js` (`SETTING_DEFAULTS`: add keys there only if you must and report it) and write
  through `engine.settings.set(key, value)` live: quality preset (with the auto-detected preset shown),
  shadow quality, dynamic resolution, target FPS 30/60, FOV (also update `engine.baseFov` and the camera
  when no sight is zoomed), mouse / aimed / FPV sensitivity, invert Y, free-aim, ragdoll limit, master /
  effects / radio volume, touch controls, gyro aim, physics worker, show FPS, reset to defaults. MSAA and
  the physics worker need a reload: say so next to the control. The browser also drops pointer lock on
  Esc: when lock is lost during play and no other overlay is open, open the menu.
- Tactical map [M]: a canvas "tablet" overlay, top-down with -Z up; grid, static cover (cached from
  `engine.staticShootableMeshes` bounds), friendly vehicles (type, heading, riders), friendly infantry
  (mounted or on foot), the player with a view cone, enemy contacts only when known (near friendlies with
  a cheap visibility test, or reported through `recon:spotted` events with a time to live), smoke
  (`engine.vfx?.smokeClouds`), waypoints. Clicking the map sets a squad waypoint: emit `order`
  `{ type: 'MOVE', pos }` and set `homePos` / `moveTarget` of the allied squad. Refresh about ten times a
  second; the game keeps running while the map is open; the wheel zooms.
- Lobby: replaces the plain start panel. Keep `#btn-faction-ru` and `#btn-faction-ua` working and keep
  `engine.selectFactionAndStart(faction)` as the way a match starts (tests call it directly and must not
  need the lobby). Choices: faction, spawn point (on the BTR's armor / by the vehicles / forward line),
  primary weapon and optic, grenades and medical supplies within a weight budget, an optional vehicle to
  start in, a graphics preset shortcut. A 3D preview of the selected soldier, weapon or vehicle rotates
  in a small viewport (a second small renderer, or the main one with a scissor rectangle);
  `engine.assets.instantiate(key)` works for every model and vehicles may still be streaming (placeholder
  until `asset:ready`). Store the result in `engine.loadout = { faction, spawn, weapons, optic, grenades,
  medical, vehicleKey }` and apply the spawn choice after the start (move `playerCollider`, or call
  `enterVehicleAsArmorDesant`).
- HUD (`hud.js`): `notify()` as a queue of toasts styled by kind, kill feed, weapon panel, subtitles for
  `callout` events, a streaming indicator from `assets:progress`, a compass strip from `engine.yaw`, and
  the fire mode when `weaponStates[k].fireMode` exists. Do not rename element ids that code looks up
  (grep `getElementById` in `src/`). Add `<link rel="icon" href="data:,">` so the favicon request stops
  failing.
- Touch (`touch` module; active when `settings.touchControls` is `'on'`, or `'auto'` on a touch device):
  a left stick writing `engine.input.axes.moveX / moveY` (sprint when pushed to the edge), a right-side
  look area calling `engine.applyLookDelta(dx, dy)`, a fire button (`engine.setFiring(true/false)`), an
  aim toggle (`engine.setAiming`), and buttons for reload, jump, crouch, weapon switch, grenade, [F], [B],
  [H], [V], [G], map and menu through `engine.input.tap / press / release`. The layout follows the
  context (on foot, vehicle, drone). Track pointers by id for correct multi-touch, block page scroll and
  zoom, offer fullscreen and a landscape hint. Gyro fine aiming (`settings.gyroAim`, with the iOS
  permission flow) feeds `applyLookDelta` while aiming. There is no pointer lock on phones: the game must
  be fully playable without it in touch mode.

## Verify
Screenshots of the menu, the map, the lobby and the touch HUD (`--w 844 --h 390`). A scenario that
changes the preset through the menu and checks `engine.quality.preset`, opens the map and sets a
waypoint, starts through the lobby with a non-default spawn, and drives the touch stick and fire button
through synthetic pointer events.
