// gfx package checks: environment, LOD, culling, instancing and post-processing.
//   node tools/smoke.mjs tools/scenarios/gfx.mjs --out /tmp/shots/gfx --query "quality=low&dynamicResolution=false"
// Run with quality=medium|high|ultra to exercise the composer and shadow-caster cutoff as well.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);
    const report = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const fail = (msg) => { throw new Error(`gfx: ${msg}`); };
        e.selectFactionAndStart('RU');
        e.isPointerLocked = true;
        window.BATTLE_ENGINE.step(12);
        e.updatePlayerController = () => {};
        e.updateUnitsAndSquadAI = () => {};
        e.viewmodelRoot.visible = false;
        const profile = e.quality.profile;
        const view = (px, py, pz, tx, ty, tz) => {
            e.cameraMount.position.set(px, py, pz);
            e.cameraMount.updateMatrixWorld(true);
            e.camera.lookAt(tx, ty, tz);
            window.BATTLE_ENGINE.step(12);
        };
        window.__view = view;
        const rifleLod0 = () => {
            let bad = 0;
            for (const u of e.units) {
                const rifle = u.root.userData.rifleMesh;
                if (rifle) rifle.traverse((o) => { if (o.isMesh && o.userData.lod === 0 && o.visible) bad++; });
            }
            return bad;
        };

        // Environment
        if (!e.environment.sky || !e.environment.sky.parent) fail('sky dome missing');
        if (!e.scene.fog || !(e.scene.fog.density > 0)) fail('fog missing');
        if (Boolean(e.scene.environment) !== Boolean(profile.lighting.envMap)) fail('environment map does not follow the preset');
        if (!e.groundMaterial || !e.groundMaterial.map) fail('ground albedo missing');
        if (e.debugGrid.visible) fail('debug grid visible');

        // LOD levels follow the camera distance; AI rifles never show LOD 0.
        const unit = e.units.find((u) => u.faction === 'UA' && !u.isDead);
        const p = unit.root.position;
        view(p.x, 1.6, p.z + 3, p.x, 1.0, p.z);
        if (e.lod.levelOf(unit) !== 0) fail(`expected LOD 0 next to the unit, got ${e.lod.levelOf(unit)}`);
        if (rifleLod0()) fail('an AI rifle renders LOD 0 up close');
        view(p.x, 1.6, p.z + profile.lod.soldierLod1 * 1.3, p.x, 1.0, p.z);
        if (e.lod.levelOf(unit) !== 1) fail(`expected LOD 1, got ${e.lod.levelOf(unit)}`);
        view(p.x, 1.6, p.z + profile.lod.soldierLod2 * 1.3, p.x, 1.0, p.z);
        if (e.lod.levelOf(unit) !== 2) fail(`expected LOD 2, got ${e.lod.levelOf(unit)}`);
        if (rifleLod0()) fail('an AI rifle renders LOD 0 at range');
        if (profile.shadows.enabled) {
            const caster = [];
            unit.root.traverse((o) => { if (o.isSkinnedMesh && o.visible) caster.push(o.castShadow); });
            const expected = profile.lod.soldierLod2 * 1.3 < profile.lod.shadowCasterDistance;
            if (caster.some((c) => c !== expected)) fail('shadow-caster cutoff not applied');
        }

        // Distance culling and frustum culling.
        view(p.x, 1.6, p.z + profile.lod.cullDistance * 1.2, p.x, 1.0, p.z);
        if (e.lod.isVisible(unit) || unit.root.visible) fail('unit beyond cullDistance still visible');
        view(p.x, 1.6, p.z + 6, p.x, 1.0, p.z + 40);
        if (unit.root.visible) fail('unit behind the camera still drawn');
        view(p.x, 1.6, p.z + 6, p.x, 1.0, p.z);
        if (!unit.root.visible) fail('unit in view was hidden');

        // Respawn rebuilds the model: the new rifle must be handled before it is drawn.
        e.respawnDeadSoldier(unit);
        window.BATTLE_ENGINE.step(1);
        if (rifleLod0()) fail('respawned unit shows a LOD 0 rifle');

        // Instanced props keep per-instance control.
        const teeth = e.scene.children.filter((c) => c.userData.assetKey === 'dragons_teeth');
        const hesco = e.scene.children.filter((c) => c.userData.assetKey === 'hesco_bastion');
        const batches = e.scene.children.filter((c) => c.isInstancedMesh && c.name.startsWith('batch_'));
        if (teeth.length !== 9 || hesco.length !== 6) fail('fortification rows changed');
        if (batches.length < 2) fail(`expected instanced batches, found ${batches.length}`);
        if (!e.lod.setInstanceVisible(teeth[0], false) || !e.lod.setInstanceVisible(teeth[0], true)) fail('per-instance visibility failed');
        if (!e.lod.releaseInstance(hesco[0])) fail('releaseInstance failed');

        // Post-processing follows the preset.
        if (e.postfx.active !== Boolean(profile.postfx.composer)) fail('composer state does not follow the preset');
        if (Boolean(e.customRenderHook) !== Boolean(profile.postfx.composer)) fail('render hook state does not follow the preset');

        view(0, 34, 48, 0, 0, -8);
        e.viewmodelRoot.visible = true;
        return { preset: e.quality.preset, batches: batches.map((b) => `${b.name}x${b.count}`), merged: e.lod.stats.mergedDraws };
    });
    log('GFX', JSON.stringify(report));
    await wait(1200);
    await shot('gfx_overview');

    const frame = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const i = e.renderer.info;
        return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries };
    });
    log('GFX overview frame', JSON.stringify(frame));

    await ev(() => window.__view(-6, 1.6, 21.5, -4.5, 1.0, 17.5));
    await wait(1200);
    await shot('gfx_soldiers');
    await ev(() => window.__view(2, 1.7, 27.5, 0, 1.0, 25.5));
    await wait(1200);
    await shot('gfx_weapons');

    // Runtime preset switch: every module must follow quality:changed in both directions.
    const switched = await ev(async () => {
        const e = window.BATTLE_ENGINE.instance;
        const start = e.quality.preset;
        const other = start === 'low' ? 'medium' : 'low';
        const settle = async () => {
            for (let i = 0; i < 40; i++) {
                await new Promise((ok) => setTimeout(ok, 100));
                const p = e.quality.profile;
                if (e.postfx.active === Boolean(p.postfx.composer) && Boolean(e.scene.environment) === Boolean(p.lighting.envMap)) return true;
            }
            return false;
        };
        e.settings.set('quality', other);
        const there = await settle();
        e.settings.set('quality', start);
        const back = await settle();
        return { start, other, there, back };
    });
    log('GFX switch', JSON.stringify(switched));
    if (!switched.there || !switched.back) throw new Error('gfx: modules did not follow the runtime preset switch');
};
