// Regression scenario: boots a match and exercises the core loops (infantry fire, RPG, squad order,
// vehicle driving + gunnery, FPV strike). Run via `npm run smoke`; it must finish without page errors.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.selectFactionAndStart('RU');
        e.isPointerLocked = true;
        window.BATTLE_ENGINE.step(30);
    });
    await wait(1200);
    await shot('01_spawn');

    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        for (let i = 0; i < 10; i++) {
            e.setFiring(true);
            window.BATTLE_ENGINE.step(6);
        }
        e.setFiring(false);
        e.handleKeyDown({ code: 'Digit4' });
        e.pitch = 0.04;
        window.BATTLE_ENGINE.step(5);
        e.setFiring(true);
        e.setFiring(false);
        window.BATTLE_ENGINE.step(120);
    });
    await wait(800);
    await shot('02_rpg');

    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.handleKeyDown({ code: 'KeyG' });
        window.BATTLE_ENGINE.step(600);
    });
    await wait(800);
    await shot('03_assault');

    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const btr = e.ragdollPhysics.vehicles.find((v) => v.spec.key === 'btr80_ru');
        e.enterVehicleAsDriver(btr);
        e.keys.KeyW = true;
        window.BATTLE_ENGINE.step(240);
        e.setFiring(true);
        window.BATTLE_ENGINE.step(60);
        e.setFiring(false);
        e.keys.KeyW = false;
        window.BATTLE_ENGINE.step(30);
    });
    await wait(800);
    await shot('04_vehicle');

    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.exitCurrentVehicle();
        e.togglePlayerFpvDrone('KAMIKAZE');
        e.keys.KeyW = true;
        window.BATTLE_ENGINE.step(150);
        e.keys.KeyW = false;
    });
    await wait(800);
    await shot('05_fpv');

    const summary = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        if (e.fpvMode.active) e.detonatePlayerFpvDrone();
        window.BATTLE_ENGINE.step(120);
        const info = e.renderer.info;
        return {
            time: Number(e.time.toFixed(1)),
            kills: e.killsCount,
            aliveRU: e.units.filter((u) => !u.isDead && u.faction === 'RU').length,
            aliveUA: e.units.filter((u) => !u.isDead && u.faction === 'UA').length,
            vehicles: e.ragdollPhysics.vehicles.map((v) => `${v.spec.key}:${Math.round(v.hp)}`).join(' '),
            drawCalls: info.render.calls,
            triangles: info.render.triangles,
            disabledModules: e.modules.filter((m) => m.disabled).map((m) => m.name)
        };
    });
    await wait(800);
    await shot('06_end');
    log('SUMMARY', JSON.stringify(summary));
};
