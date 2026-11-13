// Health scenario: node tools/smoke.mjs tools/scenarios/health.mjs --out /tmp/shots/health --query "quality=low&dynamicResolution=false"
// Leg hit -> bleeding, limp and blocked sprint; medicine with timers; drain to death -> respawn; AI rounds hurt the
// player; looting a fallen enemy; resupply at a BTR-80 and at a crate. Assertions throw.
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
        const rec = window.__rec = { died: 0, respawned: 0, hits: 0 };
        e.events.on('player:died', () => rec.died++);
        e.events.on('player:respawned', () => rec.respawned++);
        e.events.on('player:hit', () => rec.hits++);
        window.__flush = () => {
            let n = 0;
            while (e.ballistics.activeCount() > 0 && n < 240) { window.BATTLE_ENGINE.step(1); n++; }
            window.BATTLE_ENGINE.step(2);
        };
        window.__freeze = () => { window.BATTLE_ENGINE.step(2); e.isPaused = true; };
        window.__thaw = () => { e.isPaused = false; };
    });

    // 1. leg hit: bleeding, limp, no sprint
    const leg = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const h = e.health;
        const walk = () => {
            e.playerVelocity.set(0, 0, 0);
            e.keys.KeyW = true;
            e.keys.ShiftLeft = true;
            step(90);
            const out = { speed: Math.hypot(e.playerVelocity.x, e.playerVelocity.z), sprinting: e.isSprinting };
            e.keys.KeyW = false;
            e.keys.ShiftLeft = false;
            step(30);
            const c = e.playerCollider;
            c.start.set(-4, 0.36, 20.5);
            c.end.set(-4, 1.44, 20.5);
            return out;
        };
        const healthy = walk();
        if (!healthy.sprinting) throw new Error('a healthy player must be able to sprint');
        if (e.modifier('playerSpeed') !== 1 || e.modifier('canSprint') !== 1) throw new Error('modifiers must be neutral while healthy');
        e.damagePlayer({ amount: 26, zone: 'LEG', pos: new V(-4, 0.5, 20), dir: new V(-1, 0, 0), attacker: 'тест', source: 'АК' });
        step(2);
        const s = h.state;
        if (e.playerHp !== 74 || s.hp !== 74) throw new Error(`hp not synced (${e.playerHp}/${s.hp})`);
        if (s.wounds.legR !== 2) throw new Error(`heavy leg wound expected: ${JSON.stringify(s.wounds)}`);
        if (!(h.bleedRate() > 1)) throw new Error('no bleeding');
        const blood0 = s.blood;
        step(120);
        if (!(s.blood < blood0)) throw new Error('blood does not drain');
        const sp = e.modifier('playerSpeed');
        if (!(sp < 0.9) || e.modifier('canSprint') !== 0) throw new Error(`limp modifiers wrong (speed ${sp}, sprint ${e.modifier('canSprint')})`);
        if (!(e.modifier('aimSway') > 1.2)) throw new Error('pain must raise aim sway');
        const hurt = walk();
        if (hurt.sprinting) throw new Error('sprint must be blocked with a leg wound');
        if (!(hurt.speed < healthy.speed * 0.8)) throw new Error(`limp is too weak: ${hurt.speed} vs ${healthy.speed}`);
        return { healthy, hurt, speedMod: Number(sp.toFixed(2)), bleed: h.bleedRate(), pain: Number(s.pain.toFixed(2)), sway: Number(e.modifier('aimSway').toFixed(2)) };
    });
    log('HEALTH leg', JSON.stringify(leg));

    // 2. tourniquet: timer, blocks fire meanwhile, stops the bleeding, the limb stays impaired
    const tq = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const step = window.BATTLE_ENGINE.step;
        const s = e.health.state;
        e.input.tap('Digit9');
        step(5);
        if (!s.action || s.action.kind !== 'tourniquet') throw new Error('tourniquet action did not start');
        if (e.modifier('canFire') !== 0) throw new Error('firing must be blocked during an action');
        const progress = s.action.t / s.action.dur;
        step(150);
        if (s.action) throw new Error('tourniquet did not finish in time');
        if (e.health.bleedRate() !== 0) throw new Error('bleeding did not stop');
        if (s.limbs.legR !== 'tourniquet') throw new Error('the limb must be marked');
        if (s.supplies.tourniquet !== 1) throw new Error('supply not consumed');
        if (!(e.modifier('playerSpeed') < 1) || e.modifier('canSprint') !== 0) throw new Error('the limb must stay impaired');
        if (e.modifier('canFire') !== 1) throw new Error('fire must be allowed again');
        const blood = s.blood;
        step(120);
        if (s.blood !== blood) throw new Error('blood still draining');
        return { progress: Number(progress.toFixed(2)), blood: Number(blood.toFixed(1)) };
    });
    log('HEALTH tourniquet', JSON.stringify(tq));

    // 3. bandage for light bleeding, interrupted attempts, painkillers
    const meds = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const s = e.health.state;
        e.damagePlayer({ amount: 14, zone: 'TORSO', pos: new V(), dir: new V(0, 0, -1), attacker: 'тест', source: 'АК' });
        if (s.wounds.torso !== 1) throw new Error(`light torso wound expected: ${JSON.stringify(s.wounds)}`);
        e.input.tap('Digit8');
        step(30);
        e.isFiring = true;
        step(2);
        e.isFiring = false;
        if (s.action) throw new Error('firing must interrupt the bandage');
        if (s.supplies.bandage !== 2) throw new Error('an interrupted action must not use up the supply');
        e.input.tap('Digit8');
        step(200);
        if (s.wounds.torso !== 0 || s.supplies.bandage !== 1) throw new Error(`bandage failed: ${JSON.stringify(s)}`);
        const swayBefore = e.modifier('aimSway');
        e.input.tap('Digit0');
        step(120);
        if (!(s.painkiller > 55)) throw new Error(`painkiller not active (${s.painkiller})`);
        const swayAfter = e.modifier('aimSway');
        if (!(swayAfter < swayBefore)) throw new Error('painkillers must reduce the sway');
        return { swayBefore: Number(swayBefore.toFixed(2)), swayAfter: Number(swayAfter.toFixed(2)), painkiller: Number(s.painkiller.toFixed(1)) };
    });
    log('HEALTH meds', JSON.stringify(meds));

    // 4. AI rounds reach health.applyDamage
    const ai = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const s = e.health.state;
        const c = e.playerCollider;
        const hp0 = s.hp;
        e.ballistics.fire({ origin: new V(56, c.start.y + 0.5, c.start.z), dir: new V(-1, 0, 0), ammo: '5.56x45', faction: 'UA', spread: 0 });
        window.__flush();
        if (!(s.hp < hp0) || e.playerHp !== s.hp) throw new Error(`AI round did not hurt (${hp0} -> ${s.hp})`);
        const hp1 = s.hp;
        e.events.emit('explosion', { pos: new V(c.start.x + 3, 0.2, c.start.z), radius: 10, force: 40, damage: 100, label: 'тест', kind: 'he' });
        if (!(s.hp < hp1)) throw new Error('the explosion fallback did not hurt');
        const hp2 = s.hp;
        e.events.emit('explosion', { pos: new V(c.start.x + 3, 0.2, c.start.z), radius: 10, force: 40, damage: 100, label: 'тест', kind: 'he', handledPlayer: true });
        if (s.hp !== hp2) throw new Error('handledPlayer explosions must be ignored');
        return { hp0, hp1, hp2 };
    });
    log('HEALTH ai', JSON.stringify(ai));

    // screenshots: HUD panel with wounds, then the blood-loss vignette
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        e.health.reset();
        const s = e.health.state;
        s.blood = 46;
        e.damagePlayer({ amount: 25, zone: 'ARM', pos: new V(), dir: new V(1, 0, 0), attacker: 'тест', source: 'АК' });
        e.damagePlayer({ amount: 12, zone: 'TORSO', pos: new V(), dir: new V(0, 0, 1), attacker: 'тест', source: 'АК' });
        window.__freeze();
    });
    await wait(500);
    await shot('hud_panel');
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        window.__thaw();
        e.health.state.blood = 24;
        e.health.state.hp = 38;
        e.playerHp = 38;
        window.BATTLE_ENGINE.step(10);
        e.damagePlayer({ amount: 6, zone: 'TORSO', pos: new window.__THREE.Vector3(), dir: new window.__THREE.Vector3(1, 0, -0.4).normalize(), attacker: 'тест', source: 'АК' });
        window.__freeze();
    });
    await wait(500);
    await shot('vignette');

    // 5. bleed out -> death -> respawn
    const death = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        window.__thaw();
        const h = e.health;
        h.reset();
        const s = h.state;
        e.damagePlayer({ amount: 22, zone: 'LEG', pos: new V(), dir: new V(-1, 0, 0), attacker: 'тест', source: 'АК' });
        e.damagePlayer({ amount: 22, zone: 'LEG', pos: new V(), dir: new V(1, 0, 0), attacker: 'тест', source: 'АК' });
        e.damagePlayer({ amount: 22, zone: 'ARM', pos: new V(), dir: new V(-1, 0, 0), attacker: 'тест', source: 'АК' });
        e.damagePlayer({ amount: 22, zone: 'ARM', pos: new V(), dir: new V(1, 0, 0), attacker: 'тест', source: 'АК' });
        const rate = h.bleedRate();
        if (!(rate > 5)) throw new Error(`bleed rate ${rate}`);
        let frames = 0;
        while (!s.dead && frames < 4000) { step(1); frames++; }
        if (!s.dead) throw new Error('did not bleed out');
        if (s.blood > 0.001 || window.__rec.died !== 1) throw new Error(`death state wrong (blood ${s.blood}, died ${window.__rec.died})`);
        const deathDisplay = document.getElementById('hp-death').style.display;
        if (deathDisplay !== 'flex') throw new Error('no death screen');
        e.input.tap('Digit8');
        if (s.action) throw new Error('no medicine while dead');
        const seconds = Number((frames / 60).toFixed(1));
        let respawnFrames = 0;
        while (s.dead && respawnFrames < 600) { step(1); respawnFrames++; }
        if (s.dead || window.__rec.respawned !== 1) throw new Error('no respawn');
        if (respawnFrames < 270 || respawnFrames > 330) throw new Error(`respawn took ${respawnFrames / 60} s`);
        if (s.hp !== s.maxHp || s.blood !== 100 || h.bleedRate() !== 0 || e.playerHp !== s.maxHp) throw new Error('state not reset');
        if (e.playerCollider.start.distanceTo(new V(-4, 0.36, 20.5)) > 0.5) throw new Error('not back at the start position');
        if (document.getElementById('hp-death').style.display !== 'none') throw new Error('death screen still visible');
        return { bleedSeconds: seconds, respawnSeconds: respawnFrames / 60 };
    });
    log('HEALTH death', JSON.stringify(death));

    // 6. loot a fallen enemy
    const loot = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const foe = e.units.find((u) => u.faction === 'UA' && !u.isDead && u.weaponKey === 'm4a1');
        foe.root.position.set(-60, 0, 90);
        const c = e.playerCollider;
        c.start.set(-60, 0.36, 100);
        c.end.set(-60, 1.44, 100);
        step(3);
        const hips = foe.bones.hips.getWorldPosition(new V());
        e.killSoldierWithRagdoll(foe, 'TORSO', 'torso', hips.clone().setY(1.3), new V(0, 0, -1), { bulletMass: 0.04, muzzleVelocity: 900, name: 'тест' }, 'ВЫ');
        step(180);
        const loot = e.loot;
        if (!loot.bodies.has(foe)) throw new Error('the body was not registered');
        // far away: F is not consumed and the prompt is hidden
        step(20);
        if (loot.nearest.kind) throw new Error('a body 10 m away must not be lootable');
        const p = foe.root.position;
        c.start.set(p.x + 1.4, 0.36, p.z + 0.3);
        c.end.set(p.x + 1.4, 1.44, p.z + 0.3);
        step(30);
        if (loot.nearest.kind !== 'body') throw new Error(`no loot candidate (${JSON.stringify(loot.nearest.kind)}) at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
        const promptEl = document.getElementById('loot-prompt');
        if (promptEl.style.display !== 'block' || !promptEl.textContent.includes('ОБЫСКАТЬ')) throw new Error(`prompt wrong: ${promptEl.textContent}`);
        window.__promptText = promptEl.textContent;
        e.weaponStates.m4a1.reserve = 10;
        window.__freeze();
        return { prompt: promptEl.textContent, body: p.x.toFixed(2) + ',' + p.z.toFixed(2) };
    });
    log('HEALTH loot prompt', JSON.stringify(loot));
    await wait(500);
    await shot('loot_prompt');
    const looted = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        window.__thaw();
        const before = e.weaponStates.m4a1.reserve;
        const f = e.loot.bodies.size;
        e.input.press('KeyF');
        e.input.release('KeyF');
        const after = e.weaponStates.m4a1.reserve;
        if (!(after >= before + 25)) throw new Error(`looting did not refill ammo (${before} -> ${after})`);
        if (e.loot.bodies.size !== f - 1) throw new Error('the body must be consumed');
        if (e.playerVehicleState.vehicle) throw new Error('F must not enter a vehicle while looting');
        const note = document.getElementById('squad-order-banner').textContent;
        if (!note.includes('ОБЫСКАНО')) throw new Error(`no result message: ${note}`);
        // a second press far from any lootable falls through to the legacy handler (no vehicle near here)
        e.input.press('KeyF');
        e.input.release('KeyF');
        return { before, after, note };
    });
    log('HEALTH loot', JSON.stringify(looted));

    // 7. resupply at the BTR-80, then F enters it; crate resupply
    const supply = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const step = window.BATTLE_ENGINE.step;
        const btr = e.physics.vehicles.find((v) => v.spec.key === 'btr80_ru');
        const c = e.playerCollider;
        const hx = btr.spec.halfExtents[0];
        const px = btr.chassisPos.x + hx + 1.6;
        c.start.set(px, 0.36, btr.chassisPos.z);
        c.end.set(px, 1.44, btr.chassisPos.z);
        e.weaponStates.ak12.reserve = 3;
        e.health.state.supplies.bandage = 0;
        e.ordnance.inventory.frag = 0;
        step(30);
        if (e.loot.nearest.kind !== 'vehicle') throw new Error(`no resupply candidate: ${e.loot.nearest.kind}`);
        e.input.press('KeyF');
        e.input.release('KeyF');
        if (e.weaponStates.ak12.reserve < 180 || e.health.state.supplies.bandage < 2 || e.ordnance.inventory.frag < 3) throw new Error('resupply did not refill');
        if (e.playerVehicleState.vehicle) throw new Error('the resupply press must not also enter the vehicle');
        step(5);
        e.input.press('KeyF');
        e.input.release('KeyF');
        const entered = Boolean(e.playerVehicleState.vehicle);
        if (!entered) throw new Error('the second F press must enter the vehicle');
        e.exitCurrentVehicle();
        step(5);
        // ammo crate
        const crate = new window.__THREE.Mesh(new window.__THREE.BoxGeometry(0.8, 0.5, 0.5), new window.__THREE.MeshBasicMaterial({ color: 0x556b2f }));
        crate.position.set(-60, 0.25, 130);
        crate.userData.ammoCrate = true;
        e.scene.add(crate);
        c.start.set(-60 + 1.2, 0.36, 130);
        c.end.set(-60 + 1.2, 1.44, 130);
        e.weaponStates.m4a1.reserve = 5;
        step(260);
        if (e.loot.nearest.kind !== 'crate') throw new Error(`crate not found: ${e.loot.nearest.kind}`);
        e.input.press('KeyF');
        e.input.release('KeyF');
        if (e.weaponStates.m4a1.reserve < 180) throw new Error('the crate did not resupply');
        return { entered, crate: true };
    });
    log('HEALTH supply', JSON.stringify(supply));

    const summary = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        window.BATTLE_ENGINE.step(60);
        return { hp: e.health.state.hp, disabledModules: e.modules.filter((m) => m.disabled).map((m) => m.name) };
    });
    log('HEALTH summary', JSON.stringify(summary));
    if (summary.disabledModules.length) throw new Error(`modules disabled: ${summary.disabledModules}`);
};
