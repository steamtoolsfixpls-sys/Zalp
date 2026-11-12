import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    createPhysicsCore, SNAP, CTRL_STRIDE, EVENT_PROP_BROKEN, KIND_DEBRIS, KIND_PROP, RAG_PART_NAMES
} from './src/physics/core.js';
import { GRAVITY, getVehicleTuning } from './src/physics/vehicle_tuning.js';

// Main-thread facade of the physics layer. The simulation itself lives in src/physics/core.js and runs
// either in src/physics/worker.js or, with the very same commands and snapshots, synchronously here
// (settings.physicsWorker = false, no module workers, file: pages, or as soon as the deterministic test
// hook BATTLE_ENGINE.step is used). Hitboxes, riders and roadkill stay here and use mirrored transforms.

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _vFwd = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qRider = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const MAX_VEHICLES = 32;
const WORKER_BOOT_MS = 12000;

// Ragdoll part order (see RAG_PART_NAMES): bone of each part and the bone that ends its segment.
const PART_BONES = ['hips', 'chest', 'head', 'upperArmL', 'lowerArmL', 'upperArmR', 'lowerArmR', 'upperLegL', 'lowerLegL', 'upperLegR', 'lowerLegR'];
const PART_ENDS = [null, null, null, 'lowerArmL', 'handL', 'lowerArmR', 'handR', 'lowerLegL', 'footL', 'lowerLegR', 'footR'];
// Pose for units without a skeleton: joint positions in the root frame (root faces +Z).
const FALLBACK_POSE = [
    [0, 0.94, 0], [0, 1.30, 0], [0, 1.66, 0], [-0.24, 1.38, 0], [-0.34, 1.12, 0], [0.24, 1.38, 0], [0.34, 1.12, 0],
    [-0.13, 0.64, 0], [-0.13, 0.28, 0], [0.13, 0.64, 0], [0.13, 0.28, 0]
];
const FALLBACK_NEXT = [-1, -1, -1, 4, -1, 6, -1, 8, -1, 10, -1];

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const num = (value, fallback) => (typeof value === 'number' && value === value ? value : fallback);

export class RagdollPhysicsEngine {
    constructor(scene, engine = null) {
        this.scene = scene;
        this.engine = engine;
        this.ready = false;
        this.ragdolls = [];
        this.debrisBodies = [];
        this.props = [];
        this.hitboxMeshes = [];
        this.vehicles = [];
        // 'sync' | 'worker'; stepMs is the smoothed main-thread cost of step(), coreMs the simulation cost.
        this.mode = 'none';
        this.stats = { mode: 'none', reason: '', stepMs: 0, lastMs: 0, coreMs: 0, frames: 0 };

        this._core = null;
        this._worker = null;
        this._workerReady = false;
        this._bootTimer = 0;
        this._inFlight = 0;
        this._pendingDt = 0;
        this._inbox = [];
        this._freeSnaps = [];
        this._freeCtrl = [];
        this._cmds = [];
        this._ctrl = new Float32Array(CTRL_STRIDE * MAX_VEHICLES);
        this._snap = new Float32Array(4096);
        this._nextId = 1;
        this._vehById = new Map();
        this._ragById = new Map();
        this._bodyById = new Map();
        this._statics = new Map();
        this._rng = mulberry32(0x5eed);
        this._hitGeo = new Map();
        this._hitMat = null;
        this._shared = {};
    }

    async init() {
        await RAPIER.init();
        this.engine = this.engine || globalThis.BATTLE_ENGINE?.instance || null;
        const settings = this.engine?.settings;
        const allowed = settings && typeof settings.get === 'function' ? settings.get('physicsWorker') !== false : true;
        this._cmds.push({ t: 'cfg', hz: this._hz() });
        if (allowed && typeof Worker !== 'undefined' && typeof location !== 'undefined' && location.protocol !== 'file:') {
            this._startWorker();
        } else {
            this._startSync(allowed ? 'no module workers here' : 'settings.physicsWorker = false');
        }
        this.ready = true;

        this.engine?.events?.on?.('quality:changed', () => this._cmds.push({ t: 'cfg', hz: this._hz() }));
        // BATTLE_ENGINE.step(n, dt) must advance the world synchronously and deterministically, which a
        // worker cannot do: the first use of the hook moves the simulation onto this thread for good.
        const hook = globalThis.BATTLE_ENGINE;
        if (hook && typeof hook.step === 'function' && !hook.step.physicsSync) {
            const original = hook.step;
            const wrapped = (n, dt) => {
                this._enterSync('test hook');
                return original(n, dt);
            };
            wrapped.physicsSync = true;
            hook.step = wrapped;
        }
    }

    _hz() {
        return this.engine?.quality?.profile?.physics?.hz || 60;
    }

    _setMode(mode, reason) {
        this.mode = mode;
        this.stats.mode = mode;
        this.stats.reason = reason;
    }

    _startSync(reason) {
        this._core = createPhysicsCore(RAPIER, { hz: this._hz() });
        this._setMode('sync', reason);
    }

    _startWorker() {
        try {
            const worker = new Worker(new URL('./src/physics/worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = (e) => this._onWorkerMessage(e.data);
            worker.onerror = (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                this._enterSync('worker failed to load');
            };
            this._worker = worker;
            this._setMode('worker', 'settings.physicsWorker');
            this._bootTimer = setTimeout(() => {
                if (!this._workerReady) this._enterSync('worker did not start');
            }, WORKER_BOOT_MS);
        } catch {
            this._startSync('worker unavailable');
        }
    }

    _onWorkerMessage(msg) {
        if (this.mode !== 'worker' || !msg) return;
        if (msg.type === 'ready') {
            this._workerReady = true;
            clearTimeout(this._bootTimer);
        } else if (msg.type === 'snap') {
            this._inFlight--;
            this._inbox.push(msg.snap);
            if (msg.ctrl) this._freeCtrl.push(msg.ctrl);
        } else if (msg.type === 'error') {
            this._enterSync(`worker error: ${msg.message}`);
        }
    }

    // Moves the simulation onto this thread, rebuilding the world from the mirrored state.
    _enterSync(reason) {
        if (this.mode !== 'worker') return;
        clearTimeout(this._bootTimer);
        if (this._worker) {
            this._worker.onmessage = null;
            this._worker.onerror = null;
            this._worker.terminate();
            this._worker = null;
        }
        for (const snap of this._inbox) this._applySnapshot(snap);
        this._inbox.length = 0;
        this._inFlight = 0;
        this._pendingDt = 0;

        const cmds = [{ t: 'cfg', hz: this._hz() }];
        for (const desc of this._statics.values()) cmds.push(desc);
        for (const v of this.vehicles) {
            cmds.push({
                t: 'veh', id: v.pid, spec: v._spec,
                p: [v.chassisPos.x, v.chassisPos.y, v.chassisPos.z],
                q: [v.chassisQuat.x, v.chassisQuat.y, v.chassisQuat.z, v.chassisQuat.w],
                lv: [v.linvel.x, v.linvel.y, v.linvel.z],
                av: [v._angvel.x, v._angvel.y, v._angvel.z]
            });
        }
        for (const list of [this.debrisBodies, this.props]) {
            for (const b of list) {
                if (b.seen) {
                    const o = b.object3d;
                    cmds.push({
                        ...b.desc,
                        p: [o.position.x, o.position.y, o.position.z],
                        q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
                        lv: null, av: null, imp: null, timp: null
                    });
                } else {
                    cmds.push(b.desc);
                }
            }
        }
        for (const rag of this.ragdolls) {
            if (rag.frozen) continue;
            if (!rag.seen) cmds.push(rag.cmd);
            else this._freezeRagdoll(rag, false);   // keeps its pose; the bodies died with the worker
        }
        this._cmds = cmds;
        this._core = createPhysicsCore(RAPIER, { hz: this._hz() });
        this._setMode('sync', reason);
    }

    // ------------------------------------------------------------------ static world and props

    addStaticBoxCollider(pos, halfExtents, quat = null) {
        if (!this.ready) return null;
        const id = this._nextId++;
        const desc = {
            t: 'static', id,
            p: [pos.x, pos.y, pos.z],
            h: [halfExtents.x, halfExtents.y, halfExtents.z],
            q: quat ? [quat.x, quat.y, quat.z, quat.w] : null
        };
        this._statics.set(id, desc);
        this._cmds.push(desc);
        return { id, kind: 'static' };
    }

    removeStaticCollider(handle) {
        if (!handle || !this._statics.delete(handle.id)) return;
        this._cmds.push({ t: 'staticRemove', id: handle.id });
    }

    // Dynamic body mirrored onto `object3d` (its parent must not be transformed). shape:
    // { type: 'box', half } | { type: 'ball', r } | { type: 'capsule' | 'cylinder' | 'cone', halfHeight, r }
    // | { type: 'hull', points }, each with an optional `offset` from the object origin. Without a shape
    // the bounding box is used. `breakable` props splinter into debris when rammed, crushed or dropped.
    addDynamicProp({
        object3d, shape = null, mass = 100, friction = 0.7, restitution = 0.1, ccd = false,
        breakable = false, breakForce = 0, breakImpulse = 0, splinter = true, onBreak = null
    } = {}) {
        if (!this.ready || !object3d) return null;
        if (!shape) {
            object3d.updateWorldMatrix(true, true);
            const box = new THREE.Box3().setFromObject(object3d);
            const size = box.getSize(new THREE.Vector3());
            const centre = box.getCenter(new THREE.Vector3()).sub(object3d.position);
            shape = {
                type: 'box',
                half: [Math.max(0.05, size.x * 0.5), Math.max(0.05, size.y * 0.5), Math.max(0.05, size.z * 0.5)],
                offset: [centre.x, centre.y, centre.z]
            };
        }
        if (breakable && !breakForce && !breakImpulse) {
            breakImpulse = mass * 3.5;
            breakForce = mass * GRAVITY * 40;
        }
        const id = this._nextId++;
        const p = object3d.position;
        const q = object3d.quaternion;
        const desc = {
            t: 'body', id, kind: KIND_PROP, shape, mass, friction, restitution, ccd,
            breakForce, breakImpulse, linDamp: 0.05, angDamp: 0.25,
            p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], lv: null, av: null, imp: null, timp: null
        };
        const handle = { id, kind: 'prop', object3d, mesh: object3d, shape, mass, broken: false, splinter, onBreak, desc, seen: false, asleep: false };
        object3d.userData.physicsProp = handle;
        this.props.push(handle);
        this._bodyById.set(id, handle);
        this._cmds.push(desc);
        return handle;
    }

    removeProp(handle) {
        if (!handle || !this._bodyById.delete(handle.id)) return;
        const i = this.props.indexOf(handle);
        if (i !== -1) this.props.splice(i, 1);
        this._cmds.push({ t: 'bodyRemove', id: handle.id });
    }

    applyPropImpulse(handle, impulse, point = null) {
        if (!handle || !this._bodyById.has(handle.id)) return;
        this._cmds.push({
            t: 'bodyImpulse', id: handle.id,
            i: [impulse.x, impulse.y, impulse.z],
            p: point ? [point.x, point.y, point.z] : null
        });
    }

    _breakProp(handle, x, y, z, magnitude) {
        if (handle.broken) return;
        handle.broken = true;
        const object3d = handle.object3d;
        if (handle.splinter !== false) {
            this._splinter(handle);
            object3d.visible = false;
        }
        this.removeProp(handle);
        _v1.set(x, y, z);
        if (typeof handle.onBreak === 'function') handle.onBreak(handle, { pos: _v1, magnitude });
        this.engine?.events?.emit?.('prop:broken', { prop: handle, object3d, pos: _v1, magnitude });
    }

    _splinter(handle) {
        const shared = this._shared;
        if (!shared.box) shared.box = new THREE.BoxGeometry(1, 1, 1);
        if (!shared.wood) shared.wood = new THREE.MeshStandardMaterial({ color: 0x8a6a3c, roughness: 0.9 });
        let material = shared.wood;
        handle.object3d.traverse((child) => {
            if (material === shared.wood && child.isMesh && child.material && !Array.isArray(child.material)) material = child.material;
        });
        const half = handle.shape.half || [handle.shape.r || 0.3, handle.shape.halfHeight || handle.shape.r || 0.3, handle.shape.r || 0.3];
        const off = handle.shape.offset || [0, 0, 0];
        const budget = this.engine?.quality?.profile?.debris?.max ?? 30;
        const pieces = Math.max(3, Math.min(8, Math.floor(budget / 3)));
        const rnd = this._rng;
        const origin = handle.object3d.position;
        const quat = handle.object3d.quaternion;
        for (let i = 0; i < pieces; i++) {
            const sx = half[0] * (0.5 + rnd() * 0.7);
            const sy = Math.max(0.02, half[1] * (0.08 + rnd() * 0.18));
            const sz = half[2] * (0.25 + rnd() * 0.5);
            const mesh = new THREE.Mesh(shared.box, material);
            mesh.castShadow = true;
            mesh.scale.set(sx * 2, sy * 2, sz * 2);
            _v2.set(off[0] + (rnd() - 0.5) * half[0], off[1] + (rnd() - 0.5) * half[1], off[2] + (rnd() - 0.5) * half[2]).applyQuaternion(quat);
            mesh.position.copy(origin).add(_v2);
            mesh.quaternion.copy(quat);
            this.spawnDebris(mesh, {
                shape: { type: 'box', half: [sx, sy, sz] },
                mass: Math.max(0.5, handle.mass / pieces),
                linvel: { x: _v2.x * 4 + (rnd() - 0.5) * 2, y: 2 + rnd() * 3, z: _v2.z * 4 + (rnd() - 0.5) * 2 },
                angvel: { x: (rnd() - 0.5) * 12, y: (rnd() - 0.5) * 12, z: (rnd() - 0.5) * 12 },
                ttl: 9 + rnd() * 4,
                friction: 0.8,
                restitution: 0.15
            });
        }
    }

    // ------------------------------------------------------------------ vehicles

    createPhysicalVehicle(spec, meshGroup, spawnPos, spawnYaw = 0) {
        if (!this.ready) return null;
        const tuning = getVehicleTuning(spec);
        const hx = spec.halfExtents[0];
        const hy = spec.halfExtents[1];
        const hz = spec.halfExtents[2];
        const pid = this._nextId++;
        const initQuat = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, spawnYaw);

        const suspPoints = tuning.points.map((pt) => ({
            local: new THREE.Vector3(pt.x, pt.y, pt.z), compression: tuning.sag, grounded: true
        }));

        const hitProxyGeo = new THREE.BoxGeometry(hx * 2.0, hy * 2.1, hz * 2.0);
        const hitProxyMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitProxyMesh = new THREE.Mesh(hitProxyGeo, hitProxyMat);
        hitProxyMesh.position.set(0, hy, 0);
        meshGroup.add(hitProxyMesh);
        meshGroup.position.copy(spawnPos);
        meshGroup.quaternion.copy(initQuat);

        const vehicleObj = {
            id: `${spec.key}_${pid}`,
            pid,
            spec,
            name: spec.name,
            faction: spec.faction,
            mesh: meshGroup,
            hitProxyMesh,
            suspPoints,
            hp: spec.maxHp,
            maxHp: spec.maxHp,
            destroyed: false,
            controls: {
                throttle: 0,
                steer: 0,
                brake: false,
                aiAutopilot: false,
                aiTargetZ: -25
            },
            turretYaw: spawnYaw,
            turretPitch: 0,
            fireTimer: 0,
            speedKmh: 0,
            chassisPos: new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z),
            chassisQuat: initQuat.clone(),
            prevChassisPos: new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z),
            frameDeltaPos: new THREE.Vector3(),
            desantUnits: new Array(spec.desantSlots.length).fill(null),
            playerSeatedMode: null,
            playerDesantSlot: -1,
            // Read-only telemetry mirrored from the simulation.
            gear: 0,
            rpm: tuning.rpmIdle,
            slip: 0,
            torque: 0,
            shifting: false,
            linvel: new THREE.Vector3(),
            forwardSpeed: 0,
            angvelY: 0,
            wheelSpin: new Float32Array(suspPoints.length),
            tuning,
            suspSag: tuning.sag,
            wheelRadius: tuning.wheelR,
            _angvel: new THREE.Vector3(),
            _spec: { key: spec.key, driveType: spec.driveType, halfExtents: [hx, hy, hz], mass: spec.mass }
        };

        hitProxyMesh.userData = {
            isVehicleHitbox: true,
            vehicle: vehicleObj
        };

        this.vehicles.push(vehicleObj);
        this._vehById.set(pid, vehicleObj);
        this._cmds.push({
            t: 'veh', id: pid, spec: vehicleObj._spec,
            p: [spawnPos.x, spawnPos.y, spawnPos.z],
            q: [initQuat.x, initQuat.y, initQuat.z, initQuat.w]
        });
        return vehicleObj;
    }

    applyCannonRecoil(vehicle, muzzleDirWorld) {
        if (!vehicle || !this._vehById.has(vehicle.pid) || vehicle.destroyed) return;
        this._cmds.push({
            t: 'vehRecoil', id: vehicle.pid,
            d: [muzzleDirWorld.x, muzzleDirWorld.y, muzzleDirWorld.z],
            m: vehicle.spec.recoilImpulse || 0
        });
    }

    applyVehicleImpulse(vehicle, impulse, worldPoint = null) {
        if (!vehicle || !this._vehById.has(vehicle.pid)) return;
        this._cmds.push({
            t: 'vehImpulse', id: vehicle.pid,
            i: [impulse.x, impulse.y, impulse.z],
            p: worldPoint ? [worldPoint.x, worldPoint.y, worldPoint.z] : null
        });
    }

    spawnBlownTurretDebris(vehicle) {
        if (!this.ready) return;
        const pos = vehicle.chassisPos;
        const rnd = this._rng;
        const mass = Math.max(400, (vehicle.tuning ? vehicle.tuning.mass : 10000) * 0.16);
        // The rig hands over the real turret when the model has one; otherwise a generic stand-in flies.
        let group = this.engine?.vehicleParts?.detachTurret?.(vehicle) || null;
        if (!group) {
            const shared = this._shared;
            if (!shared.turretGeo) {
                shared.turretGeo = new THREE.CylinderGeometry(1.25, 1.45, 0.72, 10);
                shared.barrelGeo = new THREE.CylinderGeometry(0.08, 0.09, 3.6, 8).rotateX(Math.PI * 0.5);
                shared.turretMat = new THREE.MeshStandardMaterial({ color: 0x1e1d1b, roughness: 0.9, metalness: 0.35 });
            }
            group = new THREE.Group();
            const dome = new THREE.Mesh(shared.turretGeo, shared.turretMat);
            const barrel = new THREE.Mesh(shared.barrelGeo, shared.turretMat);
            barrel.position.set(0, 0.05, -2.2);
            dome.castShadow = true;
            barrel.castShadow = true;
            group.add(dome);
            group.add(barrel);
            group.position.set(pos.x, pos.y + 2.3, pos.z);
            group.quaternion.copy(vehicle.chassisQuat);
        }
        this.spawnDebris(group, {
            shape: { type: 'ball', r: 1.15 },
            mass,
            ttl: 24,
            friction: 0.8,
            restitution: 0.15,
            linDamp: 0.25,
            angDamp: 0.35,
            impulse: { x: (rnd() - 0.5) * 4.4 * mass, y: (15 + rnd() * 5) * mass, z: (rnd() - 0.5) * 4.4 * mass },
            torqueImpulse: { x: (rnd() - 0.5) * 3.4 * mass, y: (rnd() - 0.5) * 3.0 * mass, z: (rnd() - 0.5) * 3.4 * mass },
            keep: true
        });
    }

    // ------------------------------------------------------------------ soldier hitboxes

    extractSoldierBones(root) {
        const bones = {
            hips: null,
            spine: null,
            chest: null,
            head: null,
            upperArmL: null,
            lowerArmL: null,
            handL: null,
            upperArmR: null,
            lowerArmR: null,
            handR: null,
            upperLegL: null,
            lowerLegL: null,
            footL: null,
            upperLegR: null,
            lowerLegR: null,
            footR: null
        };
        const finger = (n) => n.includes('Index') || n.includes('Thumb') || n.includes('Middle') || n.includes('Ring') || n.includes('Pinky');

        root.traverse((obj) => {
            if (!obj.isBone) return;
            const n = obj.name;
            if (n.includes('Hips') && !bones.hips) bones.hips = obj;
            else if (n.includes('Spine2') && !bones.chest) bones.chest = obj;
            else if (n.includes('Spine1') && !bones.spine) bones.spine = obj;
            else if (n.includes('Spine') && !bones.spine) bones.spine = obj;
            else if (n.includes('Head') && !n.includes('Top') && !bones.head) bones.head = obj;
            else if (n.includes('LeftArm') && !bones.upperArmL) bones.upperArmL = obj;
            else if (n.includes('LeftForeArm') && !bones.lowerArmL) bones.lowerArmL = obj;
            else if (n.includes('LeftHand') && !finger(n) && !bones.handL) bones.handL = obj;
            else if (n.includes('RightArm') && !bones.upperArmR) bones.upperArmR = obj;
            else if (n.includes('RightForeArm') && !bones.lowerArmR) bones.lowerArmR = obj;
            else if (n.includes('RightHand') && !finger(n) && !bones.handR) bones.handR = obj;
            else if (n.includes('LeftUpLeg') && !bones.upperLegL) bones.upperLegL = obj;
            else if (n.includes('LeftLeg') && !bones.lowerLegL) bones.lowerLegL = obj;
            else if (n.includes('LeftFoot') && !bones.footL) bones.footL = obj;
            else if (n.includes('RightUpLeg') && !bones.upperLegR) bones.upperLegR = obj;
            else if (n.includes('RightLeg') && !bones.lowerLegR) bones.lowerLegR = obj;
            else if (n.includes('RightFoot') && !bones.footR) bones.footR = obj;
        });

        if (!bones.chest && bones.spine) bones.chest = bones.spine;
        return bones;
    }

    attachAnatomicalHitboxes(unit) {
        if (!this._hitMat) this._hitMat = new THREE.MeshBasicMaterial({ visible: false });
        const b = unit.bones || {};
        const defs = [
            { part: 'head', bone: b.head, zone: 'HEAD', r: 0.16, h: 0.24, offsetY: 0.08 },
            { part: 'torso', bone: b.chest, zone: 'TORSO', r: 0.23, h: 0.44, offsetY: 0.02 },
            { part: 'pelvis', bone: b.hips, zone: 'TORSO', r: 0.21, h: 0.26, offsetY: 0.0 },
            { part: 'upperArmL', bone: b.upperArmL, zone: 'ARM', r: 0.09, h: 0.28, offsetY: 0.1 },
            { part: 'lowerArmL', bone: b.lowerArmL, zone: 'ARM', r: 0.08, h: 0.26, offsetY: 0.1 },
            { part: 'upperArmR', bone: b.upperArmR, zone: 'ARM', r: 0.09, h: 0.28, offsetY: 0.1 },
            { part: 'lowerArmR', bone: b.lowerArmR, zone: 'ARM', r: 0.08, h: 0.26, offsetY: 0.1 },
            { part: 'upperLegL', bone: b.upperLegL, zone: 'LEG', r: 0.12, h: 0.4, offsetY: 0.16 },
            { part: 'lowerLegL', bone: b.lowerLegL, zone: 'LEG', r: 0.1, h: 0.38, offsetY: 0.16 },
            { part: 'upperLegR', bone: b.upperLegR, zone: 'LEG', r: 0.12, h: 0.4, offsetY: 0.16 },
            { part: 'lowerLegR', bone: b.lowerLegR, zone: 'LEG', r: 0.1, h: 0.38, offsetY: 0.16 }
        ];

        unit.hitboxes = [];
        for (const d of defs) {
            // One geometry per body part, shared by every soldier and kept across respawns.
            let geo = this._hitGeo.get(d.part);
            if (!geo) {
                geo = new THREE.CylinderGeometry(d.r, d.r, d.h, 8);
                this._hitGeo.set(d.part, geo);
            }
            const mesh = new THREE.Mesh(geo, this._hitMat);
            mesh.userData = {
                isSoldierHitbox: true,
                unit: unit,
                zone: d.zone,
                partName: d.part,
                bone: d.bone,
                offsetY: d.offsetY
            };
            this.scene.add(mesh);
            unit.hitboxes.push(mesh);
            this.hitboxMeshes.push(mesh);
        }
    }

    syncSoldierHitboxes(unit) {
        if (!unit.hitboxes || unit.isDead) return;
        for (const hb of unit.hitboxes) {
            const bone = hb.userData.bone;
            if (bone) {
                bone.getWorldPosition(_v1);
                bone.getWorldQuaternion(_q1);
                hb.position.copy(_v1);
                hb.quaternion.copy(_q1);
            } else {
                hb.position.copy(unit.root.position);
                hb.position.y += 1.0;
            }
        }
    }

    removeUnitHitboxes(unit) {
        if (!unit.hitboxes) return;
        for (const hb of unit.hitboxes) {
            this.scene.remove(hb);
            const idx = this.hitboxMeshes.indexOf(hb);
            if (idx !== -1) this.hitboxMeshes.splice(idx, 1);
        }
        unit.hitboxes.length = 0;
    }

    // ------------------------------------------------------------------ debris

    spawnFlyingHelmet(headWorldPos, impulseVec, faction) {
        if (!this.ready) return;
        const shared = this._shared;
        if (!shared.helmetGeo) {
            shared.helmetGeo = new THREE.SphereGeometry(0.145, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
            const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.25, side: THREE.DoubleSide });
            shared.helmetRU = mat(0x2f3b28);
            shared.helmetUA = mat(0x434936);
        }
        const rnd = this._rng;
        const mesh = new THREE.Mesh(shared.helmetGeo, faction === 'RU' ? shared.helmetRU : shared.helmetUA);
        mesh.castShadow = true;
        mesh.position.copy(headWorldPos);
        mesh.position.y += 0.12;
        this.spawnDebris(mesh, {
            shape: { type: 'ball', r: 0.14 },
            mass: 1.4,
            ttl: 14,
            friction: 0.6,
            restitution: 0.35,
            linDamp: 0.35,
            angDamp: 0.25,
            impulse: {
                x: impulseVec.x * 0.35 + (rnd() - 0.5) * 3.0,
                y: Math.max(4.5, Math.abs(impulseVec.y) * 0.4 + 5.2),
                z: impulseVec.z * 0.35 + (rnd() - 0.5) * 3.0
            },
            torqueImpulse: { x: (rnd() - 0.5) * 1.4, y: (rnd() - 0.5) * 1.4, z: (rnd() - 0.5) * 1.4 }
        });
    }

    // Generic short-lived dynamic prop. `mesh` (already positioned) is added to the scene and follows the body.
    // shape: { type: 'ball', r } | { type: 'box', half: [x, y, z] } | { type: 'capsule', halfHeight, r }
    spawnDebris(mesh, {
        shape = { type: 'ball', r: 0.1 }, mass = 1, linvel = null, angvel = null, ttl = 12, friction = 0.6, restitution = 0.3,
        linDamp = 0.3, angDamp = 0.3, impulse = null, torqueImpulse = null, keep = false
    } = {}) {
        if (!this.ready) return null;
        const id = this._nextId++;
        const p = mesh.position;
        const q = mesh.quaternion;
        const desc = {
            t: 'body', id, kind: KIND_DEBRIS, shape, mass, friction, restitution, linDamp, angDamp,
            p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w],
            lv: linvel ? [linvel.x, linvel.y, linvel.z] : null,
            av: angvel ? [angvel.x, angvel.y, angvel.z] : null,
            imp: impulse ? [impulse.x, impulse.y, impulse.z] : null,
            timp: torqueImpulse ? [torqueImpulse.x, torqueImpulse.y, torqueImpulse.z] : null
        };
        if (mesh.parent !== this.scene) this.scene.add(mesh);
        const entry = { id, kind: 'debris', mesh, object3d: mesh, ttl, desc, seen: false, asleep: false, keep };
        this.debrisBodies.push(entry);
        this._bodyById.set(id, entry);
        this._cmds.push(desc);

        // Debris budget of the graphics preset: the oldest ordinary piece makes room.
        const max = this.engine?.quality?.profile?.debris?.max ?? 60;
        if (this.debrisBodies.length > max) {
            const oldest = this.debrisBodies.findIndex((d) => !d.keep);
            if (oldest !== -1 && this.debrisBodies[oldest] !== entry) this._removeDebrisAt(oldest);
        }
        return entry;
    }

    _removeDebrisAt(index) {
        const item = this.debrisBodies[index];
        this.debrisBodies.splice(index, 1);
        this.scene.remove(item.mesh);
        this._bodyById.delete(item.id);
        this._cmds.push({ t: 'bodyRemove', id: item.id });
    }

    // ------------------------------------------------------------------ ragdolls

    // Hands a soldier over from animation to physics. Bodies start exactly on the current bone transforms
    // and inherit the unit's motion; the root keeps its orientation, so nothing snaps on the first frame.
    triggerArticulatedRagdoll(unit, hitPartName, impulseVec, hitPointWorld) {
        this.removeUnitHitboxes(unit);
        if (!this.ready) return null;
        if (this.ragdolls.some((r) => r.unit === unit)) this.removeRagdoll(unit);

        let vx = 0, vy = 0, vz = 0;
        const carrier = unit.mountedVehicle;
        if (carrier) {
            if (carrier.linvel) {
                vx = carrier.linvel.x; vy = carrier.linvel.y; vz = carrier.linvel.z;
            }
            const sIdx = carrier.desantUnits ? carrier.desantUnits.indexOf(unit) : -1;
            if (sIdx !== -1) carrier.desantUnits[sIdx] = null;
            unit.mountedVehicle = null;
        } else if (unit.velocity) {
            vx = num(unit.velocity.x, 0); vy = num(unit.velocity.y, 0); vz = num(unit.velocity.z, 0);
        }

        const b = unit.bones || {};
        const root = unit.root;
        root.updateWorldMatrix(true, true);
        const yaw = root.rotation.y;
        const parts = new Float32Array(RAG_PART_NAMES.length * 10);
        const bones = [];
        for (let i = 0; i < PART_BONES.length; i++) {
            const bone = b[PART_BONES[i]] || null;
            const o = i * 10;
            bones.push(bone);
            if (bone) {
                bone.matrixWorld.decompose(_v1, _q1, _v3);
                const end = PART_ENDS[i] ? b[PART_ENDS[i]] : null;
                if (end) {
                    // Segment vector to the next joint, in the frame of this body.
                    _v2.setFromMatrixPosition(end.matrixWorld).sub(_v1).applyQuaternion(_q2.copy(_q1).invert());
                    parts[o + 7] = _v2.x; parts[o + 8] = _v2.y; parts[o + 9] = _v2.z;
                }
            } else {
                const f = FALLBACK_POSE[i];
                _q1.setFromAxisAngle(Y_AXIS, yaw);
                _v1.set(f[0], f[1], f[2]).applyQuaternion(_q1).add(root.position);
                const next = FALLBACK_NEXT[i];
                if (next !== -1) {
                    parts[o + 7] = FALLBACK_POSE[next][0] - f[0];
                    parts[o + 8] = FALLBACK_POSE[next][1] - f[1];
                } else if (i > 2) {
                    parts[o + 8] = -0.26;
                }
            }
            parts[o] = _v1.x; parts[o + 1] = Math.max(0.05, _v1.y); parts[o + 2] = _v1.z;
            parts[o + 3] = _q1.x; parts[o + 4] = _q1.y; parts[o + 5] = _q1.z; parts[o + 6] = _q1.w;
        }

        const id = this._nextId++;
        const cmd = {
            t: 'rag', id, parts, lv: [vx, vy, vz],
            hit: RAG_PART_NAMES.indexOf(hitPartName),
            imp: impulseVec ? [impulseVec.x, impulseVec.y, impulseVec.z] : null,
            hp: hitPointWorld ? [hitPointWorld.x, hitPointWorld.y, hitPointWorld.z] : null,
            seed: id
        };
        const ragdollEntry = {
            id, unit, bones, age: 0, settled: false, frozen: false, synced: false, seen: false, cmd,
            offX: root.position.x - parts[0],
            offZ: root.position.z - parts[2],
            rootY: root.position.y
        };
        this.ragdolls.push(ragdollEntry);
        this._ragById.set(id, ragdollEntry);
        this._cmds.push(cmd);
        this._enforceRagdollLimit();
        return ragdollEntry;
    }

    // quality.ragdolls.max live ragdolls: the oldest settled one (else the oldest) keeps its pose as a
    // static corpse and gives its bodies back to the solver.
    _enforceRagdollLimit() {
        const max = Math.max(1, this.engine?.quality?.profile?.ragdolls?.max ?? 8);
        let live = 0;
        for (const r of this.ragdolls) if (!r.frozen) live++;
        while (live > max) {
            let pick = null;
            for (const r of this.ragdolls) {
                if (r.frozen) continue;
                if (!pick) pick = r;
                if (r.settled) {
                    pick = r;
                    break;
                }
            }
            if (!pick) break;
            this._freezeRagdoll(pick, true);
            live--;
        }
    }

    _freezeRagdoll(rag, release) {
        rag.frozen = true;
        rag.settled = true;
        this._ragById.delete(rag.id);
        if (release) this._cmds.push({ t: 'ragRemove', id: rag.id });
    }

    removeRagdoll(unit) {
        const idx = this.ragdolls.findIndex((r) => r.unit === unit);
        if (idx === -1) return;
        const rag = this.ragdolls[idx];
        if (!rag.frozen) {
            this._ragById.delete(rag.id);
            this._cmds.push({ t: 'ragRemove', id: rag.id });
        }
        this.ragdolls.splice(idx, 1);
    }

    applyExplosionBlastToRagdolls(epicenter, radius, peakForce) {
        if (!this.ready) return;
        this._cmds.push({ t: 'blast', p: [epicenter.x, epicenter.y, epicenter.z], r: radius, f: peakForce });
    }

    // ------------------------------------------------------------------ frame

    step(dt, allUnits, onRoadkillCallback) {
        if (!this.ready) return;
        const t0 = performance.now();
        const vehicles = this.vehicles;
        for (let i = 0; i < vehicles.length; i++) {
            const veh = vehicles[i];
            veh.prevChassisPos.copy(veh.chassisPos);
            if (veh.controls.aiAutopilot && !veh.destroyed) {
                const dz = veh.controls.aiTargetZ - veh.chassisPos.z;
                if (Math.abs(dz) > 4.0) {
                    veh.controls.throttle = dz < 0 ? 0.72 : -0.55;
                    veh.controls.brake = false;
                } else {
                    veh.controls.aiTargetZ = veh.controls.aiTargetZ < 0 ? 14.0 : -28.0;
                }
            }
        }
        const count = this._writeControls();

        if (this.mode === 'sync') {
            const snap = this._snapshotBuffer();
            this._core.frame(this._cmds, this._ctrl, count, dt, snap);
            this._cmds.length = 0;
            this._applySnapshot(snap);
        } else {
            for (let i = 0; i < this._inbox.length; i++) {
                this._applySnapshot(this._inbox[i]);
                this._freeSnaps.push(this._inbox[i]);
            }
            this._inbox.length = 0;
            this._pendingDt = Math.min(this._pendingDt + dt, 0.1);
            // At most two frames in flight: a busy worker gets one bigger step instead of a backlog.
            if (this._inFlight < 2) this._postFrame(count);
        }

        for (let i = 0; i < vehicles.length; i++) {
            const veh = vehicles[i];
            veh.frameDeltaPos.subVectors(veh.chassisPos, veh.prevChassisPos);
            this._placeRiders(veh);
            if (veh.speedKmh > 12 && allUnits && onRoadkillCallback) this._roadkill(veh, allUnits, onRoadkillCallback);
        }

        for (let i = this.debrisBodies.length - 1; i >= 0; i--) {
            const item = this.debrisBodies[i];
            item.ttl -= dt;
            if (item.ttl <= 0) this._removeDebrisAt(i);
        }
        for (let i = 0; i < this.ragdolls.length; i++) this.ragdolls[i].age += dt;
        this._enforceRagdollLimit();

        const ms = performance.now() - t0;
        this.stats.lastMs = ms;
        this.stats.stepMs += (ms - this.stats.stepMs) * 0.05;
        this.stats.frames++;
    }

    _writeControls() {
        const ctrl = this._ctrl;
        const count = Math.min(this.vehicles.length, MAX_VEHICLES);
        for (let i = 0; i < count; i++) {
            const v = this.vehicles[i];
            const c = v.controls;
            const m = v.mobility;
            const o = i * CTRL_STRIDE;
            ctrl[o] = v.pid;
            ctrl[o + 1] = num(c.throttle, 0);
            ctrl[o + 2] = num(c.steer, 0);
            ctrl[o + 3] = c.brake ? 1 : 0;
            ctrl[o + 4] = v.destroyed ? 1 : 0;
            ctrl[o + 5] = m ? num(m.engine, 1) : 1;
            ctrl[o + 6] = m ? num(m.trackL, 1) : 1;
            ctrl[o + 7] = m ? num(m.trackR, 1) : 1;
            const tires = m ? m.tires : null;
            for (let k = 0; k < 8; k++) ctrl[o + 8 + k] = tires ? num(tires[k], 1) : 1;
        }
        return count;
    }

    _snapshotSize() {
        let live = 0;
        for (const r of this.ragdolls) if (!r.frozen) live++;
        const need = SNAP.HEADER + this.vehicles.length * SNAP.VEH + (live + 2) * SNAP.RAG
            + (this.debrisBodies.length + this.props.length + 16) * SNAP.BODY + 32 * SNAP.EVENT;
        return Math.ceil(need / 2048) * 2048;
    }

    _snapshotBuffer() {
        const size = this._snapshotSize();
        if (this._snap.length < size) this._snap = new Float32Array(size);
        return this._snap;
    }

    _postFrame(count) {
        const size = this._snapshotSize();
        let snap = this._freeSnaps.pop();
        if (!snap || snap.length < size) snap = new Float32Array(size);
        const ctrl = this._freeCtrl.pop() || new Float32Array(CTRL_STRIDE * MAX_VEHICLES);
        ctrl.set(this._ctrl);
        const cmds = this._cmds;
        this._cmds = [];
        this._inFlight++;
        this._worker.postMessage({ type: 'frame', dt: this._pendingDt, cmds, ctrl, count, snap }, [ctrl.buffer, snap.buffer]);
        this._pendingDt = 0;
    }

    _applySnapshot(s) {
        let o = SNAP.HEADER;
        const nVeh = s[2], nRag = s[3], nBody = s[4], nEv = s[5];
        this.stats.coreMs += (s[6] - this.stats.coreMs) * 0.05;
        for (let i = 0; i < nVeh; i++, o += SNAP.VEH) {
            const veh = this._vehById.get(s[o]);
            if (!veh) continue;
            veh.chassisPos.set(s[o + 1], s[o + 2], s[o + 3]);
            veh.chassisQuat.set(s[o + 4], s[o + 5], s[o + 6], s[o + 7]);
            veh.linvel.set(s[o + 8], s[o + 9], s[o + 10]);
            veh._angvel.set(s[o + 11], s[o + 12], s[o + 13]);
            veh.angvelY = s[o + 12];
            veh.gear = s[o + 14];
            veh.rpm = s[o + 15];
            veh.slip = s[o + 16];
            veh.forwardSpeed = s[o + 17];
            veh.torque = s[o + 18];
            veh.shifting = (s[o + 19] & 1) !== 0;
            veh.speedKmh = Math.round(Math.hypot(s[o + 8], s[o + 10]) * 3.6);
            const points = veh.suspPoints;
            for (let k = 0; k < points.length; k++) {
                const w = o + 20 + k * 3;
                points[k].compression = s[w];
                points[k].grounded = s[w + 1] > 0.5;
                veh.wheelSpin[k] = s[w + 2];
            }
            veh.mesh.position.copy(veh.chassisPos);
            veh.mesh.quaternion.copy(veh.chassisQuat);
        }
        for (let i = 0; i < nRag; i++, o += SNAP.RAG) {
            const rag = this._ragById.get(s[o]);
            if (rag) this._applyRagdoll(rag, s, o);
        }
        for (let i = 0; i < nBody; i++, o += SNAP.BODY) {
            const b = this._bodyById.get(s[o]);
            if (!b) continue;
            const asleep = s[o + 8] > 0.5;
            if (asleep && b.asleep && b.seen) continue;
            b.seen = true;
            b.asleep = asleep;
            b.object3d.position.set(s[o + 1], s[o + 2], s[o + 3]);
            b.object3d.quaternion.set(s[o + 4], s[o + 5], s[o + 6], s[o + 7]);
        }
        for (let i = 0; i < nEv; i++, o += SNAP.EVENT) {
            if (s[o] !== EVENT_PROP_BROKEN) continue;
            const handle = this._bodyById.get(s[o + 1]);
            if (handle && handle.kind === 'prop') this._breakProp(handle, s[o + 2], s[o + 3], s[o + 4], s[o + 5]);
        }
    }

    // Physics drives the skeleton: the hips bone is pinned to the pelvis body and every driven bone takes
    // its body's world rotation. The root only slides along under the pelvis; its rotation is never touched.
    _applyRagdoll(rag, s, o) {
        const flags = s[o + 1];
        rag.seen = true;
        rag.settled = (flags & 1) !== 0;
        const asleep = (flags & 2) !== 0;
        if (asleep && rag.synced) return;
        rag.synced = asleep;

        const base = o + 2;
        const root = rag.unit.root;
        root.position.x = s[base] + rag.offX;
        root.position.z = s[base + 2] + rag.offZ;
        root.position.y = Math.min(rag.rootY, s[base + 1] - 0.15);
        for (let i = 0; i < rag.bones.length; i++) {
            const bone = rag.bones[i];
            if (!bone || !bone.parent) continue;
            const p = base + i * 7;
            bone.parent.updateWorldMatrix(true, false);
            if (i === 0) bone.position.copy(bone.parent.worldToLocal(_v1.set(s[p], s[p + 1], s[p + 2])));
            bone.parent.matrixWorld.decompose(_v2, _q2, _v3);
            _q1.set(s[p + 3], s[p + 4], s[p + 5], s[p + 6]);
            bone.quaternion.copy(_q2.invert().multiply(_q1));
        }
    }

    _placeRiders(veh) {
        for (let sIdx = 0; sIdx < veh.desantUnits.length; sIdx++) {
            const rider = veh.desantUnits[sIdx];
            if (!rider) continue;
            if (rider.isDead) {
                veh.desantUnits[sIdx] = null;
                rider.mountedVehicle = null;
                continue;
            }
            const slot = veh.spec.desantSlots[sIdx];
            _v2.set(slot[0], slot[1], slot[2]).applyQuaternion(veh.chassisQuat).add(veh.chassisPos);
            rider.root.position.copy(_v2);
            _qRider.setFromAxisAngle(Y_AXIS, Math.PI + (slot[0] < 0 ? 0.35 : -0.35));
            rider.root.quaternion.copy(veh.chassisQuat).multiply(_qRider);
        }
    }

    _roadkill(veh, allUnits, onRoadkillCallback) {
        const reach = veh.spec.halfExtents[0] + 0.85;
        _vFwd.set(0, 0, -1).applyQuaternion(veh.chassisQuat);
        for (let i = 0; i < allUnits.length; i++) {
            const u = allUnits[i];
            if (u.isDead || u.mountedVehicle === veh) continue;
            if (u.root.position.distanceTo(veh.chassisPos) < reach) {
                onRoadkillCallback(veh, u, _vFwd.clone().multiplyScalar(Math.max(12, Math.abs(veh.forwardSpeed) * 2.2)));
            }
        }
    }
}
