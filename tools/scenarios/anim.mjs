// Animation scenario: node tools/smoke.mjs tools/scenarios/anim.mjs --out /tmp/shots/anim --query "quality=medium&dynamicResolution=false"
// Contact sheets (front and side) for every state, no-T-pose / grip / foot assertions, desant riding, death stagger
// and hand-over. Assertions throw; LOOK at the sheets: poses that look broken are a failure even if numbers pass.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);

    await ev(async () => {
        const THREE = await import('three');
        const e = window.BATTLE_ENGINE.instance;
        window.__THREE = THREE;
        e.selectFactionAndStart('RU');
        e.isPointerLocked = true;
        window.BATTLE_ENGINE.step(30);
        e.updateUnitsAndSquadAI = () => {};
        e.updateAutonomousDrones = () => {};
        e.updatePlayerController = () => {};
        e.viewmodelRoot.visible = false;
        e.hudLayer.style.display = 'none';
        window.__view = (px, py, pz, tx, ty, tz, fov = 45) => {
            e.camera.fov = fov;
            e.camera.updateProjectionMatrix();
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
        };
        window.__free = (faction) => e.units.filter((u) => u.faction === faction && !u.isDead && !u.mountedVehicle);
        // Lines soldiers up at z = 80 facing +Z (front view) or +X (side view), each in its own pinned pose.
        // entry = [lower, phase, upper, aim?] with aim as an offset in the soldier's own frame.
        window.__sheet = (list, side, faction, close = 0) => {
            const pool = faction ? window.__free(faction) : [...window.__free('RU'), ...window.__free('UA')];
            [...window.__free('RU'), ...window.__free('UA')].forEach((u, i) => { u.animator.unpose(); u.root.position.set(300 + i * 2, 0, 300); });
            const n = list.length;
            const yaw = side ? Math.PI / 2 : 0;
            list.forEach((entry, i) => {
                const u = pool[i];
                const x = (i - (n - 1) / 2) * (close ? 1.0 : 1.4);
                u.root.position.set(x, 0, 80);
                u.root.rotation.set(0, yaw, 0);
                u.stance = 'stand';
                let aim = null;
                if (entry[3]) {
                    const [ax, ay, az] = entry[3];
                    aim = new THREE.Vector3(x + ax * Math.cos(yaw) + az * Math.sin(yaw), ay, 80 - ax * Math.sin(yaw) + az * Math.cos(yaw));
                }
                u.animator.pose(entry[0], entry[1], entry[2], aim);
            });
            if (close) window.__view(0, 1.35, 80 + close, 0, 1.25, 80, 40);
            else window.__view(0, 1.1, 80 + 3.7 + (n - 4) * 0.8, 0, 0.95, 80, 45);
            window.BATTLE_ENGINE.step(2);
        };
    });

    const poses = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const u = e.units.find((x) => x.faction === 'RU' && !x.mountedVehicle);
        if (!u.animator) throw new Error('no animator attached');
        return { clips: Object.keys(e.anim.templates.get('soldier_ru').lower), weapon: u.weaponKey };
    });
    log('ANIM attached', JSON.stringify(poses));

    const A = [0, 1.45, 60];
    const sheets = [
        ['stand', null, [['idle', 0, 'low'], ['idle', 0, 'aim', A], ['crouch', 0, 'low'], ['crouch', 0, 'aim', [0, 0.95, 60]]]],
        ['walk', null, [['walk', 0, 'low'], ['walk', 0.25, 'low'], ['walk', 0.5, 'low'], ['walk', 0.75, 'low']]],
        ['run', null, [['run', 0, 'low'], ['run', 0.25, 'low'], ['run', 0.5, 'low'], ['run', 0.75, 'low']]],
        ['crouchwalk', null, [['crouchWalk', 0, 'low'], ['crouchWalk', 0.25, 'aim', A], ['crouchWalk', 0.5, 'low'], ['crouchWalk', 0.75, 'aim', A]]],
        ['ua', 'UA', [['idle', 0, 'low'], ['idle', 0, 'aim', A], ['walk', 0.25, 'low'], ['run', 0.25, 'low']]],
        ['hands', null, [['idle', 0, 'aim', A], ['idle', 0, 'low']], 2.4]
    ];
    for (const [name, faction, list, close] of sheets) {
        for (const side of [false, true]) {
            await ev((l, s, f, c) => window.__sheet(l, s, f, c), list, side, faction, close || 0);
            await wait(900);
            await shot(`${name}_${side ? 'side' : 'front'}`);
        }
    }

    // riders on the BTR-80: seated, one hand on the rail
    for (const [name, cam] of [['seated_a', [-13.4, 3.5, 10.5]], ['seated_b', [-4.4, 3.5, 10.5]]]) {
        await ev((c) => {
            const e = window.BATTLE_ENGINE.instance;
            window.__free('RU').forEach((u) => u.animator.unpose());
            window.BATTLE_ENGINE.step(90);
            const btr = e.physics.vehicles.find((v) => v.spec.key === 'btr80_ru');
            window.__view(c[0], c[1], c[2], btr.chassisPos.x, btr.chassisPos.y + 2.3, btr.chassisPos.z + 0.8, 32);
            window.BATTLE_ENGINE.step(2);
            e.isPaused = true;
        }, cam);
        await wait(900);
        await shot(name);
        await ev(() => { window.BATTLE_ENGINE.instance.isPaused = false; });
    }

    // pre-death stagger at 0.5, 0.35, 0.2 and 0.05 s after the hit
    for (const [name, cam] of [['death_front', [3.2, 1.4, 84.5]], ['death_side', [-1.5, 1.3, 85.5]]]) {
        await ev((c, side) => {
            const e = window.BATTLE_ENGINE.instance;
            const V = window.__THREE.Vector3;
            const step = window.BATTLE_ENGINE.step;
            const pool = window.__free('UA').filter((u) => u.animator && !u.animator.stopped);
            pool.forEach((u, i) => { u.animator.unpose(); u.root.position.set(300 + i * 2, 0, 300); });
            const victims = pool.slice(0, 4);
            victims.forEach((u, i) => {
                u.root.position.set((i - 1.5) * 1.6, 0, 80);
                u.root.rotation.set(0, side ? Math.PI / 2 : 0, 0);
            });
            step(30);
            const w = { bulletMass: 0.042, muzzleVelocity: 900, name: 'тест' };
            const dir = side ? new V(-1, 0, 0) : new V(0, 0, -1);
            const kill = (u) => e.killSoldierWithRagdoll(u, 'TORSO', 'torso', u.bones.chest.getWorldPosition(new V()), dir, w, 'ВЫ');
            kill(victims[0]);
            step(9);
            kill(victims[1]);
            step(9);
            kill(victims[2]);
            step(9);
            kill(victims[3]);
            step(3);
            window.__view(c[0], c[1], c[2], 0, 0.95, 80, 50);
            step(1);
            e.isPaused = true;
        }, cam, name === 'death_side');
        await wait(900);
        await shot(name);
        await ev(() => { window.BATTLE_ENGINE.instance.isPaused = false; window.BATTLE_ENGINE.step(120); });
    }

    // ------------------------------------------------------------------ assertions
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.units.forEach((u) => { if (!u.isDead && u.animator) u.animator.unpose(); });
        window.__fresh = () => window.__free('RU').concat(window.__free('UA')).filter((u) => u.animator && !u.animator.stopped);
        window.__fresh().forEach((u, i) => { u.root.position.set(200 + i * 3, 0, 200); });
        window.__fresh().forEach((u, i) => { u.root.position.set(200 + i * 3, 0, 200); });
    });

    // 1. nobody stands in a T-pose: upper arms hang down
    const tpose = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        window.BATTLE_ENGINE.step(120);
        let worst = 9;
        let n = 0;
        for (const u of e.units) {
            if (u.isDead || !u.animator) continue;
            u.root.updateMatrixWorld(true);
            for (const s of ['L', 'R']) {
                const sh = u.bones[`upperArm${s}`].getWorldPosition(new V());
                const el = u.bones[`lowerArm${s}`].getWorldPosition(new V());
                worst = Math.min(worst, -el.sub(sh).normalize().y);
                n++;
            }
        }
        if (!(worst > 0.15)) throw new Error(`a soldier is in a T-pose (upper arm drop ${worst})`);
        return { arms: n, worstDrop: Number(worst.toFixed(2)) };
    });
    log('ANIM tpose', JSON.stringify(tpose));

    // 2. hands on the grips, with IK ('arms') and from the baked clips alone ('off')
    const grips = await ev(async () => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const W = await import('/src/anim/weapons.js');
        const out = {};
        const measure = (u) => {
            const rifle = u.root.userData.rifleMesh;
            rifle.updateWorldMatrix(true, false);
            const g = W.WEAPONS[u.weaponKey];
            const cr = new V(...g.grip).applyMatrix4(rifle.matrixWorld);
            const cl = new V(...g.handguard).applyMatrix4(rifle.matrixWorld);
            const hr = u.bones.handR.getWorldPosition(new V());
            const hl = u.bones.handL.getWorldPosition(new V());
            return { r: hr.distanceTo(cr), l: hl.distanceTo(cl), ik: u.animator.grips.ik, wr: hr.distanceTo(u.animator.grips.wristR), wl: hl.distanceTo(u.animator.grips.wristL) };
        };
        for (const faction of ['RU', 'UA']) {
            const u = window.__free(faction)[0];
            u.root.position.set(0, 0, 100);
            u.root.rotation.set(0, 0, 0);
            for (const ik of ['arms', 'full', 'off']) {
                e.quality.profile.anim.ik = ik;
                for (const hold of ['aim', 'low']) {
                    u.animator.pose('idle', 0, hold, hold === 'aim' ? new V(0, 1.4, 160) : null);
                    window.BATTLE_ENGINE.step(12);
                    const m = measure(u);
                    out[`${faction}_${ik}_${hold}`] = { r: Number(m.r.toFixed(3)), l: Number(m.l.toFixed(3)), ik: m.ik };
                    const limit = ik === 'off' ? 0.22 : 0.13;
                    if (m.r > limit || m.l > limit) throw new Error(`hands off the grips (${faction} ${ik} ${hold}): ${JSON.stringify(m)}`);
                    if (ik !== 'off') {
                        if (!m.ik) throw new Error('IK did not run');
                        if (m.wr > 0.02 || m.wl > 0.02) throw new Error(`IK did not reach its target: ${JSON.stringify(m)}`);
                    }
                }
            }
            u.animator.unpose();
        }
        e.quality.profile.anim.ik = 'arms';
        return out;
    });
    log('ANIM grips', JSON.stringify(grips));

    // 3. gait: feet alternate and stay on the ground, state follows the real root speed
    const gait = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const u = window.__free('RU')[1];
        const run = (speed, frames) => {
            u.root.position.set(0, 0, 100);
            u.root.rotation.set(0, 0, 0);
            step(30);
            let changes = 0;
            let last = 0;
            let minY = 9;
            let maxY = -9;
            const fl = new V();
            const fr = new V();
            for (let i = 0; i < frames; i++) {
                u.root.position.z += speed / 60;
                step(1);
                u.bones.footL.getWorldPosition(fl);
                u.bones.footR.getWorldPosition(fr);
                const d = fl.z - fr.z;
                if (i > 20) {
                    if (last !== 0 && Math.sign(d) !== last && Math.abs(d) > 0.05) changes++;
                    if (Math.abs(d) > 0.05) last = Math.sign(d);
                }
                minY = Math.min(minY, fl.y, fr.y);
                maxY = Math.max(maxY, fl.y, fr.y);
            }
            const l = u.animator.lower;
            return { changes, minY: Number(minY.toFixed(3)), maxY: Number(maxY.toFixed(3)), walk: Number(l.walk.w.toFixed(2)), run: Number(l.run.w.toFixed(2)), idle: Number(l.idle.w.toFixed(2)) };
        };
        const out = { walk: run(1.4, 120), run: run(3.8, 120) };
        if (out.walk.changes < 2 || out.run.changes < 3) throw new Error(`feet do not alternate: ${JSON.stringify(out)}`);
        if (out.walk.walk < 0.8 || out.run.run < 0.8) throw new Error(`gait state wrong: ${JSON.stringify(out)}`);
        for (const k of ['walk', 'run']) {
            if (out[k].minY < 0.06) throw new Error(`a foot sinks into the ground: ${JSON.stringify(out[k])}`);
            if (out[k].maxY > 0.75) throw new Error(`a foot flies off: ${JSON.stringify(out[k])}`);
        }
        step(60);
        if (u.animator.lower.idle.w < 0.8) throw new Error('did not return to idle');
        u.stance = 'crouch';
        step(60);
        const hipsY = u.bones.hips.getWorldPosition(new V()).y;
        out.crouch = { w: Number(u.animator.lower.crouch.w.toFixed(2)), hipsY: Number(hipsY.toFixed(2)) };
        if (u.animator.lower.crouch.w < 0.8 || hipsY > 0.8) throw new Error(`crouch wrong: ${JSON.stringify(out.crouch)}`);
        u.stance = 'stand';
        return out;
    });
    log('ANIM gait', JSON.stringify(gait));

    // 4. unit is not mounted any more at this point? ride the BTR: seated state, inertia sway
    const ride = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const btr = e.physics.vehicles.find((v) => v.spec.key === 'btr80_ru');
        const riders = btr.desantUnits.filter(Boolean);
        if (riders.length < 3) throw new Error(`riders missing (${riders.length})`);
        riders.forEach((u) => u.animator.unpose());
        step(60);
        const out = { riders: riders.length };
        for (const u of riders) {
            const a = u.animator;
            if (!a.seat || a.lower.sit.w < 0.9) throw new Error('rider is not seated');
            const hipsY = u.bones.hips.getWorldPosition(new V()).y - u.root.position.y;
            if (hipsY < 0.05 || hipsY > 0.5) throw new Error(`seated hips height ${hipsY}`);
        }
        let maxP = 0;
        let maxR = 0;
        btr.controls.throttle = 1;
        btr.controls.brake = false;
        for (let i = 0; i < 150; i++) {
            step(1);
            for (const u of riders) { maxP = Math.max(maxP, Math.abs(u.animator.sway.p)); maxR = Math.max(maxR, Math.abs(u.animator.sway.r)); }
        }
        btr.controls.throttle = 0;
        btr.controls.brake = true;
        let brakePitch = 0;
        for (let i = 0; i < 90; i++) {
            step(1);
            for (const u of riders) brakePitch = Math.max(brakePitch, u.animator.sway.p);
        }
        out.sway = { accel: Number(maxP.toFixed(3)), roll: Number(maxR.toFixed(3)), brakeForward: Number(brakePitch.toFixed(3)) };
        if (!(maxP > 0.01 || brakePitch > 0.01)) throw new Error(`no inertia sway: ${JSON.stringify(out)}`);
        return out;
    });
    log('ANIM ride', JSON.stringify(ride));

    // 5. death: body hits stagger first and hand over without a snap; head shots, blasts and rams ragdoll at once
    const death = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const units = window.__fresh().filter((u) => u.faction === 'UA');
        const hasRag = (u) => e.physics.ragdolls.some((r) => r.unit === u);
        const w = { bulletMass: 0.042, muzzleVelocity: 900, name: 'тест' };
        const hit = (u, zone, weapon) => e.killSoldierWithRagdoll(u, zone, zone === 'HEAD' ? 'head' : 'torso', u.bones.chest.getWorldPosition(new V()), new V(0.3, 0, -1).normalize(), weapon, 'ВЫ');
        const out = {};
        const u = units[0];
        u.root.position.set(0, 0, 120);
        u.root.rotation.set(0, 0.4, 0);
        step(30);
        const q0 = u.root.quaternion.clone();
        const p0 = u.root.position.clone();
        hit(u, 'TORSO', w);
        if (hasRag(u)) throw new Error('a body hit must defer the ragdoll');
        if (!u.animator.dying) throw new Error('no stagger state');
        let frames = 0;
        while (!hasRag(u) && frames < 120) { step(1); frames++; }
        if (!hasRag(u)) throw new Error('the ragdoll never started');
        const seconds = frames / 60;
        const moved = u.root.position.distanceTo(p0);
        const turn = u.root.quaternion.angleTo(q0);
        const hips0 = u.bones.hips.getWorldPosition(new V());
        const head0 = u.bones.head.getWorldPosition(new V());
        step(1);
        u.root.updateWorldMatrix(true, true);
        const hipsJump = u.bones.hips.getWorldPosition(new V()).distanceTo(hips0);
        const headJump = u.bones.head.getWorldPosition(new V()).distanceTo(head0);
        out.stagger = { seconds: Number(seconds.toFixed(2)), moved: Number(moved.toFixed(2)), turn: Number(turn.toFixed(5)), hipsJump: Number(hipsJump.toFixed(3)), headJump: Number(headJump.toFixed(3)) };
        if (seconds < 0.5 || seconds > 1.0) throw new Error(`stagger length ${seconds}`);
        if (moved < 0.25 || moved > 1.8) throw new Error(`stagger distance ${moved}`);
        if (turn > 1e-4) throw new Error(`root quaternion snapped by ${turn}`);
        if (hipsJump > 0.1 || headJump > 0.2) throw new Error(`hand-over snapped: ${JSON.stringify(out.stagger)}`);
        step(90);
        if (u.animator && !u.animator.stopped) throw new Error('the animator must leave the ragdoll alone');
        const hipsY = u.bones.hips.getWorldPosition(new V()).y;
        if (!(hipsY < 0.6)) throw new Error(`ragdoll did not settle (${hipsY})`);
        const immediate = [];
        [['HEAD', w], ['TORSO', { ...w, kind: 'blast' }], ['TORSO', { ...w, name: 'БТР (ТАРАН БРОНЕЙ)' }]].forEach(([zone, wp], i) => {
            const v = units[i + 1];
            v.root.position.set(4 + i * 2, 0, 120);
            step(5);
            hit(v, zone, wp);
            immediate.push(hasRag(v));
        });
        out.immediate = immediate;
        if (!immediate.every(Boolean)) throw new Error(`head shots, blasts and rams must ragdoll at once: ${immediate}`);
        return out;
    });
    log('ANIM death', JSON.stringify(death));

    // 6. respawn rebuilds the model, weapon swap, muzzle / eye, far update rate
    const misc = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const out = {};
        const dead = e.units.find((x) => x.isDead && x.faction === 'UA');
        const oldAnim = dead.animator;
        const oldModel = dead.modelNode;
        let respawned = 0;
        e.events.on('unit:respawned', () => respawned++);
        e.respawnDeadSoldier(dead);
        step(30);
        if (dead.animator === oldAnim || !dead.animator || dead.modelNode === oldModel) throw new Error('respawn must rebuild the model and the animator');
        if (!oldAnim.stopped || respawned !== 1) throw new Error('old animator not disposed or no unit:respawned event');
        const u = dead;
        u.root.position.set(0, 0, 100);
        u.animator.unpose();
        step(5);
        const muzzle = u.animator.muzzleWorld(new V());
        const eye = u.animator.eyeWorld(new V());
        const chest = u.bones.chest.getWorldPosition(new V());
        out.muzzle = Number(muzzle.distanceTo(chest).toFixed(2));
        out.eye = Number((eye.y - u.root.position.y).toFixed(2));
        if (!(out.muzzle > 0.3 && out.muzzle < 1.2)) throw new Error(`muzzle ${out.muzzle} m from the chest`);
        if (!(out.eye > 1.4 && out.eye < 1.9)) throw new Error(`eye height ${out.eye}`);
        const before = u.root.userData.rifleMesh;
        if (!e.anim.setWeapon(u, 'rpg7') || u.root.userData.rifleMesh === before || u.animator.weaponKey !== 'rpg7') throw new Error('weapon swap failed');
        u.animator.pose('idle', 0, 'low');
        step(5);
        e.anim.setWeapon(u, 'm4a1');
        if (u.animator.weaponKey !== 'm4a1') throw new Error('weapon swap back failed');
        u.animator.unpose();
        // far units update at the reduced rate
        e.cameraMount.position.set(0, 1.5, 60);
        const near = window.__fresh()[0];
        const far = window.__fresh()[1];
        near.root.position.set(0, 0, 66);
        far.root.position.set(0, 0, 260);
        step(5);
        const n0 = near.animator.updates;
        const f0 = far.animator.updates;
        step(60);
        out.updates = { near: near.animator.updates - n0, far: far.animator.updates - f0 };
        if (out.updates.near < 58 || out.updates.far > 25 || out.updates.far < 5) throw new Error(`update rates wrong: ${JSON.stringify(out.updates)}`);
        const ok = e.units.every((x) => x.animator && x.animator.mixer);
        if (!ok) throw new Error('a unit has no animator');
        out.modules = e.modules.filter((m) => m.disabled).map((m) => m.name);
        if (out.modules.length) throw new Error(`modules disabled: ${out.modules}`);
        return out;
    });
    log('ANIM misc', JSON.stringify(misc));
};
