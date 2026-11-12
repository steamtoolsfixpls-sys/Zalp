// Registry of engine mixins (legacy gameplay methods installed on BattleEngine.prototype)
// and feature modules (objects with optional install/update/lateUpdate/onStart/onResize hooks).
import { provingGroundMethods } from './world/proving_ground.js';
import { soldierMethods } from './units/soldiers.js';
import { vehicleGameplayMethods } from './vehicles/gameplay.js';
import { droneMethods } from './drones/drones.js';
import { playerWeaponMethods } from './player/weapons.js';
import { playerControllerMethods } from './player/controller.js';
import { combatMethods } from './combat/combat.js';
import { legacyFxMethods } from './vfx/legacy_fx.js';
import { squadAiMethods } from './ai/squad_ai.js';
import { hudMethods } from './ui/hud.js';
import { createEnvironment } from './world/environment.js';
import { createLod } from './world/lod.js';
import { createPostFx } from './gfx/postfx.js';
import { createVfx } from './vfx/index.js';
import { createDecals } from './vfx/decals.js';
import { createDestructibles } from './world/destructibles.js';
import { createBallistics } from './combat/ballistics.js';
import { createOrdnance } from './combat/ordnance.js';
import { createHealth } from './player/health.js';
import { createLoot } from './player/loot.js';
import { createArms } from './player/arms.js';
import { createAnim } from './anim/index.js';
import { createAi } from './ai/index.js';
import { createVehicleParts } from './vehicles/parts.js';
import { createVehicleSystems } from './vehicles/systems.js';
import { createCrewAi } from './vehicles/crew_ai.js';
import { createDroneOps } from './drones/index.js';
import { createUi } from './ui/index.js';
import { createTouch } from './ui/touch.js';

export const MIXINS = [
    provingGroundMethods,
    soldierMethods,
    vehicleGameplayMethods,
    droneMethods,
    playerWeaponMethods,
    playerControllerMethods,
    combatMethods,
    legacyFxMethods,
    squadAiMethods,
    hudMethods
];

// Order matters: modules are installed and updated top to bottom. engine[name] is the module object.
export const MODULES = [
    ['environment', createEnvironment],
    ['lod', createLod],
    ['postfx', createPostFx],
    ['vfx', createVfx],
    ['decals', createDecals],
    ['destructibles', createDestructibles],
    ['ballistics', createBallistics],
    ['ordnance', createOrdnance],
    ['health', createHealth],
    ['loot', createLoot],
    ['arms', createArms],
    ['anim', createAnim],
    ['ai', createAi],
    ['vehicleParts', createVehicleParts],
    ['vehicleSystems', createVehicleSystems],
    ['crewAi', createCrewAi],
    ['droneOps', createDroneOps],
    ['ui', createUi],
    ['touch', createTouch]
];
