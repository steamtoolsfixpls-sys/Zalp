import * as THREE from 'three';

// Carried-weapon geometry. Weapon space: +Z along the barrel, +Y up, origin at the pistol grip (right hand), +X to the
// shooter's left. `yaw` turns weapon space into the model's own frame (model barrel direction = Ry(yaw) * +Z) and
// `grip` is the pistol grip in model coordinates; `handguard` the left-hand point in model coordinates.
export const WEAPONS = {
    ak12: { model: 'weapon_ak12', span: 0.78, yaw: 0, grip: [0, 0.075, -0.13], handguard: [0, 0.165, 0.1], muzzle: [0, 0.185, 0.39] },
    ak74m: { model: 'weapon_ak74m', span: 0.78, yaw: Math.PI, grip: [0, 0.075, 0.13], handguard: [0, 0.165, -0.1], muzzle: [0, 0.185, -0.39] },
    m4a1: { model: 'weapon_m4a1', span: 0.78, yaw: -Math.PI / 2, grip: [0.105, 0.07, 0], handguard: [-0.14, 0.15, 0], muzzle: [-0.39, 0.17, 0] },
    rpg7: { model: 'weapon_rpg7', span: 0.95, yaw: -Math.PI / 2, grip: [-0.03, 0.02, 0], handguard: [-0.16, 0.03, 0], muzzle: [-0.475, 0.1, 0] }
};

// Palm normals in weapon space (the direction the palm faces), right hand on the grip, left under the handguard.
export const PALM = {
    R: new THREE.Vector3(0.45, 0.1, 0.88).normalize(),
    L: new THREE.Vector3(-0.15, 0.95, 0.15).normalize()
};

const _q = new THREE.Quaternion();
const _y = new THREE.Vector3(0, 1, 0);

// Derived weapon-space points, built once per weapon key.
const derived = new Map();
export function weaponSpec(key) {
    const k = WEAPONS[key] ? key : 'ak12';
    let d = derived.get(k);
    if (d) return d;
    const w = WEAPONS[k];
    const inv = new THREE.Quaternion().setFromAxisAngle(_y, -w.yaw);
    const toWs = (m) => new THREE.Vector3(m[0] - w.grip[0], m[1] - w.grip[1], m[2] - w.grip[2]).applyQuaternion(inv);
    d = {
        key: k,
        model: w.model,
        span: w.span,
        yaw: w.yaw,
        gripModel: new THREE.Vector3(...w.grip),
        handguard: toWs(w.handguard),
        muzzle: toWs(w.muzzle),
        invYaw: inv
    };
    derived.set(k, d);
    return d;
}

// Where the wrapper (model) goes so that weapon space sits at position `p` with orientation `q` (both in one frame).
export function wrapperTransform(spec, p, q, outPos, outQuat) {
    outQuat.copy(q).multiply(spec.invYaw);
    outPos.copy(spec.gripModel).applyQuaternion(outQuat).negate().add(p);
    return outQuat;
}

// Rifle hold poses, relative to the chest's rest position (character space: +X left, +Y up, +Z forward).
// pitch: positive tilts the muzzle down; yaw: positive turns it to the left.
export const HOLDS = {
    aim: { g: [-0.075, -0.025, 0.215], pitch: 0, yaw: 0, roll: 0 },
    low: { g: [-0.1, -0.22, 0.2], pitch: 0.55, yaw: 0.05, roll: 0 },
    sitL: { g: [-0.07, -0.16, 0.22], pitch: 0.25, yaw: 0.45, roll: 0 },
    sitR: { g: [0.07, -0.16, 0.22], pitch: 0.25, yaw: -0.45, roll: 0 }
};

const _e = new THREE.Euler();
export function holdQuat(hold, out) {
    return out.setFromEuler(_e.set(hold.pitch, hold.yaw, hold.roll, 'YXZ'));
}
