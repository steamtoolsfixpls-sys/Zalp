import * as THREE from 'three';
import { AMMO, MINES } from './ammo_data.js';
import { launchAngle, G } from './ballistics_math.js';
import { RingPool, swapRemove } from '../core/pool.js';

// "ordnance" feature module: hand grenades (key 5, hold to cook), RDG-2 smoke (6), TM-62 anti-tank mines (7)
// and the RPG-7 backblast. Public: inventory, liveGrenades, mines, throwGrenade, throwSmoke, placeMine, rpgLaunch.
const GRENADE_POOL = 12;
const MINE_POOL = 12;
const BACKBLAST_RANGE = 8;
const BACKBLAST_COS = Math.cos(18 * Math.PI / 180);
const THROW_SPEED = 17;

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _l = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();

export function createOrdnance(engine) {
    const inventory = { frag: 3, smoke: 2, mine: 2, atgm: 0 };
    const liveGrenades = [];
    const mines = [];
    const knocked = [];
    const cook = { active: false, t: 0, fuse: 0, type: 'F1', smoke: false };
    let cookEl = null;
    let cookFill = null;
    let removers = [];

    const grenadeGeo = new THREE.SphereGeometry(0.036, 10, 8);
    grenadeGeo.scale(1, 1.25, 1);
    const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3a4630, roughness: 0.55, metalness: 0.4 });
    const smokeMat = new THREE.MeshStandardMaterial({ color: 0x8f989e, roughness: 0.6, metalness: 0.3 });
    const grenadePool = new RingPool(GRENADE_POOL, () => {
        const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
        mesh.visible = false;
        mesh.castShadow = false;
        engine.scene.add(mesh);
        return { active: false, mesh, pos: mesh.position, vel: new THREE.Vector3(), fuse: 0, ammo: null, thrower: null, isPlayer: false,
            attacker: '', faction: null, bounces: 0, rest: false, smoke: false, spin: 0 };
    });
    const mineGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.09, 14);
    const mineMat = new THREE.MeshStandardMaterial({ color: 0x4b5233, roughness: 0.7, metalness: 0.3 });
    const minePool = new RingPool(MINE_POOL, () => {
        const mesh = new THREE.Mesh(mineGeo, mineMat);
        mesh.visible = false;
        engine.scene.add(mesh);
        return { active: false, mesh, pos: mesh.position, armTime: 0, owner: null, attacker: '', faction: null };
    });
    const pinGeo = new THREE.BoxGeometry(0.012, 0.012, 0.045);
    const spoonGeo = new THREE.BoxGeometry(0.02, 0.006, 0.07);
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.8 });
    const bits = [];
    const bitPool = new RingPool(10, (i) => {
        const mesh = new THREE.Mesh(i % 2 ? spoonGeo : pinGeo, metalMat);
        mesh.visible = false;
        engine.scene.add(mesh);
        return { mesh, vel: new THREE.Vector3(), ttl: 0, spin: new THREE.Vector3() };
    });

    function attackerOf(thrower, isPlayer) {
        return isPlayer ? 'ВЫ' : (thrower && thrower.name) || 'ПРОТИВНИК';
    }

    // ------------------------------------------------------------------ grenades

    function releaseGrenade(g) {
        g.active = false;
        g.mesh.visible = false;
        const i = liveGrenades.indexOf(g);
        if (i !== -1) swapRemove(liveGrenades, i);
    }

    // Spawns a live grenade (or smoke). `velocity` is in world space; `fuse` in seconds.
    function launchGrenade(typeId, position, velocity, fuse, thrower, isPlayer, smoke = false) {
        const ammo = smoke ? AMMO.RGD5 : (AMMO[typeId] || AMMO.F1);
        const g = grenadePool.acquire();
        if (g.active) releaseGrenade(g);
        g.active = true;
        g.ammo = ammo;
        g.smoke = smoke;
        g.thrower = thrower || null;
        g.isPlayer = Boolean(isPlayer);
        g.attacker = attackerOf(thrower, isPlayer);
        g.faction = isPlayer ? engine.playerFaction : (thrower && thrower.faction) || null;
        g.fuse = fuse;
        g.bounces = 0;
        g.rest = false;
        g.pos.copy(position);
        g.vel.copy(velocity);
        g.spin = 8 + Math.random() * 8;
        g.mesh.material = smoke ? smokeMat : grenadeMat;
        g.mesh.visible = true;
        liveGrenades.push(g);
        spawnBits(position, velocity);
        engine.events.emit('launch', { pos: position, dir: _d.copy(velocity).normalize(), kind: smoke ? 'smoke' : 'grenade', shooter: thrower || null, isPlayer: g.isPlayer, projectile: g });
        return g;
    }

    function spawnBits(position, velocity) {
        for (let k = 0; k < 2; k++) {
            const b = bitPool.acquire();
            b.mesh.position.copy(position);
            b.vel.copy(velocity).multiplyScalar(0.25);
            b.vel.x += (Math.random() - 0.5) * 3;
            b.vel.y += 1 + Math.random() * 2;
            b.vel.z += (Math.random() - 0.5) * 3;
            b.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
            b.ttl = 2.2;
            b.mesh.visible = true;
            if (bits.indexOf(b) === -1) bits.push(b);
        }
    }

    function detonate(g) {
        const pos = g.pos;
        const ammo = g.ammo;
        if (g.smoke) {
            engine.events.emit('smoke:deployed', { pos, kind: 'rdg2', radius: 9, duration: 45 });
            const vfx = engine.vfx;
            if (vfx && typeof vfx.smokeScreen === 'function') vfx.smokeScreen({ pos, kind: 'rdg2', duration: 45 });
        } else {
            const b = ammo.blast;
            engine.triggerHighExplosiveBlast(pos.clone(), b.radius, b.force, b.damage, ammo.name, {
                kind: 'grenade', ammo: ammo.id, attacker: g.attacker, faction: g.faction, source: g.thrower
            });
        }
        releaseGrenade(g);
    }

    function stepGrenade(g, dt) {
        g.fuse -= dt;
        if (g.fuse <= 0) {
            detonate(g);
            return;
        }
        if (g.rest) {
            g.mesh.rotation.x *= 0.9;
            return;
        }
        g.vel.y -= G * dt;
        g.vel.multiplyScalar(1 - 0.08 * dt);
        const speed = g.vel.length();
        const len = speed * dt;
        _d.copy(g.vel).multiplyScalar(1 / Math.max(speed, 1e-6));
        let hit = null;
        if (engine.ballistics && typeof engine.ballistics.raycast === 'function') {
            hit = engine.ballistics.raycast(g.pos, _d, len + 0.05, { shooter: g.thrower });
        }
        if (hit && hit.hit && hit.distance <= len + 0.04) {
            g.bounces++;
            _v.copy(hit.normal);
            const vn = g.vel.dot(_v);
            g.vel.addScaledVector(_v, -(1 + 0.38) * vn);
            _l.copy(g.vel).addScaledVector(_v, -g.vel.dot(_v)).multiplyScalar(-0.15);
            g.vel.add(_l);
            g.pos.copy(hit.point).addScaledVector(_v, 0.04);
            if (g.vel.length() < 0.9 && _v.y > 0.5) g.rest = true;
        } else {
            g.pos.addScaledVector(g.vel, dt);
        }
        if (g.pos.y < 0.04) {
            g.pos.y = 0.04;
            if (g.vel.y < 0) g.vel.y *= -0.32;
            g.vel.x *= 0.7;
            g.vel.z *= 0.7;
            g.bounces++;
            if (g.vel.lengthSq() < 0.6) g.rest = true;
        }
        g.mesh.rotation.x += g.spin * dt;
        g.mesh.rotation.z += g.spin * 0.6 * dt;
    }

    // AI: lob a grenade to `target` (Vector3). type 'F1' | 'RGD5'. Returns the grenade or null when out of reach.
    function throwGrenade({ from, target, type = 'F1', thrower = null }) {
        return throwTo(from, target, type, thrower, false);
    }

    function throwSmoke({ from, target, thrower = null }) {
        return throwTo(from, target, 'RDG2', thrower, true);
    }

    function throwTo(from, target, type, thrower, smoke) {
        const ammo = smoke ? AMMO.RGD5 : (AMMO[type] || AMMO.F1);
        const dx = target.x - from.x;
        const dz = target.z - from.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 3) return null;
        for (const speed of [13, 16, 19, 22]) {
            const a = launchAngle(dist, target.y - from.y, speed);
            if (a === null) continue;
            const flight = dist / (speed * Math.cos(a));
            const vel = new THREE.Vector3(dx / dist * speed * Math.cos(a), speed * Math.sin(a), dz / dist * speed * Math.cos(a));
            const fuse = smoke ? flight + 0.4 : Math.min(ammo.fuse[1], Math.max(1.4, flight + 0.5 + Math.random() * 0.4));
            const g = launchGrenade(type, from, vel, fuse, thrower, false, smoke);
            engine.events.emit('callout', { key: smoke ? 'smoke' : 'grenade', faction: g.faction, pos: from, text: smoke ? 'Дым!' : 'Граната!' });
            return g;
        }
        return null;
    }

    // ------------------------------------------------------------------ player input

    function onFoot() {
        const pv = engine.playerVehicleState;
        return engine.isStarted && !engine.isPaused && !(pv && pv.vehicle && pv.role === 'DRIVER') && !(engine.fpvMode && engine.fpvMode.active)
            && !(engine.health && engine.health.state && engine.health.state.dead);
    }

    function startCook(smoke) {
        if (cook.active || !onFoot()) return true;
        const key = smoke ? 'smoke' : 'frag';
        if (inventory[key] <= 0) {
            engine.notify(smoke ? 'НЕТ ДЫМОВЫХ ГРАНАТ' : 'НЕТ ГРАНАТ', { kind: 'warn' });
            return true;
        }
        cook.active = true;
        cook.t = 0;
        cook.smoke = smoke;
        cook.type = engine.playerFaction === 'UA' ? 'RGD5' : 'F1';
        const f = AMMO[cook.type].fuse;
        cook.fuse = f[0] + Math.random() * (f[1] - f[0]);
        if (!smoke && cookEl) cookEl.style.display = 'block';
        return true;
    }

    function releaseCook() {
        if (!cook.active) return true;
        cook.active = false;
        if (cookEl) cookEl.style.display = 'none';
        if (!onFoot()) return true;
        engine.getAimRay(_o, _d);
        _d.y += 0.1;
        _d.normalize();
        _right.set(_d.z, 0, -_d.x).normalize();
        _p.copy(_o).addScaledVector(_d, 0.5).addScaledVector(_right, 0.15);
        _p.y -= 0.12;
        _v.copy(_d).multiplyScalar(THROW_SPEED).addScaledVector(engine.playerVelocity, 0.5);
        const remaining = cook.smoke ? 1.2 : cook.fuse - cook.t;
        inventory[cook.smoke ? 'smoke' : 'frag']--;
        if (remaining <= 0.15) {
            launchGrenade(cook.type, _p, _v, 0.01, null, true, cook.smoke);
        } else {
            launchGrenade(cook.type, _p, _v, remaining, null, true, cook.smoke);
        }
        return true;
    }

    // ------------------------------------------------------------------ mines

    function groundHeight(x, y, z) {
        _o.set(x, y + 1.2, z);
        _d.set(0, -1, 0);
        const r = engine.ballistics && engine.ballistics.raycast ? engine.ballistics.raycast(_o, _d, 3, {}) : null;
        return r && r.hit && r.kind !== 'soldier' ? r.point.y : 0;
    }

    function placeMine({ pos, owner = null, isPlayer = false }) {
        const mine = minePool.acquire();
        if (mine.active) releaseMine(mine);
        mine.active = true;
        mine.owner = owner;
        mine.attacker = attackerOf(owner, isPlayer);
        mine.faction = isPlayer ? engine.playerFaction : (owner && owner.faction) || null;
        mine.armTime = MINES.TM62.armDelay;
        mine.pos.set(pos.x, groundHeight(pos.x, pos.y, pos.z) + 0.045, pos.z);
        mine.mesh.visible = true;
        mines.push(mine);
        return mine;
    }

    function releaseMine(m) {
        m.active = false;
        m.mesh.visible = false;
        const i = mines.indexOf(m);
        if (i !== -1) swapRemove(mines, i);
    }

    function placePlayerMine() {
        if (!onFoot()) return true;
        if (inventory.mine <= 0) {
            engine.notify('НЕТ МИН ТМ-62М', { kind: 'warn' });
            return true;
        }
        const c = engine.playerCollider;
        _p.set(c.start.x - Math.sin(engine.yaw) * 1.3, c.start.y, c.start.z - Math.cos(engine.yaw) * 1.3);
        inventory.mine--;
        placeMine({ pos: _p, owner: null, isPlayer: true });
        engine.notify(`ТМ-62М УСТАНОВЛЕНА (ВЗВОД ЧЕРЕЗ ${MINES.TM62.armDelay.toFixed(1)} С), ОСТАЛОСЬ: ${inventory.mine}`, { kind: 'info' });
        return true;
    }

    // Contact patch test: does the vehicle's track or wheel cover the mine? Returns the side (-1 / 1) or 0.
    function underVehicle(veh, mine) {
        const pts = veh.suspPoints;
        if (!pts || !pts.length) return 0;
        _l.copy(mine.pos).sub(veh.chassisPos);
        _q.copy(veh.chassisQuat).invert();
        _l.applyQuaternion(_q);
        const hx = veh.spec.halfExtents[0];
        const hz = veh.spec.halfExtents[2];
        if (Math.abs(_l.x) > hx + 0.8 || Math.abs(_l.z) > hz + 1.0) return 0;
        const wr = (veh.wheelRadius || 0.5) * 0.7 + MINES.TM62.radius;
        if (veh.tuning && veh.tuning.tracked) {
            let zMin = Infinity, zMax = -Infinity, xSum = 0, n = 0;
            for (let i = 0; i < pts.length; i++) {
                const s = pts[i].local;
                if ((s.x < 0) !== (_l.x < 0)) continue;
                zMin = Math.min(zMin, s.z);
                zMax = Math.max(zMax, s.z);
                xSum += Math.abs(s.x);
                n++;
            }
            if (!n) return 0;
            const trackX = xSum / n;
            if (Math.abs(Math.abs(_l.x) - trackX) < 0.42 + MINES.TM62.radius && _l.z > zMin - 0.9 && _l.z < zMax + 0.9) return _l.x < 0 ? -1 : 1;
            return 0;
        }
        for (let i = 0; i < pts.length; i++) {
            const s = pts[i].local;
            if (Math.hypot(s.x - _l.x, s.z - _l.z) < wr) return s.x < 0 ? -1 : 1;
        }
        return 0;
    }

    function blowMine(m, veh, side) {
        const spec = MINES.TM62;
        const pos = m.pos.clone();
        const mob = veh.mobility || (veh.mobility = { trackL: 1, trackR: 1, tires: [1, 1, 1, 1, 1, 1, 1, 1], engine: 1 });
        if (!mob.tires) mob.tires = [1, 1, 1, 1, 1, 1, 1, 1];
        if (veh.tuning && veh.tuning.tracked) {
            if (side < 0) mob.trackL = 0;
            else mob.trackR = 0;
        } else {
            _l.copy(pos).sub(veh.chassisPos).applyQuaternion(_q.copy(veh.chassisQuat).invert());
            for (let i = 0; i < Math.min(8, veh.suspPoints.length); i++) {
                const s = veh.suspPoints[i].local;
                if (Math.hypot(s.x - _l.x, s.z - _l.z) < 1.7) mob.tires[i] = 0;
            }
        }
        engine.damageVehicle(veh, {
            amount: spec.vehDamage, pos, dir: _v.set(0, 1, 0), zone: 'belly', penetrated: true, ammo: spec.id, kind: 'mine', attacker: m.attacker, label: spec.name
        });
        engine.physics.applyVehicleImpulse(veh, _v.set(0, veh.tuning ? veh.tuning.mass * 5 : 8000, 0), pos);
        releaseMine(m);
        engine.triggerHighExplosiveBlast(pos, spec.blast.radius, spec.blast.force, spec.blast.damage, spec.name, {
            kind: 'mine', attacker: m.attacker, directVehicle: veh, fragments: 0
        });
    }

    function updateMines(dt) {
        const vehicles = engine.physics.vehicles;
        for (let i = mines.length - 1; i >= 0; i--) {
            const m = mines[i];
            if (m.armTime > 0) {
                m.armTime -= dt;
                continue;
            }
            for (let j = 0; j < vehicles.length; j++) {
                const veh = vehicles[j];
                if (veh.destroyed) continue;
                if (veh.chassisPos.distanceToSquared(m.pos) > (veh.spec.halfExtents[2] + 2.5) ** 2) continue;
                const mass = veh.tuning ? veh.tuning.mass : veh.spec.mass;
                if (mass < MINES.TM62.minTriggerMass) continue;
                if (Math.abs(veh.forwardSpeed || 0) < 0.15 && (veh.speedKmh || 0) < 0.5) continue;
                const side = underVehicle(veh, m);
                if (side !== 0) {
                    blowMine(m, veh, side);
                    break;
                }
            }
        }
    }

    // ------------------------------------------------------------------ RPG backblast

    // Hurts and pushes soldiers (and the player when the shooter is an AI) in the cone behind the launcher.
    function rpgLaunch({ origin, dir, shooter = null, isPlayer = false, attacker = null, projectile = null }) {
        _d.copy(dir).normalize();
        engine.events.emit('launch', { pos: origin, dir: _d, kind: 'rpg', shooter, isPlayer, projectile });
        const vfx = engine.vfx;
        if (vfx && typeof vfx.backblast === 'function') vfx.backblast({ pos: origin, dir: _d });
        const back = _v.copy(_d).negate();
        const who = attacker || attackerOf(shooter, isPlayer);
        let count = 0;
        for (const u of engine.units) {
            if (u.isDead || u === shooter || !u.root) continue;
            _p.set(u.root.position.x - origin.x, u.root.position.y + 1.1 - origin.y, u.root.position.z - origin.z);
            const dist = _p.length();
            if (dist < 0.3 || dist > BACKBLAST_RANGE) continue;
            if (_p.dot(back) / dist < BACKBLAST_COS) continue;
            const trans = engine.ballistics && engine.ballistics.transmission
                ? engine.ballistics.transmission(origin.x, origin.y, origin.z, origin.x + _p.x, origin.y + _p.y, origin.z + _p.z) : 1;
            const k = (1 - dist / BACKBLAST_RANGE) * trans;
            if (k <= 0.02) continue;
            count++;
            const push = 3 + 9 * k;
            _l.copy(back);
            _l.y = 0;
            _l.normalize();
            knocked.push({ unit: u, vx: _l.x * push, vz: _l.z * push, t: 0.45 });
            _o.copy(u.root.position);
            _o.y += 1.1;
            engine.applyBulletHitToSoldier(u, 'TORSO', 'torso', _o.clone(), back.clone(), {
                id: 'backblast', name: 'Выхлоп РПГ-7', damage: Math.round(130 * k), bulletMass: 0.8, muzzleVelocity: 30 + 40 * k, kind: 'blast'
            }, who);
        }
        if (shooter && engine.isStarted && !isPlayer && !(engine.health && engine.health.state && engine.health.state.dead)) {
            const c = engine.playerCollider;
            _p.set(c.start.x - origin.x, c.start.y + 0.6 - origin.y, c.start.z - origin.z);
            const dist = _p.length();
            if (dist > 0.3 && dist < BACKBLAST_RANGE && _p.dot(back) / dist >= BACKBLAST_COS) {
                const k = 1 - dist / BACKBLAST_RANGE;
                engine.playerVelocity.addScaledVector(back, 4 + 8 * k);
                engine.damagePlayer({ amount: 70 * k, zone: 'TORSO', pos: origin.clone(), dir: back.clone(), attacker: who, source: 'Выхлоп РПГ-7' });
            }
        }
        return count;
    }

    function updateKnock(dt) {
        for (let i = knocked.length - 1; i >= 0; i--) {
            const k = knocked[i];
            k.t -= dt;
            if (k.t <= 0 || k.unit.isDead || !k.unit.root) {
                swapRemove(knocked, i);
                continue;
            }
            const f = k.t / 0.45;
            k.unit.root.position.x += k.vx * f * dt;
            k.unit.root.position.z += k.vz * f * dt;
        }
    }

    // ------------------------------------------------------------------ module

    function buildHud() {
        if (cookEl || !engine.hudLayer) return;
        const style = document.createElement('style');
        style.textContent = '#ord-cook{position:absolute;left:50%;top:58%;transform:translateX(-50%);width:130px;height:8px;'
            + 'background:rgba(12,16,20,.8);border:1px solid #e2b955;display:none}#ord-cook>i{display:block;height:100%;width:0;background:#e2b955}';
        document.head.appendChild(style);
        cookEl = document.createElement('div');
        cookEl.id = 'ord-cook';
        cookFill = document.createElement('i');
        cookEl.appendChild(cookFill);
        engine.hudLayer.appendChild(cookEl);
    }

    const mod = {
        name: 'ordnance',
        inventory,
        liveGrenades,
        mines,
        throwGrenade,
        throwSmoke,
        launchGrenade,
        placeMine,
        rpgLaunch,
        startCook,
        releaseCook,
        install() {
            buildHud();
            const input = engine.input;
            removers = [
                input.bind('Digit5', (e) => (e.repeat ? true : startCook(false))),
                input.bindUp('Digit5', () => releaseCook()),
                input.bind('Digit6', (e) => (e.repeat ? true : startCook(true))),
                input.bindUp('Digit6', () => releaseCook()),
                input.bind('Digit7', (e) => (e.repeat ? true : placePlayerMine()))
            ];
        },
        update(dt) {
            if (cook.active) {
                cook.t += dt;
                if (cookFill) cookFill.style.width = `${Math.min(100, cook.t / cook.fuse * 100)}%`;
                if (!cook.smoke && cook.t >= cook.fuse) {
                    cook.active = false;
                    if (cookEl) cookEl.style.display = 'none';
                    inventory.frag--;
                    const c = engine.playerCollider;
                    _p.set(c.start.x, c.start.y + 0.9, c.start.z);
                    const g = launchGrenade(cook.type, _p, _v.set(0, 0, 0), 0.01, null, true, false);
                    g.rest = true;
                }
            }
            for (let i = liveGrenades.length - 1; i >= 0; i--) stepGrenade(liveGrenades[i], dt);
            updateMines(dt);
            updateKnock(dt);
            for (let i = bits.length - 1; i >= 0; i--) {
                const b = bits[i];
                b.ttl -= dt;
                if (b.ttl <= 0) {
                    b.mesh.visible = false;
                    swapRemove(bits, i);
                    continue;
                }
                b.vel.y -= G * dt;
                b.mesh.position.addScaledVector(b.vel, dt);
                if (b.mesh.position.y < 0.01) {
                    b.mesh.position.y = 0.01;
                    b.vel.multiplyScalar(0.3);
                    b.vel.y = Math.abs(b.vel.y);
                }
                b.mesh.rotation.x += b.spin.x * dt;
                b.mesh.rotation.y += b.spin.y * dt;
            }
        }
    };
    return mod;
}
