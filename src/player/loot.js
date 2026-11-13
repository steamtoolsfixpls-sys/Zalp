import * as THREE from 'three';
import { STATS } from '../../stats.js';

// "loot" feature module: searching fallen soldiers (weapon ammo, rockets / ATGM, grenades, medicine), ammo crates
// (`userData.ammoCrate`) and BTR-80 / BMP-2 resupply. [F] is bound with a higher priority than vehicle entry and
// is consumed only when a lootable is within reach and nearer than any vehicle.
const REACH = 2.2;
const CRATE_REACH = 2.6;
const VEHICLE_REACH = 3.2;
const SCAN_INTERVAL = 0.25;
const CRATE_SCAN_INTERVAL = 3;
const RESUPPLY_KEYS = new Set(['btr80_ru', 'bmp2_ua']);
const RESUPPLY_COOLDOWN = 30;
const AMMO_GROUP = { ak12: '5.45', ak74m: '5.45', m4a1: '5.56' };
const WEAPON_NAME = { ak12: 'АК-12', ak74m: 'АК-74М', m4a1: 'M4A1' };

const CSS = '#loot-prompt{position:absolute;left:50%;bottom:192px;transform:translateX(-50%);background:rgba(12,17,22,.9);'
    + 'border:1px solid #8fe88f;border-left:5px solid #8fe88f;padding:8px 18px;font-size:13px;color:#f0f4f8;display:none;white-space:nowrap}';

export function createLoot(engine) {
    const bodies = new Map();
    const crates = [];
    const cooldowns = new WeakMap();
    let cratesTimer = 0;
    let scanTimer = 0;
    let promptEl = null;
    let promptText = '';
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const nearest = { kind: '', ref: null, dist: Infinity, text: '' };

    function describeBody(b) {
        const parts = [];
        if (b.rounds) parts.push(`${WEAPON_NAME[b.weaponKey] || b.weaponKey} ${b.rounds} пат.`);
        if (b.rockets) parts.push(`РПГ ×${b.rockets}`);
        if (b.atgm) parts.push(`ПТУР ×${b.atgm}`);
        if (b.grenades) parts.push(`граната ×${b.grenades}`);
        if (b.bandage || b.tourniquet) parts.push('медикаменты');
        return parts.join(', ') || 'ничего';
    }

    function register(unit) {
        if (!unit || bodies.has(unit)) return;
        const mags = Math.random() < 0.5 ? 1 : 2;
        const at = unit.role === 'at';
        bodies.set(unit, {
            unit,
            weaponKey: unit.weaponKey,
            rounds: mags * 30 - Math.floor(Math.random() * 10),
            rockets: at ? 2 : 0,
            atgm: at && unit.faction === 'UA' ? 1 : 0,
            grenades: Math.random() < 0.6 ? 1 : 0,
            bandage: Math.random() < 0.35 ? 1 : 0,
            tourniquet: Math.random() < 0.2 ? 1 : 0
        });
    }

    function playerPos() {
        return engine.playerCollider.start;
    }

    function nearestBody() {
        const p = playerPos();
        let best = null;
        let bestD = REACH;
        for (const b of bodies.values()) {
            const u = b.unit;
            if (!u.isDead || !u.root) continue;
            const r = u.root.position;
            if (Math.abs(r.y - p.y) > 2.5) continue;
            const d = Math.hypot(r.x - p.x, r.z - p.z);
            if (d < bestD) {
                bestD = d;
                best = b;
            }
        }
        return best ? { body: best, dist: bestD } : null;
    }

    function nearestVehicleDist() {
        const p = playerPos();
        let best = Infinity;
        for (const v of engine.physics.vehicles) {
            if (v.destroyed) continue;
            best = Math.min(best, v.chassisPos.distanceTo(p));
        }
        return best;
    }

    // Distance from the player to the hull box of a vehicle (0 when standing on it).
    function boxDistance(veh) {
        _p.copy(playerPos()).sub(veh.chassisPos);
        _q.copy(veh.chassisQuat).invert();
        _p.applyQuaternion(_q);
        const hx = veh.spec.halfExtents[0], hz = veh.spec.halfExtents[2];
        const dx = Math.max(0, Math.abs(_p.x) - hx);
        const dz = Math.max(0, Math.abs(_p.z) - hz);
        return Math.hypot(dx, dz);
    }

    function nearestResupplyVehicle() {
        let best = null;
        let bestD = VEHICLE_REACH;
        for (const v of engine.physics.vehicles) {
            if (v.destroyed || !RESUPPLY_KEYS.has(v.spec.key)) continue;
            const d = boxDistance(v);
            if (d < bestD) {
                bestD = d;
                best = v;
            }
        }
        return best ? { vehicle: best, dist: bestD } : null;
    }

    function rescanCrates() {
        crates.length = 0;
        engine.scene.traverse((o) => {
            if (o.userData && o.userData.ammoCrate && o.visible !== false) crates.push(o);
        });
    }

    function nearestCrate() {
        const p = playerPos();
        let best = null;
        let bestD = CRATE_REACH;
        for (let i = 0; i < crates.length; i++) {
            const c = crates[i];
            if (!c.parent) continue;
            c.getWorldPosition(_p);
            const d = Math.hypot(_p.x - p.x, _p.z - p.z);
            if (d < bestD && Math.abs(_p.y - p.y) < 3) {
                bestD = d;
                best = c;
            }
        }
        return best ? { crate: best, dist: bestD } : null;
    }

    // ------------------------------------------------------------------ effects of looting

    function topUpWeapon(key, rounds) {
        const st = engine.weaponStates[key];
        if (!st) return 0;
        const cap = STATS.WEAPONS[key].reserveAmmo * 2;
        const before = st.reserve;
        st.reserve = Math.min(cap, st.reserve + rounds);
        return st.reserve - before;
    }

    function lootBody(b) {
        const lines = [];
        const group = AMMO_GROUP[b.weaponKey];
        let gained = 0;
        if (group && b.rounds) {
            for (const key of engine.loadoutKeys) {
                if (AMMO_GROUP[key] === group) gained = Math.max(gained, topUpWeapon(key, b.rounds));
            }
            lines.push(`${WEAPON_NAME[b.weaponKey] || b.weaponKey} +${b.rounds} пат.`);
        }
        if (b.rockets) {
            topUpWeapon('rpg7', b.rockets);
            lines.push(`РПГ +${b.rockets}`);
        }
        const inv = engine.ordnance && engine.ordnance.inventory;
        if (b.atgm && inv) {
            inv.atgm += b.atgm;
            lines.push(`ПТУР +${b.atgm}`);
        }
        if (b.grenades && inv) {
            inv.frag = Math.min(6, inv.frag + b.grenades);
            lines.push(`граната +${b.grenades}`);
        }
        const h = engine.health;
        if (h && typeof h.addSupplies === 'function') {
            if (b.bandage && h.addSupplies('bandage', b.bandage)) lines.push('перевязка +1');
            if (b.tourniquet && h.addSupplies('tourniquet', b.tourniquet)) lines.push('жгут +1');
        }
        bodies.delete(b.unit);
        engine.updateWeaponHUD();
        engine.notify(`ОБЫСКАНО: ${b.unit.name} — ${lines.join(', ') || 'пусто'}`, { kind: 'info' });
        return lines;
    }

    function needsResupply() {
        for (const key of engine.loadoutKeys) {
            const st = engine.weaponStates[key];
            if (st && st.reserve < STATS.WEAPONS[key].reserveAmmo) return true;
        }
        const s = engine.health && engine.health.state && engine.health.state.supplies;
        if (s && (s.bandage < 2 || s.tourniquet < 2 || s.painkiller < 2)) return true;
        const inv = engine.ordnance && engine.ordnance.inventory;
        return Boolean(inv && (inv.frag < 3 || inv.smoke < 2 || inv.mine < 2));
    }

    function resupply(label) {
        for (const key of engine.loadoutKeys) {
            const st = engine.weaponStates[key];
            if (st) st.reserve = Math.max(st.reserve, STATS.WEAPONS[key].reserveAmmo);
        }
        const h = engine.health;
        if (h && h.state) {
            for (const k of ['bandage', 'tourniquet', 'painkiller']) h.state.supplies[k] = Math.max(h.state.supplies[k], 2);
        }
        const inv = engine.ordnance && engine.ordnance.inventory;
        if (inv) {
            inv.frag = Math.max(inv.frag, 3);
            inv.smoke = Math.max(inv.smoke, 2);
            inv.mine = Math.max(inv.mine, 2);
        }
        engine.updateWeaponHUD();
        engine.notify(`ПОПОЛНЕНИЕ: ${label} — БК, ГРАНАТЫ И МЕДИЦИНА ПОЛНЫЕ`, { kind: 'info' });
    }

    function cooled(obj) {
        return (cooldowns.get(obj) || 0) <= engine.time;
    }

    // ------------------------------------------------------------------ key + prompt

    function onKeyF(e) {
        if (e && e.repeat) return false;
        if (!engine.isStarted || engine.isPaused) return false;
        if (engine.health && engine.health.state && engine.health.state.dead) return false;
        const pv = engine.playerVehicleState;
        if (pv && pv.vehicle) return false;
        const vehDist = nearestVehicleDist();
        const body = nearestBody();
        if (body && body.dist < vehDist) {
            lootBody(body.body);
            return true;
        }
        rescanCratesIfNeeded();
        const crate = nearestCrate();
        if (crate && crate.dist < vehDist && cooled(crate.crate)) {
            cooldowns.set(crate.crate, engine.time + 20);
            resupply('ЯЩИК С БК');
            return true;
        }
        const rv = nearestResupplyVehicle();
        if (rv && cooled(rv.vehicle) && needsResupply()) {
            cooldowns.set(rv.vehicle, engine.time + RESUPPLY_COOLDOWN);
            resupply(rv.vehicle.name);
            return true;
        }
        return false;
    }

    function rescanCratesIfNeeded() {
        if (cratesTimer <= 0) {
            rescanCrates();
            cratesTimer = CRATE_SCAN_INTERVAL;
        }
    }

    function scan() {
        nearest.kind = '';
        nearest.ref = null;
        nearest.text = '';
        const pv = engine.playerVehicleState;
        if (!engine.isStarted || (engine.health && engine.health.state && engine.health.state.dead) || (pv && pv.vehicle) || (engine.fpvMode && engine.fpvMode.active)) return;
        const vehDist = nearestVehicleDist();
        const body = nearestBody();
        if (body && body.dist < vehDist) {
            nearest.kind = 'body';
            nearest.ref = body.body;
            nearest.text = `[F] ОБЫСКАТЬ ${body.body.unit.name} — ${describeBody(body.body)}`;
            return;
        }
        const crate = nearestCrate();
        if (crate && crate.dist < vehDist && cooled(crate.crate)) {
            nearest.kind = 'crate';
            nearest.ref = crate.crate;
            nearest.text = '[F] ВЗЯТЬ ИЗ ЯЩИКА: БК, ГРАНАТЫ, МЕДИЦИНА';
            return;
        }
        const rv = nearestResupplyVehicle();
        if (rv && cooled(rv.vehicle) && needsResupply()) {
            nearest.kind = 'vehicle';
            nearest.ref = rv.vehicle;
            nearest.text = `[F] ПОПОЛНИТЬ БК И МЕДИЦИНУ — ${rv.vehicle.name}`;
        }
    }

    function showPrompt(text) {
        if (!promptEl || text === promptText) return;
        promptText = text;
        promptEl.textContent = text;
        promptEl.style.display = text ? 'block' : 'none';
    }

    function autoResupplySeated() {
        const pv = engine.playerVehicleState;
        const v = pv && pv.vehicle;
        if (!v || pv.role !== 'DESANT' || !RESUPPLY_KEYS.has(v.spec.key) || !cooled(v) || !needsResupply()) return;
        cooldowns.set(v, engine.time + RESUPPLY_COOLDOWN);
        resupply(v.name);
    }

    const mod = {
        name: 'loot',
        bodies,
        nearest,
        lootBody,
        resupply,
        install() {
            const layer = engine.hudLayer;
            if (layer) {
                const style = document.createElement('style');
                style.textContent = CSS;
                document.head.appendChild(style);
                promptEl = document.createElement('div');
                promptEl.id = 'loot-prompt';
                layer.appendChild(promptEl);
            }
            engine.events.on('unit:killed', ({ unit }) => register(unit));
            engine.events.on('unit:respawned', ({ unit }) => bodies.delete(unit));
            engine.input.bind('KeyF', onKeyF, { priority: 100 });
        },
        update(dt) {
            cratesTimer -= dt;
            scanTimer -= dt;
            if (scanTimer <= 0) {
                scanTimer = SCAN_INTERVAL;
                rescanCratesIfNeeded();
                for (const [unit] of bodies) if (!unit.isDead) bodies.delete(unit);
                scan();
                showPrompt(nearest.text);
                autoResupplySeated();
            }
        }
    };
    return mod;
}
