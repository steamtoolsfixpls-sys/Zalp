// Free-camera survey: node tools/smoke.mjs tools/scenarios/views.mjs --out /tmp/shots/x [--views "name:px,py,pz,tx,ty,tz;..."]
// Starts a match, freezes the player controller and renders named viewpoints.
const DEFAULT_VIEWS = {
    overview: [0, 34, 48, 0, 0, -8],
    armor_row: [-8, 5, 24, -8, 1.2, 12],
    soldiers: [-6, 1.6, 21.5, -4.5, 1.0, 17.5],
    enemy_line: [0, 12, -12, 0, 0, -36]
};

export default async ({ shot, wait, ev, log }) => {
    const arg = process.argv.indexOf('--views');
    let views = DEFAULT_VIEWS;
    if (arg !== -1) {
        views = {};
        for (const part of process.argv[arg + 1].split(';')) {
            const [name, nums] = part.split(':');
            views[name] = nums.split(',').map(Number);
        }
    }
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.selectFactionAndStart('RU');
        window.BATTLE_ENGINE.step(20);
        e.updatePlayerController = () => {};
        e.viewmodelRoot.visible = false;
        window.__view = (px, py, pz, tx, ty, tz) => {
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
        };
    });
    for (const [name, v] of Object.entries(views)) {
        await ev((a) => window.__view(...a), v);
        await wait(1500);
        await shot(name);
    }
    log('RENDER', JSON.stringify(await ev(() => {
        const i = window.BATTLE_ENGINE.instance.renderer.info;
        return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures };
    })));
};
