// "vehicleParts" feature module: animates the part hierarchy baked by tools/vehicle-rig.mjs.
// Contract: docs/ARCHITECTURE.md. For every vehicle it builds
//   vehicle.parts = { turret, gun, wheels[], tracks[], hatches[], rig }
// and each frame slews the turret and gun onto the aim line (vehicle.turretYaw / turretPitch are the
// world-space targets, vehicle.turretYawActual / turretPitchActual where the gun really points), holds
// that line against hull motion on stabilized vehicles, runs barrel recoil, spins and steers the wheels,
// moves them with the suspension and scrolls tiling track belts. A model without a rig keeps virtual
// turret angles and getMuzzle() returns false.
import * as THREE from 'three';

const D2R = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// Gun drives. Traverse rate, elevation limits and recoil travel come from the rig; the rest is here.
// stabilized: two-plane stabilizer (the gun holds its world line while the hull pitches and rolls).
const DRIVES = {
    t90m_ru: { stabilized: true, elevRate: 20, recoilTime: 0.07, returnRate: 10 },
    t72b3_ru: { stabilized: true, elevRate: 18, recoilTime: 0.07, returnRate: 10 },
    bmp2_ua: { stabilized: true, elevRate: 35, recoilTime: 0.02, returnRate: 55 },
    bradley_ua: { stabilized: true, elevRate: 60, recoilTime: 0.02, returnRate: 55 },
    btr80_ru: { stabilized: false, elevRate: 30, recoilTime: 0.02, returnRate: 55 },
    humvee_ua: { stabilized: false, elevRate: 70, recoilTime: 0.015, returnRate: 60 }
};
const DEFAULT_DRIVE = { stabilized: false, elevRate: 30, recoilTime: 0.03, returnRate: 40 };
const VIRTUAL_TRAVERSE = 40;    // deg/s for vehicles without a turret rig
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];

const _dir = new THREE.Vector3();
const _local = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _quat = new THREE.Quaternion();

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => {
    a %= TWO_PI;
    return a > Math.PI ? a - TWO_PI : a < -Math.PI ? a + TWO_PI : a;
};
// Unit vector of an aim line: yaw 0 looks along -Z, positive yaw turns left, positive pitch is up.
const aimVector = (yaw, pitch, out) => out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

export function createVehicleParts(engine) {
    const mod = {
        name: 'vehicleParts',
        // The player's vehicle follows the aim ray. A gunnery module that drives turretYaw / turretPitch
        // itself switches this off; AI crews set vehicle.aimPoint (Vector3 or null) or call aimAt().
        autoPlayerAim: true
    };

    function vehicles() {
        return engine.physics && engine.physics.vehicles ? engine.physics.vehicles : [];
    }

    // ------------------------------------------------------------------ rig discovery

    function build(vehicle) {
        const parts = { turret: null, gun: null, wheels: [], tracks: [], hatches: [], rig: null, gunMeshes: [], state: null, model: null };
        const drive = DRIVES[vehicle.spec && vehicle.spec.key] || DEFAULT_DRIVE;
        parts.state = {
            drive,
            yawLocal: 0, pitchLocal: 0,
            traverse: VIRTUAL_TRAVERSE * D2R, elevRate: drive.elevRate * D2R,
            elevMin: -8 * D2R, elevMax: 20 * D2R,
            recoil: 0, recoilVel: 0, recoilPhase: 0, recoilTravel: 0.05,
            steer: 0
        };
        vehicle.parts = parts;
        if (typeof vehicle.turretYawActual !== 'number') vehicle.turretYawActual = vehicle.turretYaw || 0;
        if (typeof vehicle.turretPitchActual !== 'number') vehicle.turretPitchActual = vehicle.turretPitch || 0;

        const model = vehicle.mesh && vehicle.mesh.userData ? vehicle.mesh.userData.model : null;
        if (!model) return parts;      // still streaming: rebuilt on asset:ready
        parts.model = model;
        const points = vehicle.suspPoints || [];
        const tuning = vehicle.tuning || null;
        const physR = tuning ? tuning.wheelR : 0;

        model.traverse((node) => {
            const data = node.userData;
            if (!data) return;
            if (data.rig && !parts.rig) parts.rig = data.rig;
            if (data.part === 'turret') parts.turret = node;
            else if (data.part === 'gun') parts.gun = node;
            else if (data.part === 'hatch') parts.hatches.push({ name: data.name || node.name, node, axis: data.axis || 'x', angle: data.angle || 1.4, open: 0 });
            else if (data.part === 'wheel') {
                node.rotation.order = 'YXZ';    // steer about Y first, then roll about the axle
                const wheel = {
                    node, index: data.index, side: data.side, radius: data.radius || 0.4, steer: data.steer || 0, road: data.road !== false,
                    baseY: node.position.y, a: -1, b: -1, mix: 0, ratio: physR > 0 ? physR / (data.radius || physR) : 1
                };
                // Suspension stations of this side that bracket the wheel (tracked hulls have more road
                // wheels than stations; wheeled hulls land exactly on one).
                const mine = [];
                for (let i = 0; i < points.length; i++) {
                    if ((points[i].local.x < 0) === (node.position.x < 0)) mine.push(i);
                }
                mine.sort((p, q) => points[p].local.z - points[q].local.z);
                if (mine.length) {
                    let k = 0;
                    while (k < mine.length - 1 && points[mine[k + 1]].local.z <= node.position.z) k++;
                    wheel.a = mine[k];
                    wheel.b = mine[Math.min(k + 1, mine.length - 1)];
                    const za = points[wheel.a].local.z;
                    const zb = points[wheel.b].local.z;
                    wheel.mix = zb > za ? clamp((node.position.z - za) / (zb - za), 0, 1) : 0;
                    if (wheel.mix > 0.5) wheel.near = wheel.b; else wheel.near = wheel.a;
                }
                parts.wheels.push(wheel);
            } else if (data.part === 'track') {
                const track = { node, side: data.side, textures: [], axis: data.uvAxis === 1 ? 'y' : 'x', perMeter: data.uvPerMeter || 0, station: -1 };
                for (let i = 0; i < points.length; i++) {
                    if ((points[i].local.x < 0) === (data.side === 'l')) { track.station = i; break; }
                }
                if (data.scroll && track.perMeter) scrollable(track);
                parts.tracks.push(track);
            }
        });
        parts.wheels.sort((p, q) => p.index - q.index);

        const st = parts.state;
        const rig = parts.rig;
        if (rig && rig.turret && parts.turret) st.traverse = (rig.turret.traverse || VIRTUAL_TRAVERSE) * D2R;
        if (rig && rig.gun && parts.gun) {
            st.elevMin = rig.gun.elev[0] * D2R;
            st.elevMax = rig.gun.elev[1] * D2R;
            st.recoilTravel = rig.gun.recoil || 0.05;
            parts.muzzle = new THREE.Vector3(rig.gun.muzzle[0], rig.gun.muzzle[1], rig.gun.muzzle[2]);
            for (const child of parts.gun.children) parts.gunMeshes.push({ node: child, baseZ: child.position.z });
        }
        return parts;
    }

    // Belt textures get their own material and texture objects (the GPU data is shared) so that the
    // offset of one track does not scroll every mesh that uses the same atlas.
    function scrollable(track) {
        const cloned = new Map();
        track.node.traverse((mesh) => {
            if (!mesh.isMesh || !mesh.material || Array.isArray(mesh.material)) return;
            const material = mesh.material.clone();
            for (const slot of TEXTURE_SLOTS) {
                const tex = material[slot];
                if (!tex) continue;
                let copy = cloned.get(tex);
                if (!copy) {
                    copy = tex.clone();
                    copy.wrapS = THREE.RepeatWrapping;
                    copy.wrapT = THREE.RepeatWrapping;
                    cloned.set(tex, copy);
                    track.textures.push(copy);
                }
                material[slot] = copy;
            }
            mesh.material = material;
        });
    }

    function ensure(vehicle) {
        const parts = vehicle.parts;
        if (!parts || !parts.state) return build(vehicle);
        // The model arrived (or was swapped) after the first build.
        const model = vehicle.mesh && vehicle.mesh.userData ? vehicle.mesh.userData.model : null;
        if (model && parts.model !== model) return build(vehicle);
        return parts;
    }

    // ------------------------------------------------------------------ aiming

    // Points the vehicle's gun at a world position (parallax from the trunnion included).
    function aimAt(vehicle, point) {
        if (!vehicle || !point) return;
        const parts = ensure(vehicle);
        if (parts.gun) {
            parts.gun.updateWorldMatrix(true, false);
            _origin.setFromMatrixPosition(parts.gun.matrixWorld);
        } else {
            const m = vehicle.spec && vehicle.spec.muzzleOffset ? vehicle.spec.muzzleOffset : [0, 2, 0];
            _origin.set(m[0], m[1], 0).applyQuaternion(vehicle.chassisQuat).add(vehicle.chassisPos);
        }
        _aim.subVectors(point, _origin);
        const flat = Math.hypot(_aim.x, _aim.z);
        if (flat < 1e-4 && Math.abs(_aim.y) < 1e-4) return;
        vehicle.turretYaw = Math.atan2(-_aim.x, -_aim.z);
        vehicle.turretPitch = Math.atan2(_aim.y, flat);
    }

    // Where the player's aim ray meets the ground (or a far point above the horizon).
    function aimPlayerVehicle(vehicle) {
        if (typeof engine.getAimRay === 'function') {
            engine.getAimRay(_pos, _dir);
        } else {
            engine.camera.getWorldPosition(_pos);
            engine.camera.getWorldDirection(_dir);
        }
        const reach = _dir.y < -0.01 ? clamp(-_pos.y / _dir.y, 12, 600) : 600;
        aimAt(vehicle, _pos.addScaledVector(_dir, reach));
    }

    function updateGun(vehicle, parts, dt) {
        const st = parts.state;
        const jammed = vehicle.destroyed || (vehicle.modules && (vehicle.modules.turret === 'destroyed' || vehicle.modules.turret === 'jammed'));
        const hasTurret = Boolean(parts.turret);
        const targetYaw = num(vehicle.turretYaw, 0);
        const targetPitch = num(vehicle.turretPitch, 0);
        _quat.copy(vehicle.chassisQuat).invert();

        if (st.drive.stabilized && hasTurret) {
            // The gunner slews the world-space line; the stabilizer cancels hull motion instantly.
            if (!jammed) {
                vehicle.turretYawActual = wrap(vehicle.turretYawActual + clamp(wrap(targetYaw - vehicle.turretYawActual), -st.traverse * dt, st.traverse * dt));
                vehicle.turretPitchActual += clamp(targetPitch - vehicle.turretPitchActual, -st.elevRate * dt, st.elevRate * dt);
                aimVector(vehicle.turretYawActual, vehicle.turretPitchActual, _local).applyQuaternion(_quat);
                st.yawLocal = Math.atan2(-_local.x, -_local.z);
                const pitch = Math.asin(clamp(_local.y, -1, 1));
                st.pitchLocal = clamp(pitch, st.elevMin, st.elevMax);
                if (st.pitchLocal !== pitch) worldFromLocal(vehicle, st);     // against the stops: the line gives way
            } else {
                worldFromLocal(vehicle, st);
            }
        } else {
            // Unstabilized mount: the angles are relative to the hull and the hull carries the gun.
            if (!jammed) {
                aimVector(targetYaw, targetPitch, _local).applyQuaternion(_quat);
                const yaw = Math.atan2(-_local.x, -_local.z);
                const pitch = clamp(Math.asin(clamp(_local.y, -1, 1)), st.elevMin, st.elevMax);
                st.yawLocal = wrap(st.yawLocal + clamp(wrap(yaw - st.yawLocal), -st.traverse * dt, st.traverse * dt));
                st.pitchLocal += clamp(pitch - st.pitchLocal, -st.elevRate * dt, st.elevRate * dt);
            }
            worldFromLocal(vehicle, st);
        }
        if (parts.turret) parts.turret.rotation.y = st.yawLocal;
        if (parts.gun) parts.gun.rotation.x = st.pitchLocal;

        // Recoil: the barrel runs back linearly, then a critically damped spring returns it to battery.
        if (st.recoilPhase === 1) {
            st.recoil += (st.recoilTravel / st.drive.recoilTime) * dt;
            if (st.recoil >= st.recoilTravel) {
                st.recoil = st.recoilTravel;
                st.recoilVel = 0;
                st.recoilPhase = 2;
            }
        } else if (st.recoilPhase === 2) {
            // Closed-form step: stable for any frame time, unlike integrating a stiff spring.
            const w = st.drive.returnRate;
            const decay = Math.exp(-w * dt);
            const k = st.recoilVel + w * st.recoil;
            st.recoil = (st.recoil + k * dt) * decay;
            st.recoilVel = (st.recoilVel - k * w * dt) * decay;
            if (st.recoil < 0.0005 && Math.abs(st.recoilVel) < 0.01) {
                st.recoil = 0;
                st.recoilVel = 0;
                st.recoilPhase = 0;
            }
        }
        for (let i = 0; i < parts.gunMeshes.length; i++) parts.gunMeshes[i].node.position.z = parts.gunMeshes[i].baseZ + st.recoil;
    }

    function worldFromLocal(vehicle, st) {
        aimVector(st.yawLocal, st.pitchLocal, _local).applyQuaternion(vehicle.chassisQuat);
        vehicle.turretYawActual = Math.atan2(-_local.x, -_local.z);
        vehicle.turretPitchActual = Math.asin(clamp(_local.y, -1, 1));
    }

    // ------------------------------------------------------------------ running gear

    function updateWheels(vehicle, parts, dt) {
        const st = parts.state;
        const tuning = vehicle.tuning;
        const points = vehicle.suspPoints;
        const spin = vehicle.wheelSpin;
        const sag = num(vehicle.suspSag, 0);
        if (tuning && !tuning.tracked) {
            // Same speed-dependent lock as the simulation, so the wheels show what the tyres do.
            const speed = Math.abs(num(vehicle.forwardSpeed, 0));
            const limit = Math.min(tuning.steerMax, tuning.wheelbase * tuning.latAccMax / Math.max(speed * speed, 1));
            const target = vehicle.destroyed ? 0 : clamp(num(vehicle.controls.steer, 0), -1, 1) * limit;
            st.steer += clamp(target - st.steer, -tuning.steerRate * dt, tuning.steerRate * dt);
        }
        for (let i = 0; i < parts.wheels.length; i++) {
            const w = parts.wheels[i];
            if (w.a < 0) continue;
            const node = w.node;
            if (spin) node.rotation.x = -spin[w.near] * w.ratio;
            else node.rotation.x -= (num(vehicle.forwardSpeed, 0) / w.radius) * dt;
            if (w.steer) node.rotation.y = st.steer * w.steer;
            if (w.road) {
                const ca = points[w.a].compression;
                const cb = points[w.b].compression;
                node.position.y = w.baseY + clamp(ca + (cb - ca) * w.mix - sag, -0.3, 0.35);
            }
        }
        if (!spin || !tuning) return;
        for (let i = 0; i < parts.tracks.length; i++) {
            const track = parts.tracks[i];
            if (!track.textures.length || track.station < 0) continue;
            // Belt travel in metres -> texture offset; the fractional part is enough for a tiling texture.
            const offset = -spin[track.station] * tuning.wheelR * track.perMeter;
            const frac = offset - Math.floor(offset);
            for (let k = 0; k < track.textures.length; k++) track.textures[k].offset[track.axis] = frac;
        }
    }

    function num(value, fallback) {
        return typeof value === 'number' && value === value ? value : fallback;
    }

    // ------------------------------------------------------------------ public surface

    // World muzzle position and bore direction of the real barrel. Returns false without a gun rig.
    mod.getMuzzle = (vehicle, outPos, outDir) => {
        if (!vehicle) return false;
        const parts = ensure(vehicle);
        if (!parts.gun || !parts.muzzle) return false;
        parts.gun.updateWorldMatrix(true, false);
        outPos.copy(parts.muzzle).applyMatrix4(parts.gun.matrixWorld);
        outDir.set(0, 0, -1).transformDirection(parts.gun.matrixWorld);
        return true;
    };

    mod.recoil = (vehicle) => {
        if (!vehicle) return;
        const st = ensure(vehicle).state;
        st.recoilPhase = 1;
        st.recoilVel = 0;
    };

    mod.aimAt = aimAt;
    mod.ensure = ensure;

    // Hatches, doors and ramps the rig marks as parts (`extras.part = 'hatch'`). Returns false when the
    // model has no such part.
    mod.setHatch = (vehicle, name, open01) => {
        if (!vehicle) return false;
        const hatch = ensure(vehicle).hatches.find((h) => h.name === name);
        if (!hatch) return false;
        hatch.open = clamp(open01, 0, 1);
        hatch.node.rotation[hatch.axis] = hatch.open * hatch.angle;
        return true;
    };

    // Hands the real turret (with its gun) over as a free object in world space: used when the
    // ammunition cooks off. Returns null when the model has no turret part.
    mod.detachTurret = (vehicle) => {
        const parts = vehicle && vehicle.parts;
        if (!parts || !parts.turret) return null;
        const turret = parts.turret;
        engine.scene.attach(turret);
        parts.turret = null;
        parts.gun = null;
        parts.muzzle = null;
        parts.gunMeshes.length = 0;
        return turret;
    };

    mod.install = () => {
        for (const vehicle of vehicles()) build(vehicle);
        engine.events.on('asset:ready', ({ wrapper }) => {
            for (const vehicle of vehicles()) if (vehicle.mesh === wrapper) build(vehicle);
        });
        engine.events.on('vehicle:fired', ({ vehicle }) => mod.recoil(vehicle));
    };

    mod.update = () => {
        const state = engine.playerVehicleState;
        if (mod.autoPlayerAim && state && state.vehicle && state.role === 'DRIVER' && !state.vehicle.destroyed) {
            aimPlayerVehicle(state.vehicle);
        }
        const list = vehicles();
        for (let i = 0; i < list.length; i++) {
            if (list[i].aimPoint && !list[i].destroyed) aimAt(list[i], list[i].aimPoint);
        }
    };

    mod.lateUpdate = (dt) => {
        const list = vehicles();
        for (let i = 0; i < list.length; i++) {
            const vehicle = list[i];
            const parts = ensure(vehicle);
            updateGun(vehicle, parts, dt);
            if (parts.wheels.length || parts.tracks.length) updateWheels(vehicle, parts, dt);
        }
    };

    return mod;
}
