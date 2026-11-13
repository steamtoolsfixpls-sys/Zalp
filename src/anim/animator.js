import * as THREE from 'three';
import { worldPos, worldQuat, applyDelta, eulerQuat, solveArm, orientHand } from './rig.js';
import { LOWER_STATES, DURATION, NOMINAL_SPEED, wristTarget, ARM_POLE } from './clips.js';
import { weaponSpec, WEAPONS, HOLDS, PALM, holdQuat, wrapperTransform } from './weapons.js';

// One AnimationMixer per soldier. Lower layer (hips, legs, posture) and upper layer (arms) cross-fade independently;
// after the mixer the body is aimed, the rifle is carried on the chest and both arms are solved onto its grips.
const UPPER_STATES = ['aim', 'low', 'sitL', 'sitR', 'clutch'];
const SPEED_IDLE = 0.25;
const SPEED_RUN = 2.2;
const BLEND_RATE = 6;
const UP_RATE = 7;
const REACH = 0.985;

const _rq = new THREE.Quaternion();
const _rqi = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _dr = new THREE.Quaternion();
const _cq = new THREE.Quaternion();
const _rt = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qh = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _g = new THREE.Vector3();
const _t = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _gripW = new THREE.Vector3();
const _handW = new THREE.Vector3();
const _wrapPos = new THREE.Vector3();
const _wrapQuat = new THREE.Quaternion();
const _muz = new THREE.Vector3();

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Animator {
    constructor(engine, unit, tpl, weaponKey) {
        this.engine = engine;
        this.unit = unit;
        this.tpl = tpl;
        this.model = unit.modelNode;
        this.mixer = new THREE.AnimationMixer(this.model);
        this.lower = {};
        for (const k of LOWER_STATES) {
            const action = this.mixer.clipAction(tpl.lower[k]);
            action.play();
            action.setEffectiveWeight(k === 'idle' ? 1 : 0);
            this.lower[k] = { action, w: k === 'idle' ? 1 : 0 };
        }
        this.upper = {};
        this.weaponKey = null;
        this.setWeaponKey(weaponKey);
        this.offset = Math.random() * 4;
        this.phase = Math.random();
        this.prev = new THREE.Vector3().copy(unit.root.position);
        this.hasPrev = false;
        this.vx = 0;
        this.vz = 0;
        this.ext = { x: 0, z: 0, t: -9 };
        this.speed = 0;
        this.back = false;
        this.running = false;
        this.stance = 'stand';
        this.aimPoint = new THREE.Vector3();
        this.aimTimer = 0;
        this.shootT = 0;
        this.recoil = 0;
        this.flinch = 0;
        this.reloadT = 0;
        this.aimYaw = 0;
        this.aimPitch = 0;
        this.seat = null;
        this.sway = { p: 0, pv: 0, r: 0, rv: 0, vx: 0, vy: 0, vz: 0, has: false };
        this.dying = null;
        this.stopped = false;
        this.acc = 0;
        this.nextAt = 0;
        this.preview = null;
        this.muzzleValid = false;
    }

    // ------------------------------------------------------------------ public surface

    setMove(velocity, { sprint = false } = {}) {
        this.ext.x = velocity.x;
        this.ext.z = velocity.z;
        this.ext.t = this.engine.time;
        this.running = Boolean(sprint);
    }

    setStance(s) {
        this.stance = s === 'prone' ? 'crouch' : s;
    }

    setAim(point) {
        if (!point) {
            this.aimTimer = 0;
            return;
        }
        this.aimPoint.copy(point);
        this.aimTimer = 2.5;
    }

    trigger(name) {
        if (name === 'shoot') {
            this.shootT = 3;
            this.recoil = 1;
        } else if (name === 'flinch') {
            this.flinch = 1;
        } else if (name === 'reload') {
            this.reloadT = 0.001;
        }
    }

    setSeated(vehicle, slot) {
        this.seat = vehicle ? { vehicle, slot } : null;
    }

    // Returns true when the unit staggers first; startRagdoll() is then called by this animator.
    beginDeath(info, startRagdoll) {
        if (this.stopped || this.dying) return false;
        const kind = info && info.kind;
        if (this.unit.mountedVehicle || this.seat || (kind && kind !== 'bullet') || !info || info.zone === 'HEAD') return false;
        const d = info.dir;
        const len = Math.hypot(d.x, d.z) || 1;
        this.dying = {
            t: 0,
            dur: 0.55 + Math.random() * 0.35,
            dx: d.x / len,
            dz: d.z / len,
            speed: 1.9 + Math.random() * 0.6,
            start: startRagdoll
        };
        this.dropWeapon();
        return true;
    }

    muzzleWorld(out) {
        const rifle = this.unit.root.userData.rifleMesh;
        if (!rifle) return out.copy(this.unit.root.position).setY(this.unit.root.position.y + 1.35);
        const m = WEAPONS[this.weaponKey].muzzle;
        rifle.updateWorldMatrix(true, false);
        return out.set(m[0], m[1], m[2]).applyMatrix4(rifle.matrixWorld);
    }

    eyeWorld(out) {
        const head = this.unit.bones.head;
        if (!head) return out.copy(this.unit.root.position).setY(this.unit.root.position.y + 1.65);
        worldPos(head, out);
        this.unit.root.updateWorldMatrix(true, false);
        this.unit.root.matrixWorld.decompose(_p, _rq, _s);
        return out.add(_t.set(0, 0.1, 0.09).applyQuaternion(_rq));
    }

    setWeaponKey(key) {
        const k = WEAPONS[key] ? key : 'ak12';
        if (k === this.weaponKey) return;
        for (const s of UPPER_STATES) {
            if (this.upper[s]) this.upper[s].action.stop();
        }
        this.weaponKey = k;
        this.spec = weaponSpec(k);
        const clips = this.tpl.getUpper(k);
        for (const s of UPPER_STATES) {
            const action = this.mixer.clipAction(clips[s]);
            action.play();
            const w = this.upper[s] ? this.upper[s].w : (s === 'low' ? 1 : 0);
            action.setEffectiveWeight(w);
            this.upper[s] = { action, w };
        }
    }

    // Test hook: pins the pose (lower kind, gait phase 0..1, upper kind) for contact sheets.
    pose(lower, phase, upper, aim = null) {
        this.preview = { lower, phase, upper, aim };
        this.stopped = false;
        this.step(0.0001, false, 'full');
    }

    unpose() {
        this.preview = null;
    }

    dispose() {
        this.stopped = true;
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.model);
        if (this.unit.animator === this) this.unit.animator = null;
    }

    // ------------------------------------------------------------------ frame

    update(dt) {
        if (this.stopped) return;
        const unit = this.unit;
        if (unit.isDead && !this.dying) {
            this.stopped = true;
            this.dropWeapon();
            return;
        }
        const e = this.engine;
        const q = e.quality.profile.anim;
        let far = false;
        const lod = e.lod;
        if (lod && typeof lod.levelOf === 'function' && lod.levelOf(unit) >= 2) far = true;
        if (!far && e.cameraMount.position.distanceToSquared(unit.root.position) > q.farDistance * q.farDistance) far = true;
        if (far && !this.dying) {
            this.acc += dt;
            if (e.time < this.nextAt) return;
            dt = this.acc;
            this.acc = 0;
            this.nextAt = e.time + 1 / Math.max(1, q.farUpdateHz);
        }
        this.step(dt, far, q.ik);
    }

    step(dt, far, ik) {
        const unit = this.unit;
        const e = this.engine;
        const root = unit.root;
        const pre = this.preview;
        const mounted = Boolean(unit.mountedVehicle || this.seat);
        if (mounted && !this.seat) this.seat = { vehicle: unit.mountedVehicle, slot: unit.mountedVehicle.desantUnits.indexOf(unit) };
        if (!mounted && this.seat && !pre) this.seat = null;
        this.aimTimer = Math.max(0, this.aimTimer - dt);
        this.shootT = Math.max(0, this.shootT - dt);
        this.recoil = Math.max(0, this.recoil - dt * 6);
        this.flinch = Math.max(0, this.flinch - dt * 5);
        if (this.reloadT > 0) {
            this.reloadT += dt;
            if (this.reloadT > 2.1) this.reloadT = 0;
        }

        // movement from real root motion
        if (!pre) this.measure(dt, mounted);

        // lower-body state
        let lowerKind;
        let phaseSpeed = this.speed;
        const crouch = (unit.stance || this.stance) === 'crouch' || unit.stance === 'prone';
        if (pre) {
            lowerKind = pre.lower;
        } else if (this.dying) {
            lowerKind = 'walk';
            phaseSpeed = 1.1;
        } else if (this.seat) {
            lowerKind = 'sit';
        } else if (this.speed < SPEED_IDLE) {
            lowerKind = crouch ? 'crouch' : 'idle';
        } else if (crouch) {
            lowerKind = 'crouchWalk';
        } else {
            if (this.speed > SPEED_RUN) this.runState = true;
            else if (this.speed < SPEED_RUN - 0.4) this.runState = false;
            lowerKind = this.runState || this.running ? 'run' : 'walk';
        }
        this.blend(this.lower, lowerKind, dt, BLEND_RATE, Boolean(pre));

        // gait phase
        let freq = 0;
        for (const k of ['walk', 'run', 'crouchWalk']) {
            const w = this.lower[k].w;
            if (w > 0.001) freq += w * (phaseSpeed / NOMINAL_SPEED[k]) / DURATION[k];
        }
        if (pre) this.phase = pre.phase;
        else this.phase = (this.phase + (this.back ? -freq : freq) * dt + 1) % 1;
        const clock = e.time + this.offset;
        for (const k of LOWER_STATES) {
            const l = this.lower[k];
            const d = DURATION[k];
            l.action.setEffectiveWeight(l.w);
            if (l.w <= 0.0005) continue;
            l.action.time = (k === 'walk' || k === 'run' || k === 'crouchWalk') ? this.phase * d : (pre ? 0 : clock % d);
        }

        // upper-layer state
        let upKind;
        if (pre) upKind = pre.upper;
        else if (this.dying) upKind = 'clutch';
        else if (this.seat) upKind = this.seatSide() === 'L' ? 'sitL' : 'sitR';
        else if (this.aimTimer > 0 || this.shootT > 0 || unit.aimPoint) upKind = 'aim';
        else upKind = 'low';
        this.blend(this.upper, upKind, dt, UP_RATE, Boolean(pre));
        for (const k of UPPER_STATES) {
            const u = this.upper[k];
            u.action.setEffectiveWeight(u.w);
            if (u.w > 0.0005) u.action.time = 0;
        }
        this.mixer.update(0);

        this.applyBody(dt, far, ik, mounted);

        if (this.dying) this.advanceDeath(dt);
    }

    measure(dt, mounted) {
        const root = this.unit.root;
        const pos = root.position;
        if (mounted) {
            this.hasPrev = false;
            this.speed = 0;
            return;
        }
        if (this.hasPrev && dt > 1e-5) {
            const dx = pos.x - this.prev.x;
            const dz = pos.z - this.prev.z;
            if (Math.hypot(dx, dz) < 1.5) {
                const k = Math.min(1, dt * 10);
                this.vx += (dx / dt - this.vx) * k;
                this.vz += (dz / dt - this.vz) * k;
            } else {
                this.vx = this.vz = 0;
            }
        }
        this.prev.copy(pos);
        this.hasPrev = true;
        const uv = this.unit.velocity;
        let vx = this.vx;
        let vz = this.vz;
        if (uv && uv.x * uv.x + uv.z * uv.z > vx * vx + vz * vz) {
            vx = uv.x;
            vz = uv.z;
        }
        const ext = this.ext;
        if (this.engine.time - ext.t < 0.25 && ext.x * ext.x + ext.z * ext.z > vx * vx + vz * vz) {
            vx = ext.x;
            vz = ext.z;
        }
        this.speed = Math.hypot(vx, vz);
        if (this.speed > 0.05) {
            const yaw = root.rotation.y;
            this.back = (vx * Math.sin(yaw) + vz * Math.cos(yaw)) < -0.35 * this.speed;
        }
    }

    seatSide() {
        const s = this.seat;
        if (!s || !s.vehicle) return 'L';
        const slot = s.vehicle.spec.desantSlots[Math.max(0, s.slot)];
        return slot && slot[0] > 0 ? 'R' : 'L';
    }

    // Moves the weights of one layer towards a one-hot target and normalises them to a sum of one.
    blend(set, target, dt, rate, snap) {
        let sum = 0;
        const step = rate * dt;
        for (const k in set) {
            const o = set[k];
            const goal = k === target ? 1 : 0;
            o.w = snap ? goal : o.w + clamp(goal - o.w, -step, step);
            sum += o.w;
        }
        if (sum > 0) for (const k in set) set[k].w /= sum;
    }

    // ------------------------------------------------------------------ body, rifle, arms

    applyBody(dt, far, ik, mounted) {
        const unit = this.unit;
        const root = unit.root;
        const b = unit.bones;
        const pre = this.preview;
        root.updateWorldMatrix(true, false);
        root.matrixWorld.decompose(_p, _rq, _s);
        _rqi.copy(_rq).invert();
        const up = this.upper;
        const aimW = up.aim.w;
        const sitW = up.sitL.w + up.sitR.w;
        const dyingW = up.clutch.w;

        // aim: yaw and pitch of the torso towards the target (character space), plus sway and death bend
        let yaw = 0;
        let pitch = 0;
        let roll = 0;
        const aimTarget = pre ? pre.aim : (this.aimTimer > 0 ? this.aimPoint : unit.aimPoint);
        if (aimTarget && aimW > 0.01 && b.chest) {
            worldPos(b.chest, _cp);
            _t.subVectors(aimTarget, _cp).applyQuaternion(_rqi);
            const ty = Math.atan2(_t.x, _t.z);
            const tp = Math.atan2(-_t.y, Math.hypot(_t.x, _t.z));
            const k = Math.min(1, dt * 10) || 1;
            this.aimYaw += (clamp(ty, -1.0, 1.0) - this.aimYaw) * (pre ? 1 : k);
            this.aimPitch += (clamp(tp, -0.7, 0.7) - this.aimPitch) * (pre ? 1 : k);
            yaw = this.aimYaw * aimW;
            pitch = this.aimPitch * aimW;
        } else {
            this.aimYaw *= 0.9;
            this.aimPitch *= 0.9;
        }
        if (this.seat && !far) this.updateSway(dt);
        if (sitW > 0.01) {
            pitch += this.sway.p * sitW;
            roll += this.sway.r * sitW;
        }
        pitch -= this.flinch * 0.12;
        if (this.dying) {
            const k = clamp(this.dying.t / this.dying.dur, 0, 1);
            pitch += (0.15 + 0.5 * k) * dyingW;
            roll += 0.12 * k * dyingW;
        }
        if (b.spine && b.chest && (yaw || pitch || roll)) {
            eulerQuat(pitch * 0.4, yaw * 0.4, roll * 0.4, _dr);
            _dq.copy(_rq).multiply(_dr).multiply(_rqi);
            applyDelta(b.spine, _dq);
            eulerQuat(pitch * 0.6, yaw * 0.6, roll * 0.6, _dr);
            _dq.copy(_rq).multiply(_dr).multiply(_rqi);
            applyDelta(b.chest, _dq);
        }
        if (this.seat === null) this.sway.has = false;

        const rifle = root.userData.rifleMesh;
        if (!rifle || !b.chest) return;
        if (dyingW > 0.5) {
            rifle.visible = false;
            return;
        }
        rifle.visible = true;

        // rifle frame carried by the chest (character space)
        worldPos(b.chest, _cp);
        root.worldToLocal(_cp);
        worldQuat(b.chest, _cq);
        _cq.premultiply(_rqi);
        _rt.copy(_cq).multiply(_qh.copy(this.tpl.restChestQ).invert());
        _g.set(0, 0, 0);
        _qb.set(0, 0, 0, 0);
        for (const k of UPPER_STATES) {
            const w = up[k].w;
            if (w < 0.001 || k === 'clutch') continue;
            const h = HOLDS[k];
            _g.x += h.g[0] * w;
            _g.y += h.g[1] * w;
            _g.z += h.g[2] * w;
            holdQuat(h, _wq);
            if (_qb.dot(_wq) < 0) _wq.set(-_wq.x, -_wq.y, -_wq.z, -_wq.w);
            _qb.x += _wq.x * w;
            _qb.y += _wq.y * w;
            _qb.z += _wq.z * w;
            _qb.w += _wq.w * w;
        }
        if (_qb.lengthSq() < 1e-8) _qb.set(0, 0, 0, 1);
        _qb.normalize();
        _wq.copy(_rt).multiply(_qb);
        // recoil kick and reload dip in weapon space
        const reload = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / 2.1) * Math.PI) : 0;
        eulerQuat(-0.06 * this.recoil + 0.35 * reload, 0, 0, _dr);
        _wq.multiply(_dr);
        _grip.copy(_g).applyQuaternion(_rt).add(_cp);
        _fwd.set(0, 0, 1).applyQuaternion(_wq);
        _grip.addScaledVector(_fwd, -0.035 * this.recoil);

        // keep the handguard within reach of the left arm
        const useIk = ik !== 'off' && !far && sitW < 0.5 && dyingW < 0.5;
        if (useIk && b.upperArmL) {
            worldPos(b.upperArmL, _sh);
            root.worldToLocal(_sh);
            _hand.copy(this.spec.handguard).applyQuaternion(_wq).add(_grip);
            const excess = _sh.distanceTo(_hand) - this.tpl.armLength * REACH - 0.07;
            if (excess > 0) _grip.addScaledVector(_fwd, -Math.min(0.12, excess));
        }
        wrapperTransform(this.spec, _grip, _wq, _wrapPos, _wrapQuat);
        rifle.position.copy(_wrapPos);
        rifle.quaternion.copy(_wrapQuat);
        rifle.updateMatrix();
        rifle.updateMatrixWorld(true);

        if (!useIk) return;
        // palms and wrists in world space
        const gripW = _gripW.copy(_grip);
        root.localToWorld(gripW);
        const handW = _handW.copy(this.spec.handguard).applyQuaternion(_wq).add(_grip);
        root.localToWorld(handW);
        if (reload > 0) handW.addScaledVector(_t.set(0, -1, 0), 0.2 * reload);
        _cq.copy(_rq).multiply(_wq);
        for (const side of ['R', 'L']) {
            const upper = b[`upperArm${side}`];
            const lower = b[`lowerArm${side}`];
            const hand = b[`hand${side}`];
            if (!upper || !lower || !hand) continue;
            const pn = _pn.copy(side === 'R' ? PALM.R : PALM.L).applyQuaternion(_cq);
            worldPos(upper, _sh);
            const target = side === 'R' ? gripW : handW;
            wristTarget(_sh, target, pn, _t);
            _pole.copy(ARM_POLE[side]).applyQuaternion(_rt).applyQuaternion(_rq);
            solveArm(upper, lower, hand, _t, _pole);
            orientHand(hand, pn);
        }
    }

    updateSway(dt) {
        const s = this.sway;
        const v = this.seat.vehicle;
        if (!v || !v.frameDeltaPos || dt < 1e-5) return;
        const ex = v.frameDeltaPos.x / dt;
        const ey = v.frameDeltaPos.y / dt;
        const ez = v.frameDeltaPos.z / dt;
        if (s.has) {
            const ax = (ex - s.vx) / dt;
            const az = (ez - s.vz) / dt;
            this.unit.root.matrixWorld.decompose(_p, _rq, _s);
            _fwd.set(0, 0, 1).applyQuaternion(_rq);
            _t.set(1, 0, 0).applyQuaternion(_rq);
            const af = clamp(ax * _fwd.x + az * _fwd.z, -25, 25);
            const al = clamp(ax * _t.x + az * _t.z, -25, 25);
            const tp = clamp(-af * 0.03, -0.3, 0.3);
            const tr = clamp(al * 0.03, -0.3, 0.3);
            const k = 70;
            const c = 9;
            s.pv += (k * (tp - s.p) - c * s.pv) * dt;
            s.p += s.pv * dt;
            s.rv += (k * (tr - s.r) - c * s.rv) * dt;
            s.r += s.rv * dt;
        }
        s.vx = ex;
        s.vy = ey;
        s.vz = ez;
        s.has = true;
    }

    // ------------------------------------------------------------------ death

    dropWeapon() {
        const unit = this.unit;
        const rifle = unit.root.userData.rifleMesh;
        const e = this.engine;
        if (!rifle || !rifle.parent || !e.physics || typeof e.physics.spawnDebris !== 'function') return;
        const spec = this.spec;
        rifle.updateWorldMatrix(true, false);
        rifle.matrixWorld.decompose(_wrapPos, _wrapQuat, _s);
        const holder = new THREE.Group();
        const half = Math.abs(Math.cos(spec.yaw)) > 0.5 ? [0.04, 0.1, 0.39] : [0.39, 0.1, 0.05];
        rifle.position.set(0, -0.107, 0);
        rifle.quaternion.identity();
        rifle.visible = true;
        holder.add(rifle);
        holder.position.copy(_wrapPos).add(_t.set(0, 0.107, 0).applyQuaternion(_wrapQuat));
        holder.quaternion.copy(_wrapQuat);
        unit.root.userData.rifleMesh = null;
        e.scene.add(holder);
        const v = unit.velocity;
        e.physics.spawnDebris(holder, {
            shape: { type: 'box', half },
            mass: 3.4,
            linvel: { x: (v ? v.x : 0) + (Math.random() - 0.5) * 2, y: 1.5, z: (v ? v.z : 0) + (Math.random() - 0.5) * 2 },
            angvel: { x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 },
            ttl: 14,
            friction: 0.7,
            restitution: 0.2
        });
    }

    advanceDeath(dt) {
        const d = this.dying;
        d.t += dt;
        const k = clamp(1 - d.t / d.dur, 0, 1);
        const sp = d.speed * (0.25 + 0.75 * k);
        const root = this.unit.root;
        root.position.x += d.dx * sp * dt;
        root.position.z += d.dz * sp * dt;
        if (this.unit.velocity) this.unit.velocity.set(d.dx * sp, 0, d.dz * sp);
        if (d.t >= d.dur) {
            this.dying = null;
            this.stopped = true;
            this.mixer.stopAllAction();
            root.updateWorldMatrix(true, true);
            d.start();
        }
    }
}
