import * as THREE from 'three';

// Rig-independent skeleton maths: poses are described as bone directions and root-frame rotations, then converted
// to local quaternions through the live hierarchy, so the Mixamo axis conventions never appear in the data.
export const POSE_BONES = [
    'hips', 'spine', 'chest', 'head',
    'upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR',
    'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR'
];
export const LOWER_BONES = ['hips', 'spine', 'chest', 'head', 'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR'];
export const ARM_BONES = ['upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR'];

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _qp = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _e = new THREE.Euler();
const _S = new THREE.Vector3();
const _E = new THREE.Vector3();
const _W = new THREE.Vector3();
const _T = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _Ek = new THREE.Vector3();

export function worldPos(bone, out) {
    bone.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(bone.matrixWorld);
}

export function worldQuat(bone, out) {
    bone.updateWorldMatrix(true, false);
    bone.matrixWorld.decompose(_p, out, _s);
    return out;
}

// Sets a bone's world rotation (through its parent) and refreshes the subtree.
export function setWorldQuat(bone, qw) {
    const parent = bone.parent;
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(_p, _qp, _s);
    bone.quaternion.copy(_qp.invert()).multiply(qw);
    bone.updateMatrixWorld(true);
}

// Root-frame rotation delta (applied about the bone's own joint) on top of its current world rotation.
export function applyDelta(bone, delta) {
    worldQuat(bone, _qw);
    _qw.premultiply(delta);
    setWorldQuat(bone, _qw);
}

// Minimal swing so that the direction bone -> child points at `target` (world).
export function aimBone(bone, child, target) {
    worldPos(bone, _a);
    worldPos(child, _b);
    _c.subVectors(_b, _a).normalize();
    _d.subVectors(target, _a);
    if (_d.lengthSq() < 1e-10) return;
    _d.normalize();
    _qs.setFromUnitVectors(_c, _d);
    worldQuat(bone, _qw);
    _qw.premultiply(_qs);
    setWorldQuat(bone, _qw);
}

export function eulerQuat(pitch, yaw, roll, out) {
    return out.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ'));
}

// Analytic two-bone IK. Returns the distance the target is out of reach (0 when reachable).
export function solveArm(upper, lower, hand, target, pole) {
    worldPos(upper, _S);
    worldPos(lower, _E);
    worldPos(hand, _W);
    const l1 = _S.distanceTo(_E);
    const l2 = _E.distanceTo(_W);
    _d.subVectors(target, _S);
    const dist = _d.length();
    if (dist < 1e-6) return 0;
    const dc = Math.min((l1 + l2) * 0.999, Math.max(Math.abs(l1 - l2) + 0.01, dist));
    _d.multiplyScalar(1 / dist);
    _T.copy(_S).addScaledVector(_d, dc);
    const along = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    _pv.copy(pole);
    _pv.addScaledVector(_d, -_pv.dot(_d));
    if (_pv.lengthSq() < 1e-6) _pv.set(0, -1, 0).addScaledVector(_d, _d.y);
    _pv.normalize();
    _Ek.copy(_S).addScaledVector(_d, along).addScaledVector(_pv, h);
    aimBone(upper, lower, _Ek);
    aimBone(lower, hand, _T);
    return Math.max(0, dist - dc);
}

// Turns the hand about the forearm axis until its palm (local +Z) faces `normal` (world).
export function orientHand(hand, normal) {
    worldQuat(hand, _qw);
    _a.set(0, 1, 0).applyQuaternion(_qw);
    _b.set(0, 0, 1).applyQuaternion(_qw);
    _c.copy(normal).addScaledVector(_a, -normal.dot(_a));
    if (_c.lengthSq() < 1e-8) return;
    _c.normalize();
    _b.addScaledVector(_a, -_b.dot(_a)).normalize();
    _d.crossVectors(_b, _c);
    const angle = Math.atan2(_a.dot(_d), _b.dot(_c));
    _qs.setFromAxisAngle(_a, angle);
    _qw.premultiply(_qs);
    setWorldQuat(hand, _qw);
}

// Rest data of one rig instance (taken from a clean clone in its bind pose, root at the identity).
export class Rig {
    constructor(model, bones) {
        this.model = model;
        this.bones = bones;
        model.updateMatrixWorld(true);
        this.rest = {};
        for (const k of POSE_BONES) {
            const b = bones[k];
            this.rest[k] = { q: b.quaternion.clone(), wq: worldQuat(b, new THREE.Quaternion()), wp: worldPos(b, new THREE.Vector3()) };
        }
        this.hipsLocal = bones.hips.position.clone();
        this.thigh = this.rest.upperLegL.wp.distanceTo(this.rest.lowerLegL.wp);
        this.shin = this.rest.lowerLegL.wp.distanceTo(this.rest.footL.wp);
        this.ankleY = this.rest.footL.wp.y;
        this.upperArm = this.rest.upperArmL.wp.distanceTo(this.rest.lowerArmL.wp);
        this.foreArm = this.rest.lowerArmL.wp.distanceTo(this.rest.handL.wp);
    }

    reset() {
        for (const k of POSE_BONES) this.bones[k].quaternion.copy(this.rest[k].q);
        this.bones.hips.position.copy(this.hipsLocal);
        this.model.updateMatrixWorld(true);
    }

    // Local rotations (and the hips position) of the listed bones, flattened for a keyframe track.
    read(keys, out) {
        for (let i = 0; i < keys.length; i++) {
            const q = this.bones[keys[i]].quaternion;
            out.quat[keys[i]].push(q.x, q.y, q.z, q.w);
        }
        if (out.pos) {
            const p = this.bones.hips.position;
            out.pos.push(p.x, p.y, p.z);
        }
    }
}
