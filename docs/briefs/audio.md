# Package `audio`: battlefield acoustics

## You own
`src/audio/**`. The kernel constructs `engine.sound = new SoundEngine(engine)` from `src/audio/audio.js`
and treats it as a module: optional `install(engine)`, `update(dt)`, `onStart(faction)` hooks are called.
`init()` is called on the first user gesture and must keep creating / resuming the AudioContext.

## Requirements (user's words)
- Transition from synthetic Web Audio oscillators to multi-layered studio audio samples (close crack,
  mechanical bolt clack, distant caliber echoes across treelines and open fields).
- True speed-of-sound delay (343 m/s): a distant muzzle flash is seen instantly while the boom and impact
  rumble arrive later.
- Supersonic bullet cracks and shrapnel whiz: spatial PannerNode (HRTF) audio for rounds snapping past
  the player's head.
- Approaching FPV drone whine with Doppler pitch shift during the terminal dive, audible to infantry
  60-80 m away.
- Concussion and barotrauma: close explosions apply a temporary global low-pass muffled filter plus
  high-pitched tinnitus ringing for 4-6 seconds.
- Vehicle acoustics: low-frequency diesel rumble of T-90M/BMP-2 engines, metallic track clanking during
  neutral-steer turns, turret hydraulics, cabin fan hum, and shell casings clattering onto armor.
- Squad radio chatter and combat callouts: radio squelch when issuing [G] / [H] orders, vehicle/drone
  contact reports, and shouts of "Air, FPV!" or "Grenade!".

## Design guidance
- There are no audio files and none may be downloaded. Build the sample-bank architecture: an optional
  `assets/audio/manifest.json` maps sound ids to files with variations; when a file is missing (the
  default) the bank renders a layered procedural buffer for that id once (OfflineAudioContext or direct
  buffer synthesis) and caches it. Playback is always a pooled AudioBufferSourceNode: no per-shot
  oscillators. Write `docs/AUDIO.md` listing the ids and how to drop in real recordings.
- Graph: buses (sfx, vehicles, voice/radio, ui) -> master gain -> concussion low-pass -> compressor ->
  destination. Volumes from `settings.masterVolume / sfxVolume / radioVolume`, live on `settings:changed`.
- 3D: the listener follows `engine.camera` every frame. PannerNodes use HRTF when `quality.audio.hrtf`,
  otherwise equal-power. Limit voices to `quality.audio.maxVoices` by priority and distance.
- Speed of sound: start time = now + distance / 343 (cap about 3 s). Choose close / mid / far layers by
  distance, low-pass with range, add an echo tail for far shots (generated impulse response on medium+).
- Cracks: on `bullet:nearmiss` with `target === 'player'`. While the ballistics package is a stub, derive
  a pass-by yourself from `shot` events whose line passes within 3 m of the camera.
- Explosions: layered by `kind` and `radius`; inside about 1.2 radii trigger the concussion (low-pass
  sweep down to roughly 400 Hz plus a 4-6 kHz tinnitus tone fading over 4-6 s). Expose
  `engine.sound.concussion(amount)`.
- Drones: `createDroneMotorNode()` must keep returning an object with `.osc.frequency.value` and
  `.gain.gain.value` (the drone code writes them). Add positional whine for flying drones (the legacy
  `engine.drones[]` entries have `mesh.position`; later `engine.droneOps?.drones[]` entries have `pos`
  and `vel`) with a manual Doppler shift from radial velocity, audible to about 80 m.
- Vehicles: keep `updateVehicleEngineSound(active, speedKmh, throttle)` for the player's vehicle; add
  positional loops for the three nearest running vehicles: diesel rumble, track clank scaled by steering
  and speed on TRACKED vehicles, turret hydraulic whine while `vehicle.turretYaw` changes, cabin fan hum
  for a first-person driver, casing clatter on `casing:bounce`.
- Radio: `radio(key, text)` plays squelch open / close around a voice-band noise burst and, when
  available, a `speechSynthesis` utterance in Russian (optional, never required). Listen to `order` and
  `callout`. Originate rate-limited callouts yourself only where nobody else does (for example an enemy
  drone diving: `air_fpv` "Воздух! FPV!"; a `launch` of kind `grenade` near friendlies: "Граната!") and
  emit `callout` for those so the HUD can subtitle them.
- Every method is a silent no-op while there is no AudioContext. Headless tests run muted.

## Verify
Node or browser tests for the scheduling math (delay, Doppler factor, voice limiting). A scenario that
fires weapons, explodes a shell near and far, drives a tank and checks that voices stay under the limit,
nothing throws and no nodes leak (`engine.sound` exposes counters).
