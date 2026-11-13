// Ballistics scenario: node tools/smoke.mjs tools/scenarios/ballistics.mjs --out /tmp/shots/ballistics --query "quality=low&dynamicResolution=false"
// Physical rounds (travel time, drop), armour zones, ricochets, wall-bang, ERA, shrapnel behind cover, TM-62 mines,
// RPG backblast, and AI rounds that hurt the player. Every assertion throws on failure.
export default async ({ shot, wait, ev, log }) => {
    await ev(() => window.BATTLE_ENGINE.instance.assets.backgroundDone);

    await ev(async () => {
        const THREE = await import('three');
        const e = window.BATTLE_ENGINE.instance;
        const V = THREE.Vector3;
        window.__THREE = THREE;
        e.selectFactionAndStart('RU');
        e.isPointerLocked = true;
        window.BATTLE_ENGINE.step(30);
        e.updateUnitsAndSquadAI = () => {};
        e.updateAutonomousDrones = () => {};
        const rec = window.__rec = { impacts: [], vehHits: [], unitHits: [], near: [], era: [], expl: [], playerHits: [] };
        e.events.on('impact', (p) => rec.impacts.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z, surface: p.surface, penetrated: p.penetrated, ricochet: p.ricochet, ammo: p.ammo }));
        e.events.on('vehicle:hit', (p) => rec.vehHits.push({ id: p.vehicle.id, zone: p.zone, armorMm: p.armorMm, penetrated: p.penetrated, ricochet: p.ricochet, ammo: p.ammo }));
        e.events.on('unit:hit', (p) => rec.unitHits.push({ unit: p.unit, zone: p.zone, damage: p.damage }));
        e.events.on('bullet:nearmiss', (p) => rec.near.push({ target: p.target === 'player' ? 'player' : 'unit', dist: p.dist }));
        e.events.on('era:detonated', (p) => rec.era.push(p.vehicle.id));
        e.events.on('explosion', (p) => rec.expl.push({ kind: p.kind, label: p.label }));
        e.events.on('player:hit', (p) => rec.playerHits.push(p.amount));
        const step = window.BATTLE_ENGINE.step;
        window.__flush = (max = 240, dt = 1 / 60) => {
            let n = 0;
            while (e.ballistics.activeCount() > 0 && n < max) { step(1, dt); n++; }
            step(2, dt);
            return n;
        };
        window.__box = (w, h, d, x, y, z, ud = {}) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
            m.position.set(x, y, z);
            m.userData = { surface: 'concrete', ...ud };
            e.scene.add(m);
            m.updateMatrixWorld(true);
            e.staticShootableMeshes.push(m);
            return m;
        };
        window.__spawn = (key, x, z, yaw = 0) => {
            const spec = e.physics.vehicles.find((v) => v.spec.key === key).spec;
            const mesh = e.instantiateStaticModel(spec.key, spec.span);
            e.scene.add(mesh);
            return e.physics.createPhysicalVehicle(spec, mesh, new V(x, 0, z), yaw);
        };
        window.__ua = (n) => e.units.filter((u) => u.faction === 'UA' && !u.isDead)[n];
    });

    // 1. travel time and drop of a 5.45 round
    const flight = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const rec = window.__rec;
        const out = {};
        for (const [range, wallX] of [[100, -50], [200, 50]]) {
            const wall = window.__box(0.3, 8, 8, wallX, 4, 200);
            const before = rec.impacts.length;
            e.ballistics.fire({ origin: new V(wallX - range, 2, 200), dir: new V(1, 0, 0), ammo: '5.45x39', isPlayer: true, spread: 0, emitShot: false });
            let frames = 0;
            while (rec.impacts.length === before && frames < 400) {
                window.BATTLE_ENGINE.step(1, 1 / 240);
                frames++;
            }
            if (rec.impacts.length === before) throw new Error(`no impact at ${range} m`);
            const hit = rec.impacts[rec.impacts.length - 1];
            out[range] = { time: Number((frames / 240).toFixed(3)), drop: Number((2 - hit.y).toFixed(3)), z: Number((hit.z - 200).toFixed(3)) };
            wall.parent.remove(wall);
            e.staticShootableMeshes.splice(e.staticShootableMeshes.indexOf(wall), 1);
        }
        if (!(out[100].time > 0.095 && out[100].time < 0.14)) throw new Error(`time to 100 m ${out[100].time}`);
        if (!(out[100].drop > 0.03 && out[100].drop < 0.2)) throw new Error(`drop at 100 m ${out[100].drop}`);
        if (!(out[200].time > out[100].time * 2) || !(out[200].drop > out[100].drop * 3)) throw new Error(`drop does not grow: ${JSON.stringify(out)}`);
        return out;
    });
    log('BALLISTICS flight', JSON.stringify(flight));

    // 2. armour zones
    const armor = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const rec = window.__rec;
        const step = window.BATTLE_ENGINE.step;
        const btr = window.__spawn('btr80_ru', 100, 40);
        const uaz = window.__spawn('uaz452', 100, 70);
        const t90 = window.__spawn('t90m_ru', 160, -20);
        step(150);
        const c = (v) => v.hitProxyMesh.getWorldPosition(new V());
        const lastHit = () => rec.vehHits[rec.vehHits.length - 1];
        const shoot = (origin, dir, ammo) => {
            const n = rec.vehHits.length;
            e.ballistics.fire({ origin, dir, ammo, isPlayer: true, spread: 0, emitShot: false });
            window.__flush();
            if (rec.vehHits.length === n) throw new Error(`${ammo} did not hit a vehicle`);
            return lastHit();
        };
        const out = {};
        const bc = c(btr);
        const side = (ammo) => shoot(new V(bc.x + 200, 1.2, bc.z), new V(-1, 0, 0), ammo);
        out.btr545 = side('5.45x39');
        out.btr145 = side('14.5x114');
        out.btrSabot = side('125APFSDS');
        if (out.btr545.penetrated) throw new Error('5.45 must not penetrate the BTR-80 side at 200 m');
        if (!out.btr145.penetrated || !out.btrSabot.penetrated) throw new Error(`14.5 mm / APFSDS must penetrate the BTR-80 side ${JSON.stringify(out)}`);
        if (!out.btr545.zone.endsWith('_side')) throw new Error(`BTR zone ${out.btr545.zone}`);
        const uc = c(uaz);
        out.uaz = shoot(new V(uc.x + 100, 1.0, uc.z), new V(-1, 0, 0), '5.45x39');
        if (!out.uaz.penetrated) throw new Error('UAZ-452 sheet metal must be penetrated by 5.45');
        const tc = c(t90);
        out.t90 = shoot(new V(tc.x, 1.7, tc.z - 100), new V(0, 0, 1), '30AP');
        if (!out.t90.zone.startsWith('turret_front')) throw new Error(`T-90M zone ${out.t90.zone}`);
        if (out.t90.penetrated) throw new Error('30 mm must not penetrate the T-90M turret front');
        const hp = t90.hp;
        out.t90Hp = hp;
        // a shallow strike on the BTR-80 front plate bounces
        const fz = bc.z - btr.hitProxyMesh.geometry.parameters.depth / 2;
        const ang = Math.atan2(0.24, 0.97);
        out.ricochet = shoot(new V(bc.x + 0.5 - 20 * Math.cos(ang), 1.2, fz - 20 * Math.sin(ang)), new V(Math.cos(ang), 0, Math.sin(ang)), '5.45x39');
        if (!out.ricochet.ricochet || out.ricochet.penetrated) throw new Error(`shallow hit did not ricochet: ${JSON.stringify(out.ricochet)}`);
        if (!rec.impacts.some((i) => i.ricochet)) throw new Error('no ricochet impact event');
        return out;
    });
    log('BALLISTICS armor', JSON.stringify(armor));

    // 3. wall-bang through a wooden crate
    const bang = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const rec = window.__rec;
        const unit = window.__ua(0);
        unit.root.position.set(-60, 0, 150);
        unit.root.rotation.y = Math.PI;
        const aim = new V(-60, 0, 150);
        window.BATTLE_ENGINE.step(1);
        unit.bones.chest.getWorldPosition(aim);
        const shootAt = () => {
            unit.hp = 100;
            const n = rec.unitHits.length;
            e.ballistics.fire({ origin: new V(aim.x, aim.y, aim.z - 30), dir: new V(0, 0, 1), ammo: '5.45x39', isPlayer: true, spread: 0, emitShot: false });
            window.__flush();
            if (rec.unitHits.length === n) throw new Error('the round did not reach the soldier');
            return rec.unitHits[rec.unitHits.length - 1].damage;
        };
        const direct = shootAt();
        const crate = window.__box(1.4, 1.6, 0.5, aim.x, 0.8, aim.z - 12, { surface: 'wood', penetrable: { mm: 90, material: 'crate' } });
        const nImp = rec.impacts.length;
        const through = shootAt();
        const penetrations = rec.impacts.slice(nImp).filter((i) => i.penetrated).length;
        if (penetrations < 1) throw new Error('the crate was not penetrated');
        if (!(through > 0 && through < direct)) throw new Error(`damage not reduced: direct ${direct}, through ${through}`);
        // a thick sandbag wall stops the same round
        const wall = window.__box(2, 1.6, 0.6, aim.x, 0.8, aim.z - 6, { surface: 'sandbag', penetrable: { mm: 400, material: 'sandbag' } });
        const n2 = rec.unitHits.length;
        unit.hp = 100;
        e.ballistics.fire({ origin: new V(aim.x, aim.y, aim.z - 30), dir: new V(0, 0, 1), ammo: '5.45x39', isPlayer: true, spread: 0, emitShot: false });
        window.__flush();
        if (rec.unitHits.length !== n2) throw new Error('sandbags must stop a 5.45 round');
        for (const m of [crate, wall]) { m.parent.remove(m); e.staticShootableMeshes.splice(e.staticShootableMeshes.indexOf(m), 1); }
        unit.hp = 100;
        return { direct, through, penetrations };
    });
    log('BALLISTICS wallbang', JSON.stringify(bang));

    // 4. grenade fragments: open ground versus behind a HESCO-like block
    const frags = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const open = window.__ua(1);
        const covered = window.__ua(2);
        const c = new V(-150, 0.06, 120);
        open.root.position.set(c.x + 6, 0, c.z);
        covered.root.position.set(c.x - 6, 0, c.z);
        open.hp = covered.hp = 100;
        const block = window.__box(1.0, 1.9, 5, c.x - 2.5, 0.95, c.z);
        window.BATTLE_ENGINE.step(2);
        const before = e.ballistics.stats.fragments;
        e.triggerHighExplosiveBlast(c, 3.8, 16, 150, 'Ф-1', { kind: 'grenade', ammo: 'F1', attacker: 'ВЫ' });
        const count = e.ballistics.stats.fragments - before;
        window.__flush(60);
        const out = { rays: count, openHp: open.hp, coveredHp: covered.hp };
        if (count < 40) throw new Error(`only ${count} fragment rays`);
        if (!(open.hp < 100)) throw new Error('fragments did not wound the soldier in the open');
        if (covered.hp !== 100) throw new Error(`the soldier behind cover was hit (${covered.hp})`);
        block.parent.remove(block);
        e.staticShootableMeshes.splice(e.staticShootableMeshes.indexOf(block), 1);
        open.hp = covered.hp = 100;
        return out;
    });
    log('BALLISTICS frags', JSON.stringify(frags));

    // 5. TM-62 mines: a tracked vehicle loses a track, a wheeled one loses tyres
    const mines = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const step = window.BATTLE_ENGINE.step;
        const out = {};
        const t72 = window.__spawn('t72b3_ru', 160, 100);
        const uaz = window.__spawn('uaz452', 220, 70);
        step(150);
        const run = (veh, key, pointOf) => {
            const p = pointOf(veh);
            const mine = e.ordnance.placeMine({ pos: p, isPlayer: true });
            mine.armTime = 0;
            const hp0 = veh.hp;
            veh.controls.throttle = 1;
            veh.controls.brake = false;
            let frames = 0;
            while (e.ordnance.mines.length > 0 && frames < 1200) { step(1); frames++; }
            veh.controls.throttle = 0;
            veh.controls.brake = true;
            if (e.ordnance.mines.length > 0) throw new Error(`${key}: the mine never went off (z=${veh.chassisPos.z.toFixed(1)})`);
            out[key] = { frames, hpLost: Math.round(hp0 - veh.hp), mobility: JSON.stringify(veh.mobility) };
        };
        run(t72, 'tracked', (v) => {
            const xs = v.suspPoints.map((s) => s.local.x);
            return new V(v.chassisPos.x + Math.min(...xs), 0, v.chassisPos.z - 22);
        });
        if (t72.mobility.trackL !== 0 || t72.mobility.trackR === 0) throw new Error(`track not blown: ${JSON.stringify(t72.mobility)}`);
        run(uaz, 'wheeled', (v) => {
            const s = v.suspPoints[0].local;
            return new V(v.chassisPos.x + s.x, 0, v.chassisPos.z + s.z - 14);
        });
        if (!uaz.mobility.tires.some((t) => t === 0)) throw new Error('no tyre was blown');
        if (!window.__rec.expl.some((x) => x.kind === 'mine')) throw new Error('no mine explosion event');
        return out;
    });
    log('BALLISTICS mines', JSON.stringify(mines));

    // 6. ERA: the first PG-7VL on an intact brick is defeated, the second on the spent brick penetrates
    const era = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const rec = window.__rec;
        const step = window.BATTLE_ENGINE.step;
        const tank = window.__spawn('t72b3_ru', 280, 100);
        step(150);
        const era0 = rec.era.length;
        const shot1 = () => {
            const n = rec.vehHits.length;
            const c = tank.hitProxyMesh.getWorldPosition(new V());
            e.ballistics.fireRocket({ origin: new V(c.x + 40, 0.9, c.z), dir: new V(-1, 0, 0), ammo: 'PG7VL', isPlayer: true, faction: 'RU' });
            window.__flush(300);
            if (rec.vehHits.length === n) throw new Error('the rocket missed the tank');
            return rec.vehHits[rec.vehHits.length - 1];
        };
        const hp0 = tank.hp;
        const first = shot1();
        const hp1 = tank.hp;
        const second = shot1();
        const out = { first, second, hpLostFirst: Math.round(hp0 - hp1), hpLostSecond: Math.round(hp1 - tank.hp), eraEvents: rec.era.length - era0 };
        if (first.penetrated || out.eraEvents < 1) throw new Error(`ERA did not defeat the first rocket: ${JSON.stringify(out)}`);
        if (!second.penetrated) throw new Error(`the second rocket did not penetrate: ${JSON.stringify(out)}`);
        if (out.eraEvents !== 1) throw new Error(`the spent brick detonated again ${JSON.stringify(out)}`);
        if (out.hpLostSecond < 300) throw new Error(`penetrating rocket did too little damage: ${JSON.stringify(out)}`);
        return out;
    });
    log('BALLISTICS era', JSON.stringify(era));

    // 7. AI rounds hurt the player; near misses are reported
    const player = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const V = window.__THREE.Vector3;
        const rec = window.__rec;
        const c = e.playerCollider;
        const target = new V(c.start.x, c.start.y + 0.5, c.start.z);
        const hp0 = e.playerHp;
        e.ballistics.fire({ origin: new V(56, target.y, target.z), dir: new V(-1, 0, 0), ammo: '5.56x45', faction: 'UA', spread: 0 });
        window.__flush();
        const hp1 = e.playerHp;
        if (!(hp1 < hp0)) throw new Error(`playerHp did not drop (${hp0} -> ${hp1})`);
        const nearBefore = rec.near.length;
        e.ballistics.fire({ origin: new V(56, target.y + 1.5, target.z), dir: new V(-1, 0, 0), ammo: '5.56x45', faction: 'UA', spread: 0 });
        window.__flush();
        const near = rec.near.slice(nearBefore).filter((n) => n.target === 'player');
        if (!near.length) throw new Error('no bullet:nearmiss for the player');
        // friendly rounds pass through the player
        const hp2 = e.playerHp;
        e.ballistics.fire({ origin: new V(56, target.y, target.z), dir: new V(-1, 0, 0), ammo: '5.56x45', faction: 'RU', spread: 0 });
        window.__flush();
        if (e.playerHp !== hp2) throw new Error('friendly fire hurt the player');
        // the AI entry point creates a real projectile
        const unit = window.__ua(3);
        const muzzle = new V(56, 1.4, 20.5);
        const ok = e.ballistics.aiFire(unit, muzzle, target, { id: 'm4a1', damage: 34, name: 'M4A1' }, null);
        const live = e.ballistics.activeCount();
        window.__flush();
        if (ok !== true || live < 1) throw new Error('aiFire did not create a projectile');
        return { hp0, hp1, nearDist: Number(near[0].dist.toFixed(2)) };
    });
    log('BALLISTICS player', JSON.stringify(player));

    // 8. RPG backblast hurts and pushes a soldier standing behind the launcher
    const blast = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const step = window.BATTLE_ENGINE.step;
        const victim = window.__ua(4);
        e.yaw = 0;
        e.pitch = 0.1;
        step(3);
        victim.root.position.set(e.playerCollider.start.x, 0, e.playerCollider.start.z + 3.5);
        victim.hp = 100;
        const z0 = victim.root.position.z;
        const launches = [];
        e.events.on('launch', (p) => launches.push(p.kind));
        e.launchRpgRocket({ id: 'rpg7', damage: 360, blastRadius: 11.5, blastForce: 68, name: 'РПГ-7В2' });
        step(40);
        const out = { hp: victim.hp, moved: Number((victim.root.position.z - z0).toFixed(2)), launches: launches.join(',') };
        if (!launches.includes('rpg')) throw new Error('no launch event');
        if (!(victim.hp < 100) && !victim.isDead) throw new Error(`backblast did not hurt (${JSON.stringify(out)})`);
        if (!(out.moved > 0.3)) throw new Error(`backblast did not push (${JSON.stringify(out)})`);
        return out;
    });
    log('BALLISTICS backblast', JSON.stringify(blast));

    // tracers in flight
    await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        const w = { id: 'ak12', damage: 36, name: 'АК-12', muzzleVelocity: 900, bulletMass: 0.042 };
        e.ballistics.clear();
        e.yaw = 0.05;
        e.pitch = 0;
        window.BATTLE_ENGINE.step(2);
        for (let i = 0; i < 8; i++) {
            e.performBallisticRaycast(w);
            window.BATTLE_ENGINE.step(1, 1 / 60);
        }
        e.isPaused = true;
    });
    await wait(700);
    await shot('tracers');
    const summary = await ev(() => {
        const e = window.BATTLE_ENGINE.instance;
        e.isPaused = false;
        window.BATTLE_ENGINE.step(60);
        return { ...e.ballistics.stats, active: e.ballistics.activeCount(), disabledModules: e.modules.filter((m) => m.disabled).map((m) => m.name) };
    });
    log('BALLISTICS summary', JSON.stringify(summary));
    if (summary.disabledModules.length) throw new Error(`modules disabled: ${summary.disabledModules}`);
};
