import * as THREE from 'three';
import { STATS } from '../../stats.js';
import { RingPool } from '../core/pool.js';
import { AMMO, WEAPON_AMMO, ammoForVehicle } from './ammo_data.js';
import { armorFor, MATERIAL_RESIST, SURFACE_COLORS } from './armor_data.js';
import * as M from './ballistics_math.js';

// "ballistics" feature module: pooled, physically stepped projectiles (drag, gravity, wind, energy loss),
// swept hit tests against soldiers, vehicle armour zones, static cover, the player and the ground,
// wall-bang, ricochets, reactive armour and shrapnel. Contract: docs/ARCHITECTURE.md.
const SUB_DT = 1 / 120;
const POOL = 192;
const TRACER_POOL = 48;
const SOLDIER_SPHERE = 1.3;
const NEAR_MISS = 1.5;
const K = { NONE: 0, GROUND: 1, STATIC: 2, VEHICLE: 3, SOLDIER: 4, PLAYER: 5, DRONE: 6 };
const PLAYER_ZONE_MULT = { HEAD: 2.2, TORSO: 1, ARM: 0.6, LEG: 0.65 };
const EXPLOSION_KIND = {
    PG7VL: 'pg7', PG7VR: 'pg7', '125HE': 'he125', '125HEAT': 'he125', '30HE': 'autocannon', FPV_RKG3: 'fpv', FPV_HE: 'fpv', VOG17: 'vog'
};
const FRAG_SCALE = { low: 0.75, medium: 1, high: 1.25, ultra: 1.5 };

const _dir = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _l0 = new THREE.Vector3();
const _l1 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _tmpV = new THREE.Vector3();
const _boxOut = { tIn: 0, inAxis: -1, inSign: 0, tOut: 0, outAxis: -1, outSign: 0 };
const _hit = {
    kind: K.NONE, t: Infinity, nx: 0, ny: 1, nz: 0, mesh: null, entry: null, vehicle: null, unit: null, zone: '', part: '',
    axis: 0, sign: 1, drone: null, surface: 'dirt', lx: 0, ly: 0, lz: 0
};
const _rc = new THREE.Raycaster();
const _rcHits = [];
const _impact = { pos: _pt, normal: _n, dir: _dir, surface: 'dirt', object: null, vehicle: null, weapon: null, ammo: '', penetrated: false, ricochet: false, energy: 0 };
const _vehEvent = { vehicle: null, pos: _a, normal: _b, dir: _dir, zone: '', armorMm: 0, penetrated: false, ricochet: false, ammo: '', attacker: '' };
const _nearEvent = { pos: _a, vel: _b, target: null, dist: 0 };
const _rayResult = { hit: false, kind: '', point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, object: null, unit: null, vehicle: null, zone: '', part: '' };

function makeProjectile(i) {
    return {
        index: i, active: false, ammo: null, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(),
        dist: 0, age: 0, shooter: null, faction: null, isPlayer: false, weapon: null, attacker: '', vehicle: null,
        baseDamage: 30, pens: 0, rics: 0, nearPlayer: false, nearUnit: null, tracer: null, tracerHandle: null, tracerAfter: 0,
        color: 0xffffff, rocket: null, rocketMesh: null, maxRange: 1500, skipPlayer: false, fragFalloff: 1, label: '', thrust: 0
    };
}

export function createBallistics(engine) {
    const pool = new RingPool(POOL, makeProjectile);
    const tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 1);
    tracerGeo.translate(0, 0, -0.5);
    const tracerMats = new Map();
    const tracerPool = new RingPool(TRACER_POOL, () => {
        const mesh = new THREE.Mesh(tracerGeo, tracerMatFor(0xffffff));
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.userData.owner = null;
        engine.scene.add(mesh);
        return mesh;
    });
    const rocketGeo = new THREE.ConeGeometry(0.06, 0.5, 8);
    rocketGeo.rotateX(-Math.PI / 2);
    const rocketMat = new THREE.MeshStandardMaterial({ color: 0x3d482e, roughness: 0.5 });
    const flameGeo = new THREE.ConeGeometry(0.05, 0.45, 6);
    flameGeo.rotateX(Math.PI / 2);
    flameGeo.translate(0, 0, 0.45);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    const rocketPool = new RingPool(8, () => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(rocketGeo, rocketMat));
        g.add(new THREE.Mesh(flameGeo, flameMat));
        g.visible = false;
        g.userData.owner = null;
        engine.scene.add(g);
        return g;
    });

    const meshCache = new WeakMap();
    let stamp = 0;
    let legacyFx = 0;
    const stats = { fired: 0, impacts: 0, penetrations: 0, ricochets: 0, soldierHits: 0, playerHits: 0, vehicleHits: 0, fragments: 0 };

    function tracerMatFor(color) {
        let m = tracerMats.get(color);
        if (!m) {
            m = new THREE.MeshBasicMaterial({ color, fog: false });
            tracerMats.set(color, m);
        }
        return m;
    }

    function factionColor(faction) {
        return faction === 'RU' ? 0x44ff55 : 0xff4433;
    }

    // ------------------------------------------------------------------ firing

    function resolveAmmo(ammo, weapon) {
        if (ammo && typeof ammo === 'object') return ammo;
        if (typeof ammo === 'string' && AMMO[ammo]) return AMMO[ammo];
        const wid = weapon && weapon.id;
        return AMMO[WEAPON_AMMO[wid] || (typeof ammo === 'string' && WEAPON_AMMO[ammo]) || '5.45x39'];
    }

    function acquire(ammo) {
        const p = pool.acquire();
        if (p.active) end(p);
        p.active = true;
        p.ammo = ammo;
        p.dist = 0;
        p.age = 0;
        p.pens = 0;
        p.rics = 0;
        p.nearPlayer = false;
        p.nearUnit = null;
        p.tracer = null;
        p.tracerHandle = null;
        p.tracerAfter = 0;
        p.rocket = null;
        p.rocketMesh = null;
        p.skipPlayer = false;
        p.fragFalloff = 1;
        p.maxRange = ammo.kind === 'frag' ? 40 : 1800;
        p.thrust = 0;
        return p;
    }

    // Random direction inside a cone of half-angle `spread` around `dir`, written to `out`.
    function jitter(out, dir, spread) {
        out.copy(dir);
        if (spread <= 0) return out;
        const r = spread * Math.sqrt(Math.random());
        const phi = Math.random() * Math.PI * 2;
        _a.set(Math.abs(dir.y) < 0.95 ? 0 : 1, Math.abs(dir.y) < 0.95 ? 1 : 0, 0).cross(dir).normalize();
        _b.copy(dir).cross(_a);
        out.addScaledVector(_a, Math.cos(phi) * r).addScaledVector(_b, Math.sin(phi) * r).normalize();
        return out;
    }

    function setup(p, o, ammo) {
        p.shooter = o.shooter || null;
        p.vehicle = o.vehicle || null;
        p.faction = o.faction || (o.shooter && o.shooter.faction) || (o.vehicle && o.vehicle.faction) || null;
        p.isPlayer = Boolean(o.isPlayer);
        p.weapon = o.weapon || null;
        p.attacker = o.attacker || (p.isPlayer ? 'ВЫ' : (o.shooter && o.shooter.name) || (o.vehicle && o.vehicle.name) || 'ПРОТИВНИК');
        p.baseDamage = o.damage ?? (o.weapon && o.weapon.damage) ?? ammo.damage;
        p.label = o.label || ammo.name;
        p.color = typeof ammo.tracer === 'number' ? ammo.tracer : factionColor(p.faction || engine.playerFaction);
    }

    function attachTracer(p) {
        if (!p.ammo.tracer || p.ammo.kind === 'frag') return;
        const vfx = engine.vfx;
        if (vfx && typeof vfx.bulletTracer === 'function') {
            p.tracerHandle = vfx.bulletTracer() || null;
            if (p.tracerHandle) return;
        }
        const mesh = tracerPool.acquire();
        mesh.userData.owner = p;
        mesh.material = tracerMatFor(p.color);
        mesh.visible = false;
        p.tracer = mesh;
    }

    // Fires one physical round. Returns the (pooled, do not keep) projectile.
    function fire(o) {
        const ammo = resolveAmmo(o.ammo, o.weapon);
        const p = acquire(ammo);
        setup(p, o, ammo);
        _dir.copy(o.dir);
        if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, -1);
        _dir.normalize();
        jitter(_dir, _dir, o.spread || 0);
        const speed = o.speed || ammo.v0 * (1 + (Math.random() - 0.5) * 0.01);
        p.pos.copy(o.origin);
        p.prev.copy(o.origin);
        p.vel.copy(_dir).multiplyScalar(speed);
        p.tracerAfter = p.isPlayer ? 9 : 2;
        if (o.tracer !== false) attachTracer(p);
        stats.fired++;
        if (o.emitShot !== false && ammo.caliber < 20 && ammo.kind !== 'frag') {
            engine.events.emit('shot', {
                pos: p.pos, dir: _dir, weapon: o.weapon || ammo, shooter: p.shooter, isPlayer: p.isPlayer, faction: p.faction, ammo: ammo.id
            });
        }
        return p;
    }

    // Rockets: slow launch, sustainer burns up to cruise speed. The launcher owner handles the backblast.
    function fireRocket(o) {
        const ammo = resolveAmmo(o.ammo || 'PG7VL', o.weapon);
        const p = acquire(ammo);
        setup(p, o, ammo);
        _dir.copy(o.dir).normalize();
        p.pos.copy(o.origin);
        p.prev.copy(o.origin);
        p.vel.copy(_dir).multiplyScalar(ammo.v0);
        p.rocket = ammo.rocket || { vMax: 250, delay: 0.1, accel: 600 };
        const mesh = rocketPool.acquire();
        mesh.userData.owner = p;
        mesh.visible = true;
        p.rocketMesh = mesh;
        p.maxRange = 1400;
        mesh.position.copy(p.pos);
        mesh.quaternion.setFromUnitVectors(_a.set(0, 0, -1), _dir);
        stats.fired++;
        return p;
    }

    function fireVehicleWeapon(vehicle, origin, dir, shellType) {
        if (!vehicle || !vehicle.spec) return false;
        const ammo = ammoForVehicle(vehicle.spec.key, shellType || vehicle.shellType || vehicle.selectedShell);
        const heavy = Boolean(vehicle.spec.isHeavyCannon);
        const playerVeh = engine.playerVehicleState && engine.playerVehicleState.vehicle === vehicle;
        fire({
            origin, dir, ammo, vehicle, faction: vehicle.faction, isPlayer: Boolean(playerVeh),
            spread: heavy ? 0.0008 : 0.004, damage: ammo.damage, emitShot: false,
            attacker: playerVeh ? 'ВЫ' : vehicle.name, label: `${vehicle.name} (${ammo.name})`
        });
        return true;
    }

    // ------------------------------------------------------------------ geometry caches

    function meshEntry(mesh) {
        let e = meshCache.get(mesh);
        if (!e) {
            const g = mesh.geometry;
            let kind = 3;
            let hx = 0, hy = 0, hz = 0;
            if (!g) kind = 2;
            else if (g.type === 'PlaneGeometry') kind = 2;
            else if (g.type === 'BoxGeometry' && g.parameters) {
                kind = 1;
                hx = g.parameters.width / 2;
                hy = g.parameters.height / 2;
                hz = g.parameters.depth / 2;
            }
            e = { stamp: -1, inv: new THREE.Matrix4(), kind, hx, hy, hz };
            meshCache.set(mesh, e);
        }
        if (e.stamp !== stamp) {
            mesh.updateWorldMatrix(true, false);
            e.inv.copy(mesh.matrixWorld).invert();
            e.stamp = stamp;
        }
        return e;
    }

    function syncHitboxes(unit) {
        if (unit._hbStamp === stamp) return;
        unit._hbStamp = stamp;
        engine.physics.syncSoldierHitboxes(unit);
    }

    // ------------------------------------------------------------------ swept test

    function consider(t, kind) {
        if (t >= _hit.t) return false;
        _hit.t = t;
        _hit.kind = kind;
        return true;
    }

    function traceStatic(p, ax, ay, az, len) {
        const list = engine.staticShootableMeshes;
        for (let i = 0; i < list.length; i++) {
            const mesh = list[i];
            if (!mesh.parent || (mesh.userData && mesh.userData.isVehicleHitbox)) continue;
            if (mesh.userData && mesh.userData.noBullets) continue;
            const e = meshEntry(mesh);
            if (e.kind === 2) continue;
            if (e.kind === 1) {
                _l0.set(ax, ay, az).applyMatrix4(e.inv);
                _l1.set(_dir.x * len + ax, _dir.y * len + ay, _dir.z * len + az).applyMatrix4(e.inv);
                if (M.segmentBox(_l0.x, _l0.y, _l0.z, _l1.x, _l1.y, _l1.z, e.hx, e.hy, e.hz, _boxOut) !== 1) continue;
                const t = _boxOut.tIn * len;
                if (!consider(t, K.STATIC)) continue;
                _hit.mesh = mesh;
                _hit.entry = e;
                _n.set(0, 0, 0).setComponent(_boxOut.inAxis, _boxOut.inSign).transformDirection(mesh.matrixWorld);
                _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
            } else {
                _a.set(ax, ay, az);
                _rc.set(_a, _dir);
                _rc.far = len;
                _rcHits.length = 0;
                _rc.intersectObject(mesh, false, _rcHits);
                if (!_rcHits.length) continue;
                const h = _rcHits[0];
                if (!consider(h.distance, K.STATIC)) continue;
                _hit.mesh = mesh;
                _hit.entry = null;
                if (h.face) _n.copy(h.face.normal).transformDirection(mesh.matrixWorld);
                else _n.set(0, 1, 0);
                _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
            }
        }
    }

    function traceVehicles(p, ax, ay, az, len) {
        const vehicles = engine.physics.vehicles;
        for (let i = 0; i < vehicles.length; i++) {
            const veh = vehicles[i];
            if (veh === p.vehicle || !veh.hitProxyMesh) continue;
            const proxy = veh.hitProxyMesh;
            const e = meshEntry(proxy);
            _l0.set(ax, ay, az).applyMatrix4(e.inv);
            _l1.set(_dir.x * len + ax, _dir.y * len + ay, _dir.z * len + az).applyMatrix4(e.inv);
            const hx = proxy.geometry.parameters.width / 2;
            const hy = proxy.geometry.parameters.height / 2;
            const hz = proxy.geometry.parameters.depth / 2;
            if (M.segmentBox(_l0.x, _l0.y, _l0.z, _l1.x, _l1.y, _l1.z, hx, hy, hz, _boxOut) !== 1) continue;
            if (!consider(_boxOut.tIn * len, K.VEHICLE)) continue;
            _hit.vehicle = veh;
            _hit.mesh = proxy;
            _hit.entry = e;
            _hit.axis = _boxOut.inAxis;
            _hit.sign = _boxOut.inSign;
            _hit.lx = _l0.x + (_l1.x - _l0.x) * _boxOut.tIn;
            _hit.ly = _l0.y + (_l1.y - _l0.y) * _boxOut.tIn;
            _hit.lz = _l0.z + (_l1.z - _l0.z) * _boxOut.tIn;
            _n.set(0, 0, 0).setComponent(_boxOut.inAxis, _boxOut.inSign).transformDirection(proxy.matrixWorld);
            _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
        }
    }

    function traceSoldiers(p, ax, ay, az, len) {
        const units = engine.units;
        const filterFaction = !p.isPlayer && p.faction;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.isDead || u === p.shooter || !u.root || !u.hitboxes || !u.hitboxes.length) continue;
            if (filterFaction && u.faction === p.faction) continue;
            const pos = u.root.position;
            // Broad phase: closest point of the segment to the soldier's centre.
            const cx = pos.x - ax, cy = pos.y + 0.9 - ay, cz = pos.z - az;
            let s = cx * _dir.x + cy * _dir.y + cz * _dir.z;
            s = s < 0 ? 0 : (s > len ? len : s);
            const dx = cx - _dir.x * s, dy = cy - _dir.y * s, dz = cz - _dir.z * s;
            if (dx * dx + dy * dy + dz * dz > SOLDIER_SPHERE * SOLDIER_SPHERE) continue;
            syncHitboxes(u);
            for (let j = 0; j < u.hitboxes.length; j++) {
                const hb = u.hitboxes[j];
                const par = hb.geometry.parameters;
                const r = par.radiusTop;
                const half = Math.max(0, par.height / 2 - r);
                const off = hb.userData.offsetY || 0;
                _qa.copy(hb.quaternion);
                // Local +Y of the hit-box in world space.
                const qx = _qa.x, qy = _qa.y, qz = _qa.z, qw = _qa.w;
                const yx = 2 * (qx * qy - qw * qz), yy = 1 - 2 * (qx * qx + qz * qz), yz = 2 * (qy * qz + qw * qx);
                const px = hb.position.x + yx * off, py = hb.position.y + yy * off, pz = hb.position.z + yz * off;
                const t = M.capsuleRay(
                    ax, ay, az, _dir.x, _dir.y, _dir.z,
                    px - yx * half, py - yy * half, pz - yz * half, px + yx * half, py + yy * half, pz + yz * half, r
                );
                if (t < 0 || t > len || !consider(t, K.SOLDIER)) continue;
                _hit.unit = u;
                _hit.zone = hb.userData.zone;
                _hit.part = hb.userData.partName;
                // Capsule normal from the closest axis point.
                _pt.set(ax + _dir.x * t - px, ay + _dir.y * t - py, az + _dir.z * t - pz);
                const along = _pt.x * yx + _pt.y * yy + _pt.z * yz;
                const clamped = along < -half ? -half : (along > half ? half : along);
                _n.set(_pt.x - yx * clamped, _pt.y - yy * clamped, _pt.z - yz * clamped);
                if (_n.lengthSq() < 1e-8) _n.copy(_dir).negate();
                _n.normalize();
                _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
            }
        }
    }

    function playerTargetable(p) {
        if (p.isPlayer || p.skipPlayer) return false;
        if (p.faction && p.faction === engine.playerFaction) return false;
        if (!engine.isStarted) return false;
        const pv = engine.playerVehicleState;
        if (pv && pv.vehicle && pv.role !== 'DESANT') return false;
        if (engine.fpvMode && engine.fpvMode.active) return false;
        if (engine.health && engine.health.state && engine.health.state.dead) return false;
        return true;
    }

    function tracePlayer(p, ax, ay, az, len) {
        if (!playerTargetable(p)) return;
        const c = engine.playerCollider;
        const r = c.radius;
        const t = M.capsuleRay(ax, ay, az, _dir.x, _dir.y, _dir.z, c.start.x, c.start.y, c.start.z, c.end.x, c.end.y, c.end.z, r);
        if (t < 0 || t > len || !consider(t, K.PLAYER)) return;
        const hx = ax + _dir.x * t, hy = ay + _dir.y * t, hz = az + _dir.z * t;
        const low = c.start.y - r;
        const frac = (hy - low) / Math.max(0.5, c.end.y + r - low);
        const lateral = Math.hypot(hx - c.start.x, hz - c.start.z);
        _hit.zone = frac > 0.86 ? 'HEAD' : (frac < 0.3 ? 'LEG' : (lateral > r * 0.72 ? 'ARM' : 'TORSO'));
        _n.set(hx - c.start.x, 0, hz - c.start.z);
        if (_n.lengthSq() < 1e-8) _n.copy(_dir).negate();
        _n.normalize();
        _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
    }

    function traceDrones(p, ax, ay, az, len) {
        const list = engine.droneOps && engine.droneOps.drones;
        if (!list || !list.length || p.ammo.kind === 'frag') return;
        for (let i = 0; i < list.length; i++) {
            const d = list[i];
            const pos = d.pos || (d.mesh && d.mesh.position);
            if (!pos || d.destroyed || d.dead || (p.faction && d.faction === p.faction)) continue;
            const t = M.capsuleRay(ax, ay, az, _dir.x, _dir.y, _dir.z, pos.x, pos.y, pos.z, pos.x, pos.y, pos.z, d.radius || 0.4);
            if (t < 0 || t > len || !consider(t, K.DRONE)) continue;
            _hit.drone = d;
            _n.copy(_dir).negate();
            _hit.nx = _n.x; _hit.ny = _n.y; _hit.nz = _n.z;
        }
    }

    // Nearest obstacle on the segment from (ax, ay, az) along unit _dir for `len` metres.
    function trace(p, ax, ay, az, len) {
        _hit.kind = K.NONE;
        _hit.t = Infinity;
        const by = ay + _dir.y * len;
        if (ay > 0 && by <= 0) {
            const t = len * ay / (ay - by);
            if (consider(t, K.GROUND)) {
                _hit.nx = 0; _hit.ny = 1; _hit.nz = 0;
                _hit.surface = 'dirt';
            }
        }
        traceStatic(p, ax, ay, az, len);
        traceVehicles(p, ax, ay, az, len);
        traceSoldiers(p, ax, ay, az, len);
        tracePlayer(p, ax, ay, az, len);
        traceDrones(p, ax, ay, az, len);
        return _hit.kind !== K.NONE;
    }

    // ------------------------------------------------------------------ effects

    function surfaceOf(mesh) {
        const u = mesh && mesh.userData;
        return (u && (u.surface || (u.penetrable && u.penetrable.material))) || 'concrete';
    }

    function impactFx(p, surface, extra) {
        _impact.surface = surface;
        _impact.weapon = p.weapon || p.ammo;
        _impact.ammo = p.ammo.id;
        _impact.energy = M.energyJ(p.ammo, p.vel.length());
        _impact.penetrated = Boolean(extra && extra.penetrated);
        _impact.ricochet = Boolean(extra && extra.ricochet);
        _impact.object = extra ? extra.object || null : null;
        _impact.vehicle = extra ? extra.vehicle || null : null;
        stats.impacts++;
        engine.events.emit('impact', _impact);
        const vfx = engine.vfx;
        if (vfx && typeof vfx.impact === 'function') {
            vfx.impact(_impact);
            if (_impact.ricochet && typeof vfx.sparks === 'function') vfx.sparks(_impact);
            return;
        }
        if (legacyFx >= 10 || p.ammo.kind === 'frag') return;
        const camDist = engine.cameraMount.position.distanceToSquared(_pt);
        if (camDist > 90 * 90) return;
        legacyFx++;
        const color = _impact.ricochet ? 0xffcc66 : (SURFACE_COLORS[surface] || 0x8a7962);
        engine.spawnImpactParticles(_pt, _n, surface === 'metal' ? 0xffaa33 : color, p.isPlayer ? 7 : 4);
    }

    function setHitPoint(p, t) {
        _pt.copy(_dir).multiplyScalar(t).add(p.prev);
    }

    function end(p) {
        p.active = false;
        if (p.tracer) {
            p.tracer.visible = false;
            p.tracer.userData.owner = null;
            p.tracer = null;
        }
        if (p.tracerHandle) {
            if (typeof p.tracerHandle.release === 'function') p.tracerHandle.release();
            p.tracerHandle = null;
        }
        if (p.rocketMesh) {
            p.rocketMesh.visible = false;
            p.rocketMesh.userData.owner = null;
            p.rocketMesh = null;
        }
    }

    // ------------------------------------------------------------------ hit resolution

    function speedFrac(p) {
        return M.energyFraction(p.ammo, p.vel.length());
    }

    function damageNow(p) {
        const f = speedFrac(p);
        return p.baseDamage * Math.min(1.1, Math.max(0.15, f)) * p.fragFalloff;
    }

    function scatter(p, sigma) {
        const sp = p.vel.length();
        _a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2 * sigma * sp);
        p.vel.add(_a).setLength(sp);
    }

    function resumeAt(p, nx, ny, nz) {
        p.pos.set(nx, ny, nz);
    }

    function onGround(p, t) {
        setHitPoint(p, t);
        _n.set(0, 1, 0);
        const grazing = Math.abs(_dir.y);
        if (p.ammo.kind !== 'frag' && !p.ammo.explosive && grazing < 0.1 && p.vel.length() > 300 && p.rics < 1) {
            p.rics++;
            stats.ricochets++;
            p.vel.y = Math.abs(p.vel.y) * 0.6 + 4;
            p.vel.multiplyScalar(0.55);
            scatter(p, 0.04);
            resumeAt(p, _pt.x, 0.04, _pt.z);
            impactFx(p, 'dirt', { ricochet: true });
            return;
        }
        if (p.ammo.explosive) explode(p, _pt, _n, null);
        else impactFx(p, 'dirt');
        end(p);
    }

    function onStatic(p, t) {
        const mesh = _hit.mesh;
        setHitPoint(p, t);
        _n.set(_hit.nx, _hit.ny, _hit.nz);
        const ud = mesh.userData || {};
        const surface = surfaceOf(mesh);
        const range = p.dist + t;
        if (p.ammo.explosive) {
            impactFx(p, surface, { object: mesh });
            explode(p, _pt, _n, null);
            end(p);
            return;
        }
        const pen = ud.penetrable;
        if (pen && p.pens < 2) {
            const resist = MATERIAL_RESIST[pen.material] ?? 0.5;
            const cos = Math.max(0.35, Math.abs(_dir.dot(_n)));
            const effMm = pen.mm * resist / cos;
            const avail = M.penetrationAt(p.ammo, range) * Math.min(1.3, Math.max(0.2, p.vel.length() / p.ammo.v0));
            if (avail >= effMm) {
                p.pens++;
                stats.penetrations++;
                p.vel.multiplyScalar(M.residualSpeedFraction(effMm, avail));
                scatter(p, 0.01 + 0.03 * Math.min(1, effMm / avail));
                impactFx(p, surface, { object: mesh, penetrated: true });
                resumeAt(p, _pt.x + _dir.x * 0.03, _pt.y + _dir.y * 0.03, _pt.z + _dir.z * 0.03);
                return;
            }
        }
        impactFx(p, surface, { object: mesh });
        end(p);
    }

    function onSoldier(p, t) {
        const unit = _hit.unit;
        const zone = _hit.zone;
        setHitPoint(p, t);
        const dmg = damageNow(p);
        const speed = p.vel.length();
        const wStat = {
            id: (p.weapon && p.weapon.id) || p.ammo.id,
            name: (p.weapon && p.weapon.name) || p.label || p.ammo.name,
            damage: dmg,
            bulletMass: p.ammo.impactMass,
            muzzleVelocity: speed,
            kind: p.ammo.kind === 'frag' ? 'blast' : 'bullet'
        };
        stats.soldierHits++;
        engine.applyBulletHitToSoldier(unit, zone, _hit.part, _pt.clone(), _dir.clone(), wStat, p.attacker);
        if (p.ammo.kind === 'apfsds' || (p.ammo.kind === 'ap' && p.ammo.caliber >= 20)) {
            p.vel.multiplyScalar(0.55);
            resumeAt(p, _pt.x + _dir.x * 0.1, _pt.y + _dir.y * 0.1, _pt.z + _dir.z * 0.1);
            p.pens++;
            if (p.pens > 2) end(p);
            return;
        }
        end(p);
    }

    function onPlayer(p, t) {
        const zone = _hit.zone;
        setHitPoint(p, t);
        const amount = damageNow(p) * (PLAYER_ZONE_MULT[zone] || 1);
        stats.playerHits++;
        engine.damagePlayer({
            amount, zone, pos: _pt.clone(), dir: _dir.clone(), attacker: p.attacker, source: p.label, ammo: p.ammo.id
        });
        end(p);
    }

    function onDrone(p, t) {
        const d = _hit.drone;
        setHitPoint(p, t);
        if (engine.droneOps && typeof engine.droneOps.damageDrone === 'function') engine.droneOps.damageDrone(d, damageNow(p));
        impactFx(p, 'metal');
        end(p);
    }

    function emitVehicleHit(p, veh, zone, armorMm, penetrated, ricochet) {
        _vehEvent.vehicle = veh;
        _vehEvent.zone = zone;
        _vehEvent.armorMm = armorMm;
        _vehEvent.penetrated = penetrated;
        _vehEvent.ricochet = ricochet;
        _vehEvent.ammo = p.ammo.id;
        _vehEvent.attacker = p.attacker;
        _a.copy(_pt);
        _b.set(_hit.nx, _hit.ny, _hit.nz);
        stats.vehicleHits++;
        engine.events.emit('vehicle:hit', _vehEvent);
    }

    // Reactive armour: returns the cell index within the zone, or -1 when the zone carries none.
    function eraCell(veh, armor, zoneKey, hx, hz, boxTop) {
        const era = armor.era;
        if (!era || !era.zones.includes(zoneKey)) return -1;
        const face = zoneKey.slice(zoneKey.indexOf('_') + 1);
        const u = face === 'side' ? _hit.lz : _hit.lx;
        const halfU = face === 'side' ? hz : hx;
        const cols = Math.max(1, Math.ceil(halfU * 2 / era.cell));
        const rows = Math.max(1, Math.ceil(boxTop / era.cell));
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((u + halfU) / era.cell)));
        const cy = Math.min(rows - 1, Math.max(0, Math.floor((_hit.ly + boxTop / 2 + 0.0) / era.cell)));
        if (!veh.eraBricks) veh.eraBricks = {};
        let cells = veh.eraBricks[zoneKey];
        if (!cells) cells = veh.eraBricks[zoneKey] = new Uint8Array(cols * rows);
        return cy * cols + cx;
    }

    function eraTriggers(p) {
        const a = p.ammo;
        return a.heat || a.kind === 'apfsds' || (a.kind === 'ap' && a.caliber >= 20) || a.id === '125HE';
    }

    function onVehicle(p, t) {
        const veh = _hit.vehicle;
        const proxy = _hit.mesh;
        setHitPoint(p, t);
        _n.set(_hit.nx, _hit.ny, _hit.nz);
        const ammo = p.ammo;
        const armor = armorFor(veh.spec.key);
        const par = proxy.geometry.parameters;
        const hx = par.width / 2, hy = par.height / 2, hz = par.depth / 2;
        const vehY = _hit.ly + proxy.position.y;
        const boxTop = hy * 2;
        const deckY = (veh.parts && veh.parts.rig && veh.parts.rig.turret && veh.parts.rig.turret.pivot && typeof veh.parts.rig.turret.pivot[1] === 'number')
            ? veh.parts.rig.turret.pivot[1] : armor.deck * (proxy.position.y + hy);
        let component = 'hull';
        let face = M.faceOf(_hit.axis, _hit.sign);
        if (armor.turret) {
            const above = vehY > deckY + 0.02;
            if (face === 'top') {
                if (Math.abs(_hit.lx) < hx * 0.62 && Math.abs(_hit.lz) < hz * 0.55) component = 'turret';
            } else if (above) {
                component = 'turret';
                const yaw = typeof veh.turretYawActual === 'number' ? veh.turretYawActual : (typeof veh.turretYaw === 'number' ? veh.turretYaw : 0);
                face = M.turretFace(yaw, _dir.x, _dir.z);
            }
        }
        const plate = (armor[component] || armor.hull)[face] ?? armor.hull.front;
        const zoneKey = `${component}_${face}`;
        const cos = Math.min(1, Math.abs(_dir.dot(_n)));
        const range = p.dist + t;
        const heatMul = ammo.heat ? armor.heatMul : 1;
        let penScale = 1;
        let eraDefeated = false;
        const momentum = ammo.mass * p.vel.length();

        if (veh.destroyed) {
            impactFx(p, 'metal', { vehicle: veh });
            if (ammo.explosive) explode(p, _pt, _n, null);
            end(p);
            return;
        }

        const cell = armor.era && eraTriggers(p) ? eraCell(veh, armor, zoneKey, hx, hz, boxTop) : -1;
        if (cell >= 0) {
            const cells = veh.eraBricks[zoneKey];
            if (cells[cell] === 0) {
                cells[cell] = 1;
                engine.events.emit('era:detonated', { vehicle: veh, pos: _pt, normal: _n });
                if (engine.vfx && typeof engine.vfx.explosion === 'function') engine.vfx.explosion(_pt, { kind: 'era', radius: 1.6, normal: _n });
                if (ammo.heat && !ammo.tandem) eraDefeated = true;
                else penScale = ammo.heat ? 1 : 0.55;
                engine.triggerHighExplosiveBlast(_pt.clone(), 2.4, 6, 24, 'Динамическая защита', { kind: 'era', attacker: p.attacker, noFlash: true, directVehicle: veh, fragments: 0 });
            }
        }

        const ev = M.evaluateArmor(ammo, range, plate * heatMul, cos, penScale);
        const penetrated = !eraDefeated && ev.penetrated;
        const ricochet = !eraDefeated && ev.ricochet;
        emitVehicleHit(p, veh, zoneKey, ev.effMm, penetrated, ricochet);

        if (ricochet) {
            p.rics++;
            stats.ricochets++;
            p.vel.addScaledVector(_n, -2 * p.vel.dot(_n));
            p.vel.multiplyScalar(0.5);
            p.vel.y += 0.12 * p.vel.length() * (0.5 + Math.random());
            scatter(p, 0.05);
            impactFx(p, 'metal', { vehicle: veh, ricochet: true });
            resumeAt(p, _pt.x + _n.x * 0.06, _pt.y + _n.y * 0.06, _pt.z + _n.z * 0.06);
            if (p.rics > 2) end(p);
            return;
        }

        let amount;
        let kind;
        if (ammo.heat) {
            amount = penetrated ? ammo.vehDamage : ammo.vehDamage * 0.03;
            kind = 'heat';
        } else if (ammo.explosive) {
            amount = penetrated ? ammo.vehDamage : ammo.vehDamage * 0.05;
            kind = 'he';
        } else {
            const f = Math.min(1.1, Math.max(0.2, speedFrac(p)));
            amount = penetrated ? ammo.vehDamage * f : Math.max(0.3, ammo.vehDamage * 0.04);
            kind = ammo.kind === 'frag' ? 'frag' : 'ap';
        }
        engine.damageVehicle(veh, {
            amount, pos: _pt.clone(), dir: _dir.clone(), zone: zoneKey, penetrated, ammo: ammo.id, kind, attacker: p.attacker, label: p.label
        });
        if (momentum > 15) engine.physics.applyVehicleImpulse(veh, _tmpV.copy(_dir).multiplyScalar(momentum), _pt);
        impactFx(p, 'metal', { vehicle: veh, penetrated });

        if (ammo.explosive) {
            explode(p, _pt, _n, veh);
            end(p);
            return;
        }
        if (penetrated) {
            // Does the round leave through the far wall?
            const residual = ev.penMm - ev.effMm;
            const throughMm = Math.min(armor.hull.side, armor.hull.rear);
            if (residual > throughMm * 1.5 && p.pens < 2) {
                p.pens++;
                stats.penetrations++;
                p.vel.multiplyScalar(M.residualSpeedFraction(ev.effMm, ev.penMm) * 0.8);
                scatter(p, 0.02);
                resumeAt(p, _pt.x + _dir.x * (hz + 0.5), _pt.y + _dir.y * (hz + 0.5), _pt.z + _dir.z * (hz + 0.5));
                return;
            }
        }
        end(p);
    }

    // Warhead: blast, optional direct-hit vehicle excluded from the area damage.
    function explode(p, point, normal, directVehicle) {
        const ammo = p.ammo;
        const b = ammo.blast || { radius: 3, force: 12, damage: 100 };
        let radius = b.radius;
        let force = b.force;
        let damage = b.damage;
        if (b.fromSpec && p.vehicle) {
            radius = p.vehicle.spec.blastRadius;
            force = p.vehicle.spec.blastForce;
            damage = p.vehicle.spec.damage;
        } else if (b.fromWeapon) {
            const w = p.weapon || STATS.WEAPONS.rpg7;
            radius = w.blastRadius || 11.5;
            force = w.blastForce || 68;
            damage = w.damage || ammo.damage;
        } else if (b.fromSpec) {
            radius = 9;
            force = 60;
            damage = 300;
        }
        engine.triggerHighExplosiveBlast(point.clone(), radius, force, damage, p.label, {
            kind: EXPLOSION_KIND[ammo.id] || 'he', attacker: p.attacker, faction: p.faction, directVehicle, source: p.shooter, normal
        });
    }

    function resolve(p) {
        const t = _hit.t;
        switch (_hit.kind) {
            case K.GROUND: onGround(p, t); break;
            case K.STATIC: onStatic(p, t); break;
            case K.VEHICLE: onVehicle(p, t); break;
            case K.SOLDIER: onSoldier(p, t); break;
            case K.PLAYER: onPlayer(p, t); break;
            case K.DRONE: onDrone(p, t); break;
            default: break;
        }
    }

    // ------------------------------------------------------------------ near misses

    function nearMiss(p, ax, ay, az, len) {
        if (p.ammo.kind === 'frag' || p.ammo.explosive || p.vel.lengthSq() < 150 * 150) return;
        if (!p.nearPlayer && !p.isPlayer && (!p.faction || p.faction !== engine.playerFaction)) {
            const head = engine.cameraMount.position;
            const cx = head.x - ax, cy = head.y - ay, cz = head.z - az;
            let s = cx * _dir.x + cy * _dir.y + cz * _dir.z;
            s = s < 0 ? 0 : (s > len ? len : s);
            const dx = cx - _dir.x * s, dy = cy - _dir.y * s, dz = cz - _dir.z * s;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < NEAR_MISS * NEAR_MISS && engine.isStarted && !(engine.health && engine.health.state && engine.health.state.dead)) {
                p.nearPlayer = true;
                _a.set(ax + _dir.x * s, ay + _dir.y * s, az + _dir.z * s);
                _b.copy(p.vel);
                _nearEvent.target = 'player';
                _nearEvent.dist = Math.sqrt(d2);
                engine.events.emit('bullet:nearmiss', _nearEvent);
            }
        }
        if (p.nearUnit === 'done') return;
        const units = engine.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.isDead || u === p.shooter || (p.faction && u.faction === p.faction) || !u.root) continue;
            const pos = u.root.position;
            const cx = pos.x - ax, cy = pos.y + 1.6 - ay, cz = pos.z - az;
            let s = cx * _dir.x + cy * _dir.y + cz * _dir.z;
            s = s < 0 ? 0 : (s > len ? len : s);
            const dx = cx - _dir.x * s, dy = cy - _dir.y * s, dz = cz - _dir.z * s;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < NEAR_MISS * NEAR_MISS) {
                p.nearUnit = 'done';
                _a.set(ax + _dir.x * s, ay + _dir.y * s, az + _dir.z * s);
                _b.copy(p.vel);
                _nearEvent.target = u;
                _nearEvent.dist = Math.sqrt(d2);
                engine.events.emit('bullet:nearmiss', _nearEvent);
                if (u.suppression !== undefined) u.suppression = Math.min(1, u.suppression + 0.25);
                break;
            }
        }
    }

    // ------------------------------------------------------------------ stepping

    function stepProjectile(p, dt) {
        const ammo = p.ammo;
        const n = Math.max(1, Math.ceil(dt / SUB_DT));
        const h = dt / n;
        const wind = engine.wind;
        const grav = M.G * (ammo.gravity ?? 1);
        for (let i = 0; i < n && p.active; i++) {
            p.prev.copy(p.pos);
            const vx = p.vel.x - wind.x, vy = p.vel.y - wind.y, vz = p.vel.z - wind.z;
            const drag = ammo.k * Math.sqrt(vx * vx + vy * vy + vz * vz);
            p.vel.x -= drag * vx * h;
            p.vel.y -= (drag * vy + grav) * h;
            p.vel.z -= drag * vz * h;
            if (p.rocket) {
                p.thrust += h;
                if (p.thrust > p.rocket.delay) {
                    const sp = p.vel.length();
                    if (sp < p.rocket.vMax) p.vel.multiplyScalar(Math.min(p.rocket.vMax, sp + p.rocket.accel * h) / sp);
                }
            }
            p.pos.x += p.vel.x * h;
            p.pos.y += p.vel.y * h;
            p.pos.z += p.vel.z * h;
            let len = p.prev.distanceTo(p.pos);
            if (len < 1e-6) continue;
            _dir.subVectors(p.pos, p.prev).multiplyScalar(1 / len);
            nearMiss(p, p.prev.x, p.prev.y, p.prev.z, len);
            if (trace(p, p.prev.x, p.prev.y, p.prev.z, len)) {
                const t = _hit.t;
                resolve(p);
                p.dist += t;
                if (!p.active) return;
                continue;
            }
            p.dist += len;
        }
        p.age += dt;
        if (!p.active) return;
        const sp2 = p.vel.lengthSq();
        const minV = ammo.kind === 'frag' ? 120 : (p.rocket ? 20 : 45);
        if (p.dist > p.maxRange || sp2 < minV * minV || p.pos.y < -3 || p.age > (p.rocket ? 6 : 10)) {
            if (p.rocket && p.age > 4.2) {
                _n.set(0, 1, 0);
                explode(p, p.pos, _n, null);
            }
            end(p);
        }
    }

    function updateVisuals(p) {
        if (p.tracer) {
            const speed = p.vel.length();
            if (p.dist < p.tracerAfter || speed < 1) {
                p.tracer.visible = false;
            } else {
                _dir.copy(p.vel).multiplyScalar(1 / speed);
                p.tracer.visible = true;
                p.tracer.position.copy(p.pos);
                p.tracer.quaternion.setFromUnitVectors(_a.set(0, 0, -1), _dir);
                p.tracer.scale.set(1, 1, Math.min(6, Math.max(1.2, speed * 0.006)));
            }
        } else if (p.tracerHandle && typeof p.tracerHandle.set === 'function') {
            p.tracerHandle.set(p.pos, p.vel);
        }
        if (p.rocketMesh) {
            const speed = p.vel.length();
            p.rocketMesh.position.copy(p.pos);
            if (speed > 1) {
                _dir.copy(p.vel).multiplyScalar(1 / speed);
                p.rocketMesh.quaternion.setFromUnitVectors(_a.set(0, 0, -1), _dir);
            }
            p.rocketMesh.children[1].visible = p.thrust > p.rocket.delay;
        }
    }

    // ------------------------------------------------------------------ shrapnel

    function chest(unit, out) {
        return out.set(unit.root.position.x, unit.root.position.y + 1.15, unit.root.position.z);
    }

    // Fragmentation: clustered sub-rays at nearby soldiers and the player plus omni rays, all traced by the
    // same hit code, so cover (static meshes, vehicles) blocks them. opts: { count, range, attacker, faction, source }
    function spawnFragments(center, ammo, opts = {}) {
        const preset = (engine.quality && engine.quality.preset) || 'medium';
        const scale = FRAG_SCALE[preset] ?? 1;
        let total = opts.count ?? Math.max(40, Math.round((ammo.fragments || 48) * scale));
        if (total <= 0) return 0;
        total = Math.min(total, POOL - 8);
        const range = opts.range || ammo.fragRange || 28;
        const targets = [];
        const units = engine.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.isDead || !u.root) continue;
            const d = u.root.position.distanceTo(center);
            if (d > range || d < 0.4) continue;
            targets.push({ d, x: u.root.position.x, y: u.root.position.y + 1.15, z: u.root.position.z });
        }
        const pv = engine.playerVehicleState;
        if (engine.isStarted && !(pv && pv.vehicle && pv.role === 'DRIVER')) {
            const c = engine.playerCollider;
            const d = Math.hypot(c.start.x - center.x, c.start.y - center.y, c.start.z - center.z);
            if (d <= range && d > 0.4) targets.push({ d, x: c.start.x, y: c.start.y + 0.5, z: c.start.z });
        }
        targets.sort((a, b) => a.d - b.d);
        const aimed = Math.floor(total * 0.7);
        const perTarget = targets.length ? Math.max(3, Math.min(14, Math.floor(aimed / Math.min(targets.length, 8)))) : 0;
        let spawned = 0;
        const origin = _tmpV.set(center.x, Math.max(0.25, center.y + 0.2), center.z);
        const ox = origin.x, oy = origin.y, oz = origin.z;
        const baseDir = new THREE.Vector3();
        for (let ti = 0; ti < Math.min(8, targets.length) && spawned < aimed; ti++) {
            const tg = targets[ti];
            baseDir.set(tg.x - ox, tg.y - oy, tg.z - oz).normalize();
            const falloff = Math.max(0.2, 1 - tg.d / range);
            for (let k = 0; k < perTarget && spawned < aimed; k++) {
                shootFragment(ox, oy, oz, baseDir, 0.13, falloff, ammo, opts);
                spawned++;
            }
        }
        const omni = total - spawned;
        const golden = Math.PI * (3 - Math.sqrt(5));
        const rot = Math.random() * Math.PI * 2;
        for (let i = 0; i < omni; i++) {
            const y = 1 - (i + 0.5) / omni * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            baseDir.set(Math.cos(i * golden + rot) * r, y * 0.8, Math.sin(i * golden + rot) * r).normalize();
            shootFragment(ox, oy, oz, baseDir, 0, 0.5, ammo, opts);
        }
        stats.fragments += total;
        return total;
    }

    function shootFragment(x, y, z, dir, spread, falloff, ammo, opts) {
        const frag = AMMO.FRAG;
        const p = acquire(frag);
        p.shooter = opts.source || null;
        p.vehicle = null;
        p.faction = null;
        p.isPlayer = false;
        p.weapon = null;
        p.attacker = opts.attacker || 'ВЫ';
        p.label = ammo.name;
        p.baseDamage = frag.damage;
        p.fragFalloff = falloff;
        p.maxRange = opts.range || ammo.fragRange || 28;
        p.skipPlayer = false;
        jitter(_dir, dir, spread);
        p.pos.set(x, y, z);
        p.prev.set(x, y, z);
        p.vel.copy(_dir).multiplyScalar(frag.v0 * (0.8 + Math.random() * 0.2));
    }

    // ------------------------------------------------------------------ queries

    // Share of a blast that gets from A to B past cover: 1 clear, 0.5 through a penetrable prop, 0.12 behind solid
    // cover. Uses its own scratch, so it may be called from inside a hit resolution.
    const _bl0 = new THREE.Vector3();
    const _bl1 = new THREE.Vector3();
    function transmission(ax, ay, az, bx, by, bz) {
        let result = 1;
        const list = engine.staticShootableMeshes;
        for (let i = 0; i < list.length; i++) {
            const mesh = list[i];
            if (!mesh.parent || (mesh.userData && (mesh.userData.isVehicleHitbox || mesh.userData.noBullets))) continue;
            const e = meshEntry(mesh);
            if (e.kind !== 1) continue;
            _bl0.set(ax, ay, az).applyMatrix4(e.inv);
            _bl1.set(bx, by, bz).applyMatrix4(e.inv);
            if (M.segmentBox(_bl0.x, _bl0.y, _bl0.z, _bl1.x, _bl1.y, _bl1.z, e.hx, e.hy, e.hz, _boxOut) !== 1) continue;
            const soft = mesh.userData && mesh.userData.penetrable;
            result = Math.min(result, soft ? 0.5 : 0.12);
            if (result <= 0.12) return result;
        }
        const vehicles = engine.physics.vehicles;
        for (let i = 0; i < vehicles.length; i++) {
            const proxy = vehicles[i].hitProxyMesh;
            if (!proxy) continue;
            const e = meshEntry(proxy);
            _bl0.set(ax, ay, az).applyMatrix4(e.inv);
            _bl1.set(bx, by, bz).applyMatrix4(e.inv);
            const par = proxy.geometry.parameters;
            if (M.segmentBox(_bl0.x, _bl0.y, _bl0.z, _bl1.x, _bl1.y, _bl1.z, par.width / 2, par.height / 2, par.depth / 2, _boxOut) === 1) return 0.12;
        }
        return result;
    }

    // Instant probe: first thing along the ray. The result object is reused.
    const probe = makeProjectile(-1);
    probe.ammo = AMMO['7.62x54R'];
    function raycast(origin, dir, maxDist = 200, opts = {}) {
        probe.skipPlayer = true;
        probe.isPlayer = true;
        probe.shooter = opts.shooter || null;
        probe.vehicle = opts.vehicle || null;
        probe.faction = null;
        stamp++;
        _dir.copy(dir).normalize();
        _rayResult.hit = false;
        _rayResult.kind = '';
        _rayResult.object = _rayResult.unit = _rayResult.vehicle = null;
        _rayResult.zone = _rayResult.part = '';
        _rayResult.distance = maxDist;
        _rayResult.point.copy(origin).addScaledVector(_dir, maxDist);
        if (trace(probe, origin.x, origin.y, origin.z, maxDist)) {
            _rayResult.hit = true;
            _rayResult.kind = ['', 'ground', 'static', 'vehicle', 'soldier', 'player', 'drone'][_hit.kind];
            _rayResult.distance = _hit.t;
            _rayResult.point.copy(origin).addScaledVector(_dir, _hit.t);
            _rayResult.normal.set(_hit.nx, _hit.ny, _hit.nz);
            _rayResult.object = _hit.mesh;
            _rayResult.unit = _hit.unit;
            _rayResult.vehicle = _hit.vehicle;
            _rayResult.zone = _hit.zone;
            _rayResult.part = _hit.part;
        }
        return _rayResult;
    }

    // AI rifle shot: aims at `targetPos` (or at the player when it is the closer threat), real round, real spread.
    const _aim = new THREE.Vector3();
    const _aimDir = new THREE.Vector3();
    const _aimMuzzle = new THREE.Vector3();
    function aiFire(unit, muzzle, targetPos, wStat, enemyUnit) {
        if (!unit || !targetPos) return false;
        _aim.copy(targetPos);
        let spread = 0.006 + 0.00012 * muzzle.distanceTo(targetPos) + (unit.suppression || 0) * 0.02;
        if (unit.stance === 'crouch') spread *= 0.8;
        if (unit.velocity && unit.velocity.lengthSq() > 1) spread *= 1.4;
        const pv = engine.playerVehicleState;
        if (engine.isStarted && unit.faction !== engine.playerFaction && !(pv && pv.vehicle && pv.role === 'DRIVER')
            && !(engine.health && engine.health.state && engine.health.state.dead)) {
            const c = engine.playerCollider;
            const pd = Math.hypot(c.start.x - muzzle.x, c.start.z - muzzle.z);
            const ed = enemyUnit ? Math.hypot(enemyUnit.root.position.x - muzzle.x, enemyUnit.root.position.z - muzzle.z) : Infinity;
            if (pd < 85 && (pd < ed || Math.random() < 0.3)) {
                _aim.set(c.start.x, c.start.y + 0.55, c.start.z);
                spread = 0.006 + 0.00014 * pd;
            }
        }
        // Rounds leave the real muzzle of the carried rifle when the animator provides one.
        let origin = muzzle;
        const an = unit.animator;
        if (an && !an.stopped && typeof an.muzzleWorld === 'function') {
            an.setAim(_aim);
            origin = an.muzzleWorld(_aimMuzzle);
            an.trigger('shoot');
        }
        _aimDir.subVectors(_aim, origin);
        if (_aimDir.lengthSq() < 0.01) return false;
        _aimDir.normalize();
        fire({
            origin, dir: _aimDir, ammo: wStat && wStat.id ? WEAPON_AMMO[wStat.id] || wStat.id : undefined,
            weapon: wStat, shooter: unit, faction: unit.faction, spread, attacker: unit.name
        });
        return true;
    }

    // ------------------------------------------------------------------ module

    const mod = {
        name: 'ballistics',
        pool,
        stats,
        fire,
        fireRocket,
        fireVehicleWeapon,
        raycast,
        aiFire,
        spawnFragments,
        transmission,
        resolveAmmo,
        activeCount() {
            let n = 0;
            for (let i = 0; i < pool.items.length; i++) if (pool.items[i].active) n++;
            return n;
        },
        // Advances every live round by dt (also called directly by tests).
        update(dt) {
            legacyFx = 0;
            let any = false;
            for (let i = 0; i < pool.items.length; i++) if (pool.items[i].active) { any = true; break; }
            if (!any) return;
            stamp++;
            for (let i = 0; i < pool.items.length; i++) {
                const p = pool.items[i];
                if (!p.active) continue;
                stepProjectile(p, dt);
                if (p.active) updateVisuals(p);
            }
        },
        // Removes every live round (scenarios, respawn).
        clear() {
            for (let i = 0; i < pool.items.length; i++) if (pool.items[i].active) end(pool.items[i]);
        }
    };
    return mod;
}
