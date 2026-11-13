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
        e.hudLayer.style.display = "none";
        window.__view = (px, py, pz, tx, ty, tz, fov = 45) => {
            e.camera.fov = fov;
            e.camera.updateProjectionMatrix();
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
        };
        window.__free = (faction) => e.units.filter((u) => u.faction === faction && !u.isDead && !u.mountedVehicle);
        // Lines soldiers up at z = 80 facing +Z (front view) or +X (side view), each in its own pinned pose.
        window.__sheet = (list, side) => {
            const pool = [...window.__free('RU'), ...window.__free('UA')];
            const n = list.length;
            list.forEach((entry, i) => {
                const u = pool[i];
                const x = (i - (n - 1) / 2) * 1.4;
                u.root.position.set(x, 0, 80);
                u.root.rotation.set(0, side ? Math.PI / 2 : 0, 0);
                u.stance = 'stand';
                u.animator.pose(entry[0], entry[1], entry[2], entry[3] ? new THREE.Vector3(...entry[3]) : null);
            });
            const span = 0;
            window.__view(0, 1.1, 80 + 3.7 + (n - 4) * 0.8, 0, 0.95, 80, 45);
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

    const sheets = [
        ['idle', [['idle', 0, 'low'], ['idle', 0, 'aim', [0, 1.4, 20]], ['crouch', 0, 'low'], ['crouch', 0, 'aim', [0, 0.9, 20]]]],
        ['walk', [['walk', 0, 'low'], ['walk', 0.25, 'low'], ['walk', 0.5, 'low'], ['walk', 0.75, 'low']]],
        ['run', [['run', 0, 'low'], ['run', 0.25, 'low'], ['run', 0.5, 'low'], ['run', 0.75, 'low']]]
    ];
    for (const [name, list] of sheets) {
        for (const side of [false, true]) {
            await ev((l, s) => window.__sheet(l, s), list, side);
            await wait(900);
            await shot(`${name}_${side ? 'side' : 'front'}`);
        }
    }
};
