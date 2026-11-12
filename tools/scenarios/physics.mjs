// Physics scenario: node tools/smoke.mjs tools/scenarios/physics.mjs --out /tmp/shots/physics
// With the default settings it first checks the worker transport in real time (vehicles settle and drive
// while the simulation runs in src/physics/worker.js), then moves on to the deterministic part, which the
// test hook runs synchronously: ramming, props, top speed, bumps, a thrown track, blown tyres, ragdoll
// hand-over and the ragdoll limit. With `?physicsWorker=false` only the deterministic part runs, inside a
// single evaluate call, and the logged digest must be identical from run to run.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);
    const boot = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.updateUnitsAndSquadAI = () => {};
        e.updateAutonomousDrones = () => {};
        return { mode: e.physics.mode, reason: e.physics.stats.reason };
    });
    log('PHYSICS boot', JSON.stringify(boot));

    if (boot.mode === 'worker') {
        await ev(() => {
            const e = window.BATTLE_ENGINE.instance;
            e.selectFactionAndStart('RU');
            e.isPointerLocked = true;
        });
        await wait(2500);
        await ev(() => {
            const e = window.BATTLE_ENGINE.instance;
            const uaz = e.physics.vehicles.find((v) => v.spec.key === 'uaz452');
            window.__uazZ = uaz.chassisPos.z;
            uaz.controls.throttle = 1;
        });
        let worker = null;
        for (let i = 0; i < 80; i++) {
            await wait(500);
            worker = await ev(() => {
                const e = window.BATTLE_ENGINE.instance;
                const uaz = e.physics.vehicles.find((v) => v.spec.key === 'uaz452');
                return {
                    mode: e.physics.mode, reason: e.physics.stats.reason, frames: e.physics.stats.frames,
                    moved: Number((window.__uazZ - uaz.chassisPos.z).toFixed(2)), kmh: uaz.speedKmh, gear: uaz.gear,
                    maxRest: Number(Math.max(...e.physics.vehicles.filter((v) => v !== uaz).map((v) => Math.abs(v.chassisPos.y))).toFixed(3)),
                    mainThreadMs: Number(e.physics.stats.stepMs.toFixed(3)), workerMs: Number(e.physics.stats.coreMs.toFixed(3))
                };
            });
            if (worker.moved > 1.5 || worker.mode !== 'worker') break;
        }
        log('PHYSICS worker', JSON.stringify(worker));
        if (worker.mode !== 'worker') throw new Error(`worker mode was lost: ${worker.reason}`);
        // Software-rendered Chrome manages a few frames per second and a frame advances at most 50 ms.
        if (worker.moved < 1.5) throw new Error(`UAZ did not drive in worker mode (${worker.moved} m)`);
        if (worker.maxRest > 0.2) throw new Error(`vehicles did not settle in worker mode (${worker.maxRest})`);
        const handover = await ev(() => {
            const e = window.BATTLE_ENGINE.instance;
            const uaz = e.physics.vehicles.find((v) => v.spec.key === 'uaz452');
            uaz.controls.throttle = 0;
            uaz.controls.brake = true;
            const before = uaz.chassisPos.clone();
            window.BATTLE_ENGINE.step(1);
            const jump = uaz.chassisPos.distanceTo(before);
            window.BATTLE_ENGINE.step(120);
            return { mode: e.physics.mode, reason: e.physics.stats.reason, jump: Number(jump.toFixed(3)), kmh: uaz.speedKmh, y: Number(uaz.chassisPos.y.toFixed(3)) };
        });
        log('PHYSICS handover', JSON.stringify(handover));
        if (handover.mode !== 'sync') throw new Error('the test hook must move the simulation onto the main thread');
        if (handover.jump > 1.5 || Math.abs(handover.y) > 0.3) throw new Error(`vehicle jumped on the worker -> sync hand-over (${handover.jump} m)`);
    }

    const report = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const step = window.BATTLE_ENGINE.step;
        const T = e.camera.position.constructor;
        const Group = e.cameraMount.constructor;
        const fail = (msg) => { throw new Error(msg); };
        const r2 = (v, d = 2) => Number(v.toFixed(d));
        if (!e.isStarted) {
            e.selectFactionAndStart('RU');
            e.isPointerLocked = true;
        }
        step(30);
        if (e.physics.mode !== 'sync') fail('BATTLE_ENGINE.step must run the simulation synchronously');
        const out = { mode: e.physics.mode };
        const specOf = (key) => e.physics.vehicles.find((v) => v.spec.key === key).spec;
        const spawn = (key, x, z, yaw = 0) => {
            const spec = specOf(key);
            const mesh = e.instantiateStaticModel(spec.key, spec.span);
            e.scene.add(mesh);
            return e.physics.createPhysicalVehicle(spec, mesh, new T(x, 0, z), yaw);
        };
        const yawOf = (v) => {
            const q = v.chassisQuat;
            return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
        };
        const upOf = (v) => 1 - 2 * (v.chassisQuat.x * v.chassisQuat.x + v.chassisQuat.z * v.chassisQuat.z);
        const speed = (v) => Math.hypot(v.linvel.x, v.linvel.z) * 3.6;

        // --- actors
        const ramTank = spawn('t90m_ru', 60, 40);
        const ramUaz = spawn('uaz452', 60.3, 10, Math.PI / 2);
        const topTank = spawn('t90m_ru', 100, 300);
        const topUaz = spawn('uaz452', 110, 300);
        const pivotTank = spawn('t72b3_ru', -60, 60);
        const flatBtr = spawn('btr80_ru', -80, 60);
        const bumpBmp = e.physics.vehicles.find((v) => v.spec.key === 'bmp2_ua');
        out.masses = {};
        for (const v of e.physics.vehicles.slice(0, 7)) out.masses[v.spec.key] = v.tuning.mass;

        // A one cubic metre concrete block (the dragon's teeth model is a 0.4 m high row that hulls clear).
        const teeth = new Group();
        teeth.add(e.instantiateStaticModel('hesco_bastion', 1.0));
        teeth.position.set(59.3, 0, 0);
        e.scene.add(teeth);
        const teethProp = e.physics.addDynamicProp({ object3d: teeth, shape: { type: 'box', half: [0.5, 0.45, 0.5], offset: [0, 0.45, 0] }, mass: 2400, friction: 0.9 });
        const crate = new Group();
        crate.position.set(60.9, 0.4, -8);
        e.scene.add(crate);
        const crateProp = e.physics.addDynamicProp({ object3d: crate, shape: { type: 'box', half: [0.5, 0.4, 0.5] }, mass: 45, breakable: true });
        let brokenEvents = 0;
        let splinters = 0;
        e.events.on('prop:broken', () => {
            brokenEvents++;
            splinters = e.physics.debrisBodies.length;
        });
        if (!teethProp || !crateProp) fail('addDynamicProp returned no handle');
        step(90);
        const teethStart = teeth.position.clone();
        const teethQuat = teeth.quaternion.clone();
        if (Math.abs(ramTank.chassisPos.y) > 0.05 || Math.abs(flatBtr.chassisPos.y) > 0.05) fail('spawned vehicles did not rest at ride height');

        // --- blown tyres: front-left and second-left of the BTR
        const comp0 = flatBtr.suspPoints.map((p) => p.compression);
        flatBtr.mobility = { trackL: 1, trackR: 1, tires: [0, 1, 0, 1, 1, 1, 1, 1], engine: 1 };
        step(120);
        const roll = Math.asin(Math.max(-1, Math.min(1, 2 * (flatBtr.chassisQuat.x * flatBtr.chassisQuat.y + flatBtr.chassisQuat.w * flatBtr.chassisQuat.z))));
        out.tires = {
            dropLeftCm: r2((flatBtr.suspPoints[0].compression - comp0[0]) * 100, 1),
            dropRightCm: r2((flatBtr.suspPoints[1].compression - comp0[1]) * 100, 1),
            roll: r2(roll, 3)
        };
        if (out.tires.dropLeftCm < 8) fail(`blown tyres did not lower the corner (${out.tires.dropLeftCm} cm)`);
        if (out.tires.dropLeftCm < out.tires.dropRightCm + 4) fail('blown tyres must lower their own side more');

        // --- drive everything at once
        pivotTank.mobility = { trackL: 0, trackR: 1, tires: [], engine: 1 };
        const pivotStart = pivotTank.chassisPos.clone();
        let pivotYaw = 0;
        let lastYaw = yawOf(pivotTank);
        const btrStart = flatBtr.chassisPos.clone();
        for (const v of [ramTank, topTank, topUaz, pivotTank, flatBtr, bumpBmp]) {
            v.controls.throttle = 1;
            v.controls.brake = false;
        }
        const ram = { hit: -1, before: 0, minAfter: 999, uazMax: 0 };
        const bumps = { maxPitch: 0, minUp: 1, entry: 0, min: 999, crossed: -1 };
        const top = { tank: 0, uaz: 0, tankGear: 0, uazGear: 0, gears: '' };
        let prevTankSpeed = 0;
        for (let i = 0; i < 1320; i++) {
            step(1);
            // ram
            const uazSpeed = Math.hypot(ramUaz.linvel.x, ramUaz.linvel.y, ramUaz.linvel.z) * 3.6;
            if (ram.hit < 0 && uazSpeed > 2) {
                ram.hit = i;
                ram.before = prevTankSpeed;
            }
            if (ram.hit >= 0 && i - ram.hit < 60) {
                ram.minAfter = Math.min(ram.minAfter, speed(ramTank));
                ram.uazMax = Math.max(ram.uazMax, uazSpeed);
            }
            prevTankSpeed = speed(ramTank);
            if (ramTank.chassisPos.z < -22) {
                ramTank.controls.throttle = 0;
                ramTank.controls.brake = true;
            }
            // bumps at z = -2 and z = -8
            if (bumps.crossed < 0) {
                const q = bumpBmp.chassisQuat;
                bumps.maxPitch = Math.max(bumps.maxPitch, Math.abs(Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x))))));
                bumps.minUp = Math.min(bumps.minUp, upOf(bumpBmp));
                if (bumpBmp.chassisPos.z > 2.5) bumps.entry = speed(bumpBmp);
                else if (bumpBmp.chassisPos.z > -11) bumps.min = Math.min(bumps.min, speed(bumpBmp));
                if (bumpBmp.chassisPos.z < -13) {
                    bumps.crossed = i;
                    bumpBmp.controls.throttle = 0;
                    bumpBmp.controls.brake = true;
                }
            }
            // thrown left track: accumulate yaw for 8 s
            if (i < 480) {
                const yaw = yawOf(pivotTank);
                let d = yaw - lastYaw;
                if (d > Math.PI) d -= 2 * Math.PI;
                if (d < -Math.PI) d += 2 * Math.PI;
                pivotYaw += d;
                lastYaw = yaw;
            } else if (i === 480) {
                out.track = { yaw: r2(pivotYaw), moved: r2(pivotTank.chassisPos.distanceTo(pivotStart)), kmh: r2(speed(pivotTank), 1) };
                pivotTank.controls.throttle = 0;
            }
            // flat tyres: pull to the left (-X while heading -Z)
            if (i === 360) {
                out.tires.driftX = r2(flatBtr.chassisPos.x - btrStart.x);
                out.tires.forward = r2(btrStart.z - flatBtr.chassisPos.z);
                out.tires.yaw = r2(yawOf(flatBtr), 3);
                flatBtr.controls.throttle = 0;
                flatBtr.controls.brake = true;
            }
            // top speed
            top.tank = Math.max(top.tank, speed(topTank));
            top.uaz = Math.max(top.uaz, speed(topUaz));
            top.tankGear = Math.max(top.tankGear, topTank.gear);
            top.uazGear = Math.max(top.uazGear, topUaz.gear);
            if (!top.gears.endsWith(String(topTank.gear))) top.gears += topTank.gear;
        }
        for (const v of [topTank, topUaz]) {
            v.controls.throttle = 0;
            v.controls.brake = true;
        }
        step(240);

        out.ram = {
            tankBefore: r2(ram.before, 1), tankMinAfter: r2(ram.minAfter, 1), uazThrown: r2(ram.uazMax, 1),
            uazEnd: [r2(ramUaz.chassisPos.x, 1), r2(ramUaz.chassisPos.y, 1), r2(ramUaz.chassisPos.z, 1)], tankUp: r2(upOf(ramTank), 3)
        };
        if (ram.hit < 0) fail('the T-90M never reached the UAZ');
        if (ram.uazMax < 15) fail(`the UAZ was not thrown (${ram.uazMax.toFixed(1)} km/h)`);
        if (ram.minAfter < ram.before * 0.85) fail(`the tank lost too much speed ramming a UAZ (${ram.before.toFixed(1)} -> ${ram.minAfter.toFixed(1)})`);
        out.props = {
            teethMoved: r2(teeth.position.distanceTo(teethStart)), teethTilt: r2(teeth.quaternion.angleTo(teethQuat)),
            crateBroken: crateProp.broken, brokenEvents, splinters, props: e.physics.props.length
        };
        if (out.props.teethMoved < 0.5 && out.props.teethTilt < 0.3) fail(`the concrete block was not shoved or toppled (${JSON.stringify(out.props)})`);
        if (!crateProp.broken || brokenEvents !== 1 || splinters < 3) fail('the crate did not splinter');
        out.bumps = { entryKmh: r2(bumps.entry, 1), minKmh: r2(bumps.min, 1), maxPitch: r2(bumps.maxPitch, 3), minUp: r2(bumps.minUp, 3), crossedAt: bumps.crossed };
        if (bumps.crossed < 0) fail(`the BMP-2 did not get over the bumps (z = ${bumpBmp.chassisPos.z.toFixed(1)})`);
        if (bumps.maxPitch < 0.03 || bumps.minUp < 0.9) fail('the BMP-2 must pitch over the bumps and stay upright');
        if (Math.abs(out.track.yaw) < 1.5 || out.track.moved > 8) fail(`a thrown track must pivot the tank in place (${JSON.stringify(out.track)})`);
        if (out.track.yaw < 0) fail('with the left track gone the tank must swing to the left (positive yaw)');
        if (out.tires.driftX > -0.5 || out.tires.forward < 5) fail(`flat left tyres must pull the BTR to the left (${JSON.stringify(out.tires)})`);
        out.top = { t90mKmh: r2(top.tank, 1), uazKmh: r2(top.uaz, 1), t90mGear: top.tankGear, uazGear: top.uazGear, t90mGears: top.gears };
        if (top.tank < 54 || top.tank > 68) fail(`T-90M top speed ${top.tank.toFixed(1)} km/h`);
        if (top.uaz < 85 || top.uaz > 103) fail(`UAZ top speed ${top.uaz.toFixed(1)} km/h`);
        if (top.tankGear < 6 || top.uazGear < 4) fail('the gearbox did not shift up');

        // --- ragdolls: hand-over without a snap, then the live limit
        const max = e.quality.profile.ragdolls.max;
        const victims = e.units.filter((u) => !u.isDead && u.faction === 'UA').slice(0, max + 2);
        if (victims.length < max + 2) fail('not enough soldiers for the ragdoll test');
        const hips = new T();
        const head = new T();
        const dir = new T(0, 0, -1);
        const wStat = { bulletMass: 0.0034, muzzleVelocity: 900, name: 'test' };
        const first = victims[0];
        first.root.updateWorldMatrix(true, true);
        const rootQuat = first.root.quaternion.clone();
        const hips0 = first.bones.hips.getWorldPosition(new T());
        const head0 = first.bones.head.getWorldPosition(new T());
        e.killSoldierWithRagdoll(first, 'TORSO', 'torso', hips0.clone().setY(1.3), dir, wStat, 'ВЫ');
        step(1);
        first.root.updateWorldMatrix(true, true);
        out.ragdoll = {
            rootTurn: r2(first.root.quaternion.angleTo(rootQuat), 5),
            hipsJump: r2(first.bones.hips.getWorldPosition(hips).distanceTo(hips0), 3),
            headJump: r2(first.bones.head.getWorldPosition(head).distanceTo(head0), 3)
        };
        if (out.ragdoll.rootTurn > 0.001) fail(`root quaternion snapped by ${out.ragdoll.rootTurn} rad when the ragdoll started`);
        if (out.ragdoll.hipsJump > 0.1 || out.ragdoll.headJump > 0.2) fail(`skeleton jumped when the ragdoll started (${JSON.stringify(out.ragdoll)})`);
        let overflow = 0;
        for (let i = 1; i < victims.length; i++) {
            step(20);
            const p = victims[i].root.position;
            e.killSoldierWithRagdoll(victims[i], 'TORSO', 'torso', new T(p.x, 1.3, p.z), dir, wStat, 'ВЫ');
            overflow = Math.max(overflow, e.physics.ragdolls.filter((r) => !r.frozen).length - max);
        }
        step(120);
        first.root.updateWorldMatrix(true, true);
        first.bones.hips.getWorldPosition(hips);
        first.bones.head.getWorldPosition(head);
        const frozen = e.physics.ragdolls.filter((r) => r.frozen);
        const hipsFrozen = hips.clone();
        step(60);
        first.root.updateWorldMatrix(true, true);
        Object.assign(out.ragdoll, {
            max, total: e.physics.ragdolls.length, live: e.physics.ragdolls.length - frozen.length, frozen: frozen.length, overflow,
            hipsY: r2(hips.y, 3), spine: r2(hips.distanceTo(head), 3),
            frozenDrift: r2(first.bones.hips.getWorldPosition(new T()).distanceTo(hipsFrozen), 6)
        });
        if (out.ragdoll.live > max) fail(`${out.ragdoll.live} live ragdolls, the limit is ${max}`);
        if (frozen.length !== 2 || frozen[0].unit !== first) fail('the oldest ragdolls must be the frozen ones');
        if (overflow > 2) fail('the ragdoll limit was exceeded by more than the grace allowance');
        if (!(hips.y < 0.6) || !(out.ragdoll.spine > 0.3 && out.ragdoll.spine < 0.9)) fail(`ragdoll pose is broken (${JSON.stringify(out.ragdoll)})`);
        if (out.ragdoll.frozenDrift > 1e-5) fail('a frozen ragdoll must stay in place');

        // --- destruction: the real turret is blown off and flies as debris
        const turret = pivotTank.parts && pivotTank.parts.turret;
        e.destroyVehicle(pivotTank, { attacker: 'ВЫ', label: 'test' });
        let apex = 0;
        for (let i = 0; i < 90; i++) {
            step(1);
            if (turret) apex = Math.max(apex, turret.position.y);
        }
        out.turret = { rigged: Boolean(turret), apex: r2(apex, 1), muzzle: e.vehicleParts.getMuzzle(pivotTank, new T(), new T()) };
        if (!turret || turret.parent !== e.scene || apex < 3) fail(`the turret was not blown off (${JSON.stringify(out.turret)})`);
        if (out.turret.muzzle !== false) fail('a vehicle without its turret must not report a muzzle');

        out.mainThreadMs = r2(e.physics.stats.stepMs, 3);
        out.simMs = r2(e.physics.stats.coreMs, 3);
        // Order-sensitive digest of every vehicle pose: equal between runs when stepping is deterministic.
        let digest = 0;
        for (const v of e.physics.vehicles) {
            for (const n of [v.chassisPos.x, v.chassisPos.y, v.chassisPos.z, v.chassisQuat.x, v.chassisQuat.y, v.chassisQuat.z, v.chassisQuat.w]) {
                digest = (Math.imul(digest, 31) + Math.round(n * 1e5)) | 0;
            }
        }
        out.digest = digest;
        out.views = {
            ram: [ramTank.chassisPos.x, ramTank.chassisPos.z, ramUaz.chassisPos.x, ramUaz.chassisPos.z],
            track: [pivotTank.chassisPos.x, pivotTank.chassisPos.z],
            btr: [flatBtr.chassisPos.x, flatBtr.chassisPos.z],
            rag: [first.root.position.x, first.root.position.z]
        };
        e.updatePlayerController = () => {};
        e.viewmodelRoot.visible = false;
        window.__view = (px, py, pz, tx, ty, tz) => {
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
        };
        return out;
    });
    const views = report.views;
    delete report.views;
    log('PHYSICS', JSON.stringify(report));
    const shots = {
        ram: [views.ram[0] + 14, 7, views.ram[1] + 16, (views.ram[0] + views.ram[2]) / 2, 0.5, (views.ram[1] + views.ram[3]) / 2],
        thrown_track: [views.track[0] + 9, 5, views.track[1] + 11, views.track[0], 1.2, views.track[1]],
        flat_tyres: [views.btr[0] - 4.5, 1.3, views.btr[1] - 6, views.btr[0], 1.0, views.btr[1]],
        ragdolls: [views.rag[0] + 4, 3.2, views.rag[1] - 7.5, views.rag[0] + 4, 0.2, views.rag[1] - 1]
    };
    for (const [name, v] of Object.entries(shots)) {
        await ev((a) => window.__view(...a), v);
        await wait(1200);
        await shot(name);
    }
};
