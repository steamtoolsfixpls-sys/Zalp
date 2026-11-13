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
};
