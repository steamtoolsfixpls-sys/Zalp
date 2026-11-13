import * as THREE from 'three';
import {
    Rig, POSE_BONES, LOWER_BONES, ARM_BONES, worldPos, setWorldQuat, applyDelta, aimBone, eulerQuat, solveArm, orientHand
} from './rig.js';
import { weaponSpec, HOLDS, PALM, holdQuat } from './weapons.js';

// Clips are generated in code: key poses are bone directions and root-frame rotations (see rig.js), solved on a clean
// clone of the rig and baked into THREE.AnimationClips once per soldier template. The lower layer (hips, legs and
// the spine chain) and the upper layer (arms) use disjoint tracks, so they mix independently.
const TAU = Math.PI * 2;
const GAIT_SAMPLES = 16;

export const LOWER_STATES = ['idle', 'walk', 'run', 'crouch', 'crouchWalk', 'sit'];
export const DURATION = { idle: 4, walk: 1, run: 2 / 3, crouch: 4, crouchWalk: 1.2, sit: 4 };
// Ground speed (m/s) at which a gait clip plays at its natural rate.
export const NOMINAL_SPEED = { walk: 1.4, run: 3.3, crouchWalk: 0.95 };

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _fl = new THREE.Vector3();
const _fr = new THREE.Vector3();
const _hp = new THREE.Vector3();

const leg = (t, s, abd = 0.03, foot = 0) => ({ t, s, abd, foot });
const sat = (x) => Math.max(0, x);

// Lower-layer pose for a clip kind at phase u in [0, 1).
export function lowerPose(kind, u) {
    const c = Math.cos(TAU * u);
    const s = Math.sin(TAU * u);
    const p = { legs: { L: leg(0.04, 0), R: leg(0.04, 0) }, hips: { rot: [0, 0, 0], x: 0, z: 0 }, spine: [0, 0, 0], chest: [0, 0, 0], head: [0, 0, 0] };
    if (kind === 'idle') {
        p.hips.rot = [0, 0, 0.012 * s];
        p.hips.x = 0.01 * s;
        p.spine = [0.018 * s + 0.02, 0, -0.01 * s];
        p.chest = [0.012 * s, 0, 0];
        p.head = [-0.02 - 0.012 * s, 0.03 * Math.sin(TAU * u * 2 + 1), 0];
        p.legs.L = leg(0.05, 0.01, 0.05);
        p.legs.R = leg(0.03, 0.01, 0.05);
    } else if (kind === 'walk' || kind === 'run') {
        const run = kind === 'run';
        const A = run ? 0.72 : 0.42;
        const base = run ? 0.1 : 0.04;
        const lift = run ? 1.45 : 0.95;
        const stance = run ? 0.28 : 0.14;
        for (const side of ['L', 'R']) {
            const ph = side === 'L' ? u : (u + 0.5) % 1;
            const pc = Math.cos(TAU * ph);
            const ps = Math.sin(TAU * ph);
            const swing = Math.pow(sat(-ps), 0.9);
            const thigh = base + A * pc;
            const flex = stance * sat(pc) + lift * swing + 0.04;
            const heel = Math.pow(sat(Math.sin(TAU * (ph - 0.25))), 2) * (ph > 0.25 && ph < 0.5 ? 1 : 0);
            p.legs[side] = leg(thigh, thigh - flex, 0.035, -0.22 * sat(pc) + (run ? 0.55 : 0.4) * heel - 0.12 * swing);
        }
        const yaw = run ? 0.16 : 0.09;
        p.hips.rot = [0, yaw * c, 0.028 * s];
        p.hips.x = (run ? 0.02 : 0.015) * s;
        p.hips.lift = run ? 0.03 * (1 - Math.cos(2 * TAU * u)) * 0.5 : 0;
        p.spine = [run ? 0.2 : 0.07, -0.5 * yaw * c, -0.02 * s];
        p.chest = [run ? 0.05 : 0.02, -0.5 * yaw * c, 0];
        p.head = [run ? -0.16 : -0.05, 0.9 * yaw * c * 0.5, 0];
    } else if (kind === 'crouch') {
        p.legs.L = leg(1.2, -0.45, 0.1);
        p.legs.R = leg(1.12, -0.5, 0.1);
        p.hips.rot = [0, 0, 0.012 * s];
        p.spine = [0.3 + 0.015 * s, 0, 0];
        p.chest = [0.12, 0, 0];
        p.head = [-0.3, 0.03 * Math.sin(TAU * u * 2), 0];
    } else if (kind === 'crouchWalk') {
        for (const side of ['L', 'R']) {
            const ph = side === 'L' ? u : (u + 0.5) % 1;
            const pc = Math.cos(TAU * ph);
            const swing = Math.pow(sat(-Math.sin(TAU * ph)), 0.9);
            const thigh = 1.15 + 0.3 * pc - 0.2 * swing;
            p.legs[side] = leg(thigh, thigh - (1.62 + 0.55 * swing), 0.1, -0.1 * pc);
        }
        p.hips.rot = [0, 0.07 * c, 0.02 * s];
        p.spine = [0.3, -0.04 * c, 0];
        p.chest = [0.12, -0.04 * c, 0];
        p.head = [-0.3, 0.04 * c, 0];
    } else if (kind === 'sit') {
        p.legs.L = leg(2.23, -0.52, 0.2, 0.1);
        p.legs.R = leg(2.2, -0.5, 0.2, 0.1);
        p.hips.y = 0.17;
        p.hips.rot = [0, 0, 0.01 * s];
        p.spine = [-0.04 + 0.012 * s, 0, 0];
        p.chest = [0, 0, 0];
        p.head = [0.02, 0.04 * Math.sin(TAU * u * 2), 0];
    }
    return p;
}

// Solves the lower body of `rig` into pose `p` (rig is reset first).
export function applyLowerPose(rig, p) {
    rig.reset();
    const b = rig.bones;
    eulerQuat(p.hips.rot[0], p.hips.rot[1], p.hips.rot[2], _qa);
    applyDelta(b.hips, _qa);
    for (const side of ['L', 'R']) {
        const l = p.legs[side];
        const sx = side === 'L' ? 1 : -1;
        const upper = b[`upperLeg${side}`];
        const lower = b[`lowerLeg${side}`];
        const foot = b[`foot${side}`];
        worldPos(upper, _hip);
        _v.set(sx * Math.sin(l.abd), -Math.cos(l.t), Math.sin(l.t)).normalize();
        _tgt.copy(_hip).addScaledVector(_v, rig.thigh);
        aimBone(upper, lower, _tgt);
        worldPos(lower, _knee);
        _v.set(sx * Math.sin(l.abd) * 0.5, -Math.cos(l.s), Math.sin(l.s)).normalize();
        _tgt.copy(_knee).addScaledVector(_v, rig.shin);
        aimBone(lower, foot, _tgt);
        eulerQuat(l.foot, 0, 0, _qa);
        _qa.multiply(rig.rest[`foot${side}`].wq);
        setWorldQuat(foot, _qa);
    }
    worldPos(b.footL, _fl);
    worldPos(b.footR, _fr);
    worldPos(b.hips, _hp);
    let dy = rig.ankleY + (p.hips.lift || 0) - Math.min(_fl.y, _fr.y);
    if (p.hips.y !== undefined) dy = p.hips.y - _hp.y;
    _hp.x += p.hips.x || 0;
    _hp.y += dy;
    _hp.z += p.hips.z || 0;
    b.hips.position.copy(b.hips.parent.worldToLocal(_hp));
    b.hips.updateMatrixWorld(true);
    for (const k of ['spine', 'chest', 'head']) {
        const r = p[k];
        if (!r[0] && !r[1] && !r[2]) continue;
        eulerQuat(r[0], r[1], r[2], _qa);
        applyDelta(b[k], _qa);
    }
}

// ------------------------------------------------------------------ arms

// Wrist (hand bone) position for a palm that has to sit on `grip`, given the shoulder it reaches from.
export function wristTarget(shoulder, grip, palmNormal, out) {
    out.subVectors(grip, shoulder).normalize().multiplyScalar(-0.07);
    out.addScaledVector(palmNormal, -0.03).add(grip);
    return out;
}

const POLE = { L: new THREE.Vector3(0.35, -0.9, -0.25), R: new THREE.Vector3(-0.35, -0.9, -0.25) };
export const ARM_POLE = POLE;

export function solveArmPose(rig, side, wrist, palmNormal, pole) {
    const b = rig.bones;
    solveArm(b[`upperArm${side}`], b[`lowerArm${side}`], b[`hand${side}`], wrist, pole || POLE[side]);
    if (palmNormal) orientHand(b[`hand${side}`], palmNormal);
}

// Arm pose that holds `weapon` in `holdKey` relative to the chest's rest position (no body deformation).
// Returns how far (m) the rifle had to be pulled back along its barrel so that the support hand reaches the handguard.
function applyHoldArms(rig, weaponKey, holdKey) {
    rig.reset();
    const spec = weaponSpec(weaponKey);
    const hold = HOLDS[holdKey];
    const q = holdQuat(hold, new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const grip = new THREE.Vector3(...hold.g).add(rig.rest.chest.wp);
    const rail = holdKey === 'sitL' || holdKey === 'sitR';
    // The hand that holds the rifle: right on the grip normally, the inner hand when sitting.
    const gripSide = holdKey === 'sitR' ? 'L' : 'R';
    const other = gripSide === 'R' ? 'L' : 'R';
    const palmG = _v.set(gripSide === 'R' ? PALM.R.x : -PALM.R.x, PALM.R.y, PALM.R.z).applyQuaternion(q).clone();
    const palmH = _w.set(other === 'L' ? PALM.L.x : -PALM.L.x, PALM.L.y, PALM.L.z).applyQuaternion(q).clone();
    const handguard = new THREE.Vector3();
    const wl = new THREE.Vector3();
    let shift = 0;
    if (!rail) {
        const shoulder = rig.rest[`upperArm${other}`].wp;
        for (let pass = 0; pass < 3; pass++) {
            handguard.copy(spec.handguard).applyQuaternion(q).add(grip).addScaledVector(fwd, -shift);
            wristTarget(shoulder, handguard, palmH, wl);
            const excess = shoulder.distanceTo(wl) - (rig.upperArm + rig.foreArm) * 0.985;
            if (excess <= 0.003) break;
            shift = Math.min(0.12, shift + excess);
        }
    }
    grip.addScaledVector(fwd, -shift);
    const wr = wristTarget(rig.rest[`upperArm${gripSide}`].wp, grip, palmG, new THREE.Vector3());
    solveArmPose(rig, gripSide, wr, palmG);
    if (rail) {
        const outer = holdKey === 'sitL' ? 'L' : 'R';
        const sx = outer === 'L' ? 1 : -1;
        const railPoint = new THREE.Vector3(sx * 0.42, -0.27, 0.14).add(rig.rest.chest.wp);
        solveArmPose(rig, outer, railPoint, new THREE.Vector3(0, -1, 0.3).normalize(), new THREE.Vector3(sx * 0.8, -0.6, 0));
    } else {
        solveArmPose(rig, other, wl, palmH);
    }
    return shift;
}

// Both hands pressed to the chest and stomach (pre-death stagger).
function applyClutchArms(rig) {
    rig.reset();
    const c = rig.rest.chest.wp;
    solveArmPose(rig, 'L', new THREE.Vector3(0.1, c.y - 0.2, c.z + 0.2), new THREE.Vector3(0, 0.4, -1).normalize(), new THREE.Vector3(0.8, -0.4, -0.4));
    solveArmPose(rig, 'R', new THREE.Vector3(-0.08, c.y - 0.12, c.z + 0.21), new THREE.Vector3(0, 0.2, -1).normalize(), new THREE.Vector3(-0.8, -0.4, -0.4));
}

// ------------------------------------------------------------------ baking

function track(rig, name, duration, samples, fill, keys, withPos) {
    const times = [];
    const data = { quat: {}, pos: withPos ? [] : null };
    for (const k of keys) data.quat[k] = [];
    for (let i = 0; i <= samples; i++) {
        times.push(duration * i / samples);
        fill(i / samples);
        rig.read(keys, data);
    }
    const tracks = [];
    for (const k of keys) tracks.push(new THREE.QuaternionKeyframeTrack(`${rig.bones[k].name}.quaternion`, times, data.quat[k]));
    if (withPos) tracks.push(new THREE.VectorKeyframeTrack(`${rig.bones.hips.name}.position`, times, data.pos));
    return new THREE.AnimationClip(name, duration, tracks);
}

export function bakeLower(rig) {
    const clips = {};
    for (const kind of LOWER_STATES) {
        const cyc = kind === 'walk' || kind === 'run' || kind === 'crouchWalk';
        const samples = cyc ? GAIT_SAMPLES : 8;
        clips[kind] = track(rig, `lower_${kind}`, DURATION[kind], samples, (u) => applyLowerPose(rig, lowerPose(kind, u)), LOWER_BONES, true);
    }
    return clips;
}

export function bakeUpper(rig, weaponKey) {
    const clips = {};
    const shifts = { aim: 0, low: 0, sitL: 0, sitR: 0, clutch: 0 };
    const hold = (name, fn) => {
        clips[name] = track(rig, `upper_${weaponKey}_${name}`, 1, 1, () => { shifts[name] = fn() || 0; }, ARM_BONES, false);
    };
    hold('aim', () => applyHoldArms(rig, weaponKey, 'aim'));
    hold('low', () => applyHoldArms(rig, weaponKey, 'low'));
    hold('sitL', () => applyHoldArms(rig, weaponKey, 'sitL'));
    hold('sitR', () => applyHoldArms(rig, weaponKey, 'sitR'));
    hold('clutch', () => applyClutchArms(rig));
    rig.reset();
    clips.shifts = shifts;
    return clips;
}

// Builds everything shared by all soldiers of one rig: lower clips, rest data, lazily baked arm clips per weapon.
export function bakeTemplate(engine, key) {
    const built = engine.assets.instantiateSkinned(key, 1.82);
    if (!built) return null;
    const group = new THREE.Group();
    group.add(built.model);
    const bones = engine.physics.extractSoldierBones(built.model);
    for (const k of POSE_BONES) if (!bones[k]) return null;
    const rig = new Rig(group, bones);
    const data = {
        key,
        rig,
        lower: bakeLower(rig),
        upper: new Map(),
        restChestQ: rig.rest.chest.wq.clone(),
        restChestPos: rig.rest.chest.wp.clone(),
        armLength: rig.upperArm + rig.foreArm
    };
    rig.reset();
    data.getUpper = (weaponKey) => {
        let u = data.upper.get(weaponKey);
        if (!u) {
            u = bakeUpper(rig, weaponKey);
            data.upper.set(weaponKey, u);
        }
        return u;
    };
    return data;
}
