// Vehicle rig scenario: node tools/smoke.mjs tools/scenarios/vehrig.mjs --out /tmp/shots/vehrig
// Checks the baked part hierarchy and its animation on every vehicle: the runtime normalization is an
// identity, the muzzle follows the turret, the stabilizer holds the aim line on a tilted hull, recoil
// returns to battery, wheels spin, steer and travel. Takes screenshots of the line-up in a test pose.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);
    const report = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const T = e.camera.position.constructor;
        const Q = e.camera.quaternion.constructor;
        e.selectFactionAndStart('RU');
        e.isPointerLocked = true;
        window.BATTLE_ENGINE.step(30);
        e.updatePlayerController = () => {};
        e.updateUnitsAndSquadAI = () => {};
        e.viewmodelRoot.visible = false;
        window.__view = (px, py, pz, tx, ty, tz) => {
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
        };
        const fail = (msg) => { throw new Error(msg); };
        const deg = (r) => r * 180 / Math.PI;
        const out = {};
        const vp = e.vehicleParts;
        const pos = new T();
        const dir = new T();
        const aim = new T();
        const angleTo = (yaw, pitch) => {
            aim.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
            return deg(Math.acos(Math.max(-1, Math.min(1, aim.dot(dir)))));
        };
        const line = e.physics.vehicles.slice(0, 7);
        for (const v of line) {
            const key = v.spec.key;
            const parts = v.parts;
            if (!parts) fail(`${key}: no parts`);
            const r = { wheels: parts.wheels.length, tracks: parts.tracks.length, scroll: parts.tracks.filter((t) => t.textures.length).length };
            // the baked normalization: the runtime one must be an identity
            const model = v.mesh.userData.model;
            r.scale = Number(v.mesh.userData.modelScale.toFixed(4));
            r.offset = Number(Math.hypot(model.position.x, model.position.y, model.position.z).toFixed(4));
            if (Math.abs(r.scale - 1) > 0.002 || r.offset > 0.01) fail(`${key}: runtime normalization is not an identity (${r.scale}, ${r.offset})`);
            if (!parts.wheels.length) fail(`${key}: no wheels in the rig`);
            const has = vp.getMuzzle(v, pos, dir);
            r.gun = has;
            if (key === 'uaz452') {
                if (has) fail('uaz452 must not report a muzzle');
            } else {
                if (!has) fail(`${key}: getMuzzle returned false`);
                // 1. the muzzle follows the turret
                const before = pos.clone();
                v.turretYaw = 1.2;
                v.turretPitch = 0.12;
                window.BATTLE_ENGINE.step(300);
                vp.getMuzzle(v, pos, dir);
                r.moved = Number(pos.distanceTo(before).toFixed(2));
                r.aimError = Number(angleTo(1.2, 0.12).toFixed(2));
                if (r.moved < 0.5) fail(`${key}: muzzle did not follow the turret (${r.moved} m)`);
                if (r.aimError > 1) fail(`${key}: muzzle is ${r.aimError} deg off the aim line`);
                if (Math.abs(v.turretYawActual - 1.2) > 0.02) fail(`${key}: turretYawActual ${v.turretYawActual}`);
                // 2. stabilizer: tilt the hull 10 degrees in pitch and roll, the line must hold
                if (parts.state.drive.stabilized) {
                    const saved = v.chassisQuat.clone();
                    const tilt = new Q().setFromAxisAngle(new T(1, 0, 0.6).normalize(), 10 * Math.PI / 180);
                    v.chassisQuat.premultiply(tilt);
                    v.mesh.quaternion.copy(v.chassisQuat);
                    vp.lateUpdate(1 / 60);
                    vp.getMuzzle(v, pos, dir);
                    r.stabError = Number(angleTo(1.2, 0.12).toFixed(2));
                    v.chassisQuat.copy(saved);
                    v.mesh.quaternion.copy(saved);
                    vp.lateUpdate(1 / 60);
                    if (r.stabError > 1) fail(`${key}: stabilizer lets the line drift ${r.stabError} deg on a 10 deg tilt`);
                }
                // 3. recoil runs back and returns to battery
                const st = parts.state;
                e.events.emit('vehicle:fired', { vehicle: v, pos, dir, heavy: v.spec.isHeavyCannon, isPlayer: false });
                let peak = 0;
                for (let i = 0; i < 180; i++) {
                    window.BATTLE_ENGINE.step(1);
                    peak = Math.max(peak, st.recoil);
                }
                r.recoil = Number(peak.toFixed(3));
                r.rest = Number(st.recoil.toFixed(4));
                if (peak < st.recoilTravel * 0.9) fail(`${key}: recoil travel ${peak} of ${st.recoilTravel}`);
                if (st.recoil !== 0) fail(`${key}: barrel did not return to battery (${st.recoil})`);
            }
            out[key] = r;
        }
        // 4. wheels: drive the BTR in a left turn, check spin, steering lock and suspension travel
        const btr = line.find((v) => v.spec.key === 'btr80_ru');
        const w0 = btr.parts.wheels[0];
        const y0 = w0.node.position.y;
        btr.controls.throttle = 1;
        btr.controls.steer = 1;
        btr.controls.brake = false;
        let travel = 0;
        for (let i = 0; i < 180; i++) {
            window.BATTLE_ENGINE.step(1);
            travel = Math.max(travel, Math.abs(w0.node.position.y - y0));
        }
        out.btrDrive = {
            spin: Number(w0.node.rotation.x.toFixed(2)), steer0: Number(w0.node.rotation.y.toFixed(3)),
            steer2: Number(btr.parts.wheels[2].node.rotation.y.toFixed(3)), steer6: Number(btr.parts.wheels[6].node.rotation.y.toFixed(3)),
            travel: Number(travel.toFixed(3)), kmh: btr.speedKmh
        };
        if (Math.abs(w0.node.rotation.x) < 3) fail('BTR wheels do not spin');
        if (!(w0.node.rotation.y > 0.05) || !(btr.parts.wheels[2].node.rotation.y > 0.03)) fail('BTR front axles do not steer');
        if (btr.parts.wheels[6].node.rotation.y !== 0) fail('BTR rear axle must not steer');
        if (travel < 0.002) fail('BTR wheels do not travel with the suspension');
        btr.controls.throttle = 0;
        btr.controls.steer = 0;
        btr.controls.brake = true;
        // test pose for the screenshots: turrets 60 degrees left, guns up
        for (const v of e.physics.vehicles) {
            v.turretYaw = 60 * Math.PI / 180;
            v.turretPitch = 0.2;
        }
        window.BATTLE_ENGINE.step(240);
        return out;
    });
    log('VEHRIG', JSON.stringify(report));
    const views = {
        tanks: [-22, 5.5, 1.5, -22, 1.4, 12],
        btr_bmp: [-4, 5, 2.5, -5, 1.4, 12],
        bradley: [10, 5, 3, 9, 1.5, 12],
        cars: [22, 3.6, 4.5, 22.5, 1.0, 12],
        side_t90: [-36, 2.6, 13, -27, 1.5, 13]
    };
    for (const [name, v] of Object.entries(views)) {
        await ev((a) => window.__view(...a), v);
        await wait(1200);
        await shot(name);
    }
};
