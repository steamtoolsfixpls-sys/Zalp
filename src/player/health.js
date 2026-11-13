import * as THREE from 'three';
import { STATS } from '../../stats.js';

// "health" feature module: player damage, bleeding, pain, limping, medicine, death and respawn, HUD and
// screen effects. Single entry: applyDamage({ amount, zone, pos, dir, attacker, source }); state: `health.state`.
const BLEED = { light: 0.35, heavy: 1.6, torsoHeavy: 2.1 };           // blood % per second
const ACTION = {
    bandage: { dur: 3.0, label: 'ПЕРЕВЯЗКА' },
    tourniquet: { dur: 2.5, label: 'НАЛОЖЕНИЕ ЖГУТА' },
    painkiller: { dur: 1.4, label: 'ПРИЁМ ОБЕЗБОЛИВАЮЩЕГО' }
};
const PAINKILLER_SECONDS = 60;
const RESPAWN_SECONDS = 5;
const PART_LABEL = { head: 'ГОЛОВА', torso: 'ТОРС', armL: 'ЛЕВАЯ РУКА', armR: 'ПРАВАЯ РУКА', legL: 'ЛЕВАЯ НОГА', legR: 'ПРАВАЯ НОГА' };
const PART_SHORT = { head: 'ГОЛ', torso: 'ТОР', armL: 'РУК Л', armR: 'РУК П', legL: 'НОГ Л', legR: 'НОГ П' };
const PARTS = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
const START_SUPPLIES = { bandage: 2, tourniquet: 2, painkiller: 2 };
const SUPPLY_CAP = 4;

const CSS = `
#hp-fx{position:absolute;inset:0;pointer-events:none;z-index:2}
#hp-fx .hp-vig{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) var(--r,100%),rgba(28,0,0,var(--a,.9)) 100%)}
#hp-fx .hp-pulse{position:absolute;inset:0;opacity:0;box-shadow:inset 0 0 160px 50px rgba(190,0,0,.95)}
#hp-fx .hp-dir{position:absolute;left:50%;top:50%;width:0;height:0;opacity:0}
#hp-fx .hp-wedge{position:absolute;left:-110px;top:calc(-50vh + 4px);width:220px;height:84px;background:radial-gradient(ellipse at 50% 0%,rgba(255,40,30,.95),rgba(255,40,30,0) 70%)}
#hp-fx .hp-faint{position:absolute;inset:0;opacity:0;background:#000}
#hp-death{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(40,0,0,.82);color:#f3d6d6;text-align:center;z-index:3}
#hp-death b{font-size:46px;letter-spacing:6px;color:#ff4a4a}
#hp-death span{margin-top:14px;font-size:16px;letter-spacing:2px}
#health-panel{position:absolute;right:24px;bottom:134px;width:310px;background:rgba(12,16,20,.84);border-right:4px solid #cf4a4a;padding:9px 14px 10px;font-size:11px;color:#c6d2db;text-align:right;line-height:1.5}
#health-panel .hp-row{display:flex;align-items:center;gap:8px;margin:2px 0}
#health-panel .hp-row>em{font-style:normal;width:46px;text-align:left;color:#9ab0c2}
#health-panel .hp-bar{flex:1;height:8px;background:#222b32;position:relative}
#health-panel .hp-bar>i{position:absolute;left:0;top:0;bottom:0;width:100%}
#health-panel .hp-hp>i{background:#7fd37f}
#health-panel .hp-blood>i{background:#d83a3a}
#health-panel .hp-body{display:flex;gap:4px;margin:5px 0 4px;justify-content:flex-end}
#health-panel .hp-part{min-width:34px;padding:1px 2px;text-align:center;font-size:9px;background:#222b32;color:#6f8394;border:1px solid #2e3b46}
#health-panel .hp-part.light{background:#5c4d17;color:#ffe48a;border-color:#a98a21}
#health-panel .hp-part.heavy{background:#6e1c1c;color:#ffb1b1;border-color:#d83a3a}
#health-panel .hp-part.tourniquet{background:#1c3a5a;color:#a9d3ff;border-color:#4d8fd1}
#health-panel .hp-part.wounded{background:#3f3320;color:#ffcf8a;border-color:#a9742a}
#health-panel .hp-status{min-height:15px;color:#ffb347;font-size:11px}
#health-panel .hp-supply{color:#e2b955;margin-top:2px}
#health-panel .hp-ord{color:#8fa6b8}
#health-panel .hp-action{display:none;margin-top:5px;text-align:left;color:#f3e3a6}
#health-panel .hp-action .hp-bar>i{background:#e2b955}
`;

export function createHealth(engine) {
    const state = {
        hp: STATS.PLAYER.maxHp,
        maxHp: STATS.PLAYER.maxHp,
        blood: 100,
        pain: 0,
        painkiller: 0,
        dead: false,
        consciousness: 'ok',
        wounds: { head: 0, torso: 0, armL: 0, armR: 0, legL: 0, legR: 0 },
        limbs: { armL: 'ok', armR: 'ok', legL: 'ok', legR: 'ok' },
        supplies: { ...START_SUPPLIES },
        action: null,
        deathTimer: 0,
        lastHitAt: -99
    };
    const removers = [];
    let syncedHp = state.hp;
    let root = null;
    let ui = null;
    let panelTimer = 0;
    let time = 0;
    let pulse = 0;
    let dirAngle = 0;
    let dirAlpha = 0;
    let lastFilter = -1;
    let lastTunnel = -1;
    let lastVig = -1;
    const _right = new THREE.Vector3();
    const _fwd = new THREE.Vector3();
    const _sway = new THREE.Quaternion();
    const _eul = new THREE.Euler();

    const painEff = () => Math.min(1, state.pain) * (state.painkiller > 0 ? 0.2 : 1);
    const bloodFrac = () => Math.max(0, state.blood) / 100;
    const legImpaired = () => state.limbs.legL !== 'ok' || state.limbs.legR !== 'ok';
    const armImpaired = () => state.limbs.armL !== 'ok' || state.limbs.armR !== 'ok';

    // ------------------------------------------------------------------ modifiers

    function playerSpeed() {
        if (state.dead) return 0;
        let s = 1;
        for (const k of ['legL', 'legR']) {
            if (state.limbs[k] === 'wounded') s *= 0.68;
            else if (state.limbs[k] === 'tourniquet') s *= 0.8;
        }
        if (legImpaired() && state.painkiller > 0) s = Math.min(1, s + 0.1);
        if (bloodFrac() < 0.5) s *= 0.85;
        if (state.consciousness === 'unconscious') s *= 0.25;
        return Math.max(0.2, s);
    }

    function canSprint() {
        return !state.dead && !legImpaired() && bloodFrac() > 0.35 && state.consciousness === 'ok' ? 1 : 0;
    }

    function canFire() {
        return !state.dead && !state.action && state.consciousness !== 'unconscious' ? 1 : 0;
    }

    function aimSway() {
        return 1 + painEff() * 2.2 + (armImpaired() ? 0.8 : 0) + (1 - bloodFrac()) * 1.2;
    }

    function recoil() {
        return 1 + (armImpaired() ? 0.5 : 0) + painEff() * 0.4;
    }

    // ------------------------------------------------------------------ damage

    function partFor(zone, dir) {
        if (zone === 'HEAD') return 'head';
        if (zone === 'TORSO') return 'torso';
        let side = Math.random() < 0.5 ? 'L' : 'R';
        if (dir) {
            // The shot travels along `dir`: the shooter stands on the opposite side.
            _right.set(Math.cos(engine.yaw), 0, -Math.sin(engine.yaw));
            side = -(dir.x * _right.x + dir.z * _right.z) > 0 ? 'R' : 'L';
        }
        return (zone === 'ARM' ? 'arm' : 'leg') + side;
    }

    function addWound(part, level) {
        const cur = state.wounds[part];
        if (level > cur) state.wounds[part] = level;
        else if (level === cur && level === 1 && Math.random() < 0.35) state.wounds[part] = 2;
        if (part.startsWith('arm') || part.startsWith('leg')) {
            if (state.limbs[part] === 'ok') state.limbs[part] = 'wounded';
        }
    }

    function applyDamage(hit) {
        if (state.dead || !hit) return;
        const amount = Math.max(0, hit.amount || 0);
        if (amount <= 0) return;
        const zone = hit.zone || 'TORSO';
        state.hp = Math.max(0, state.hp - amount);
        state.lastHitAt = time;
        state.pain = Math.min(1, state.pain + Math.min(1, amount / 45));
        if (amount >= 6) {
            const part = partFor(zone, hit.dir);
            if (part === 'head') {
                if (amount >= 12) addWound(part, 1);
            } else if (part === 'torso') {
                if (amount >= 35) addWound(part, 2);
                else if (amount >= 10) addWound(part, 1);
            } else if (amount >= 22) {
                addWound(part, 2);
            } else if (amount >= 7) {
                addWound(part, 1);
            }
        }
        engine.playerHp = state.hp;
        syncedHp = state.hp;
        pulse = Math.min(1, 0.35 + amount / 40);
        if (hit.dir && !hit.blast) {
            _fwd.set(-Math.sin(engine.yaw), 0, -Math.cos(engine.yaw));
            _right.set(Math.cos(engine.yaw), 0, -Math.sin(engine.yaw));
            // Direction towards the attacker, in view space.
            const tx = -hit.dir.x, tz = -hit.dir.z;
            dirAngle = Math.atan2(tx * _right.x + tz * _right.z, tx * _fwd.x + tz * _fwd.z);
            dirAlpha = 1;
        } else if (hit.pos && hit.blast) {
            const tx = hit.pos.x - engine.playerCollider.start.x, tz = hit.pos.z - engine.playerCollider.start.z;
            _fwd.set(-Math.sin(engine.yaw), 0, -Math.cos(engine.yaw));
            _right.set(Math.cos(engine.yaw), 0, -Math.sin(engine.yaw));
            dirAngle = Math.atan2(tx * _right.x + tz * _right.z, tx * _fwd.x + tz * _fwd.z);
            dirAlpha = 1;
        }
        engine.events.emit('player:hit', { amount, zone, pos: hit.pos || null, dir: hit.dir || null, attacker: hit.attacker || '' });
        if (state.hp <= 0) die(hit.attacker);
        panelTimer = 0;
    }

    function die(attacker) {
        if (state.dead) return;
        state.dead = true;
        state.deathTimer = RESPAWN_SECONDS;
        state.action = null;
        state.hp = 0;
        state.consciousness = 'dead';
        engine.playerHp = 0;
        syncedHp = 0;
        engine.isFiring = false;
        engine.isAiming = false;
        engine.events.emit('player:died', {});
        if (ui) ui.death.style.display = 'flex';
        panelTimer = 0;
    }

    function resetState() {
        state.hp = state.maxHp;
        state.blood = 100;
        state.pain = 0;
        state.painkiller = 0;
        state.dead = false;
        state.consciousness = 'ok';
        for (const k of PARTS) state.wounds[k] = 0;
        for (const k of Object.keys(state.limbs)) state.limbs[k] = 'ok';
        Object.assign(state.supplies, START_SUPPLIES);
        state.action = null;
        state.deathTimer = 0;
        engine.playerHp = state.hp;
        syncedHp = state.hp;
        pulse = 0;
        dirAlpha = 0;
    }

    function respawn() {
        const pv = engine.playerVehicleState;
        if (pv && pv.vehicle && typeof engine.exitCurrentVehicle === 'function') engine.exitCurrentVehicle();
        if (engine.fpvMode && engine.fpvMode.active && typeof engine.exitPlayerFpvDrone === 'function') engine.exitPlayerFpvDrone();
        const c = engine.playerCollider;
        c.start.set(-4.0, 0.36, 20.5);
        c.end.set(-4.0, 1.44, 20.5);
        engine.playerVelocity.set(0, 0, 0);
        engine.yaw = 0;
        engine.pitch = -0.05;
        engine.isCrouching = false;
        resetState();
        if (ui) ui.death.style.display = 'none';
        engine.events.emit('player:respawned', {});
        engine.notify('ВОЗРОЖДЕНИЕ НА ИСХОДНОЙ ПОЗИЦИИ', { kind: 'info' });
        panelTimer = 0;
    }

    // ------------------------------------------------------------------ medicine

    function bleedingSources() {
        let light = 0;
        let heavy = 0;
        for (const k of PARTS) {
            if (state.wounds[k] === 1) light++;
            else if (state.wounds[k] === 2) heavy++;
        }
        return { light, heavy };
    }

    function bleedRate() {
        let r = 0;
        for (const k of PARTS) {
            const w = state.wounds[k];
            if (w === 1) r += BLEED.light;
            else if (w === 2) r += k === 'torso' ? BLEED.torsoHeavy : BLEED.heavy;
        }
        return r;
    }

    function startAction(kind) {
        if (state.dead || state.action) return false;
        const pv = engine.playerVehicleState;
        if ((pv && pv.vehicle && pv.role === 'DRIVER') || (engine.fpvMode && engine.fpvMode.active)) return false;
        const spec = ACTION[kind];
        if (state.supplies[kind] <= 0) {
            engine.notify(`НЕТ СРЕДСТВ: ${spec.label}`, { kind: 'warn' });
            return false;
        }
        const src = bleedingSources();
        if (kind === 'bandage' && src.light === 0 && state.wounds.torso !== 2) {
            engine.notify('ПЕРЕВЯЗКА НЕ ТРЕБУЕТСЯ: НЕТ СЛАБОГО КРОВОТЕЧЕНИЯ', { kind: 'info' });
            return false;
        }
        if (kind === 'tourniquet' && !heavyLimb()) {
            engine.notify('ЖГУТ НЕ ТРЕБУЕТСЯ: НЕТ СИЛЬНОГО КРОВОТЕЧЕНИЯ КОНЕЧНОСТИ', { kind: 'info' });
            return false;
        }
        state.action = { kind, t: 0, dur: spec.dur, label: spec.label };
        panelTimer = 0;
        return true;
    }

    function heavyLimb() {
        for (const k of ['legL', 'legR', 'armL', 'armR']) if (state.wounds[k] === 2) return k;
        return null;
    }

    function finishAction() {
        const a = state.action;
        state.action = null;
        state.supplies[a.kind]--;
        if (a.kind === 'bandage') {
            for (const k of PARTS) if (state.wounds[k] === 1) state.wounds[k] = 0;
            if (state.wounds.torso === 2) state.wounds.torso = 1;
            engine.notify('ПЕРЕВЯЗКА ЗАВЕРШЕНА: КРОВОТЕЧЕНИЕ ОСТАНОВЛЕНО', { kind: 'info' });
        } else if (a.kind === 'tourniquet') {
            const k = heavyLimb();
            if (k) {
                state.wounds[k] = 0;
                state.limbs[k] = 'tourniquet';
            }
            engine.notify('ЖГУТ НАЛОЖЕН: КОНЕЧНОСТЬ ОГРАНИЧЕННО ФУНКЦИОНАЛЬНА', { kind: 'info' });
        } else {
            state.painkiller = PAINKILLER_SECONDS;
            engine.notify('ОБЕЗБОЛИВАЮЩЕЕ: БОЛЬ ПОДАВЛЕНА НА 60 С', { kind: 'info' });
        }
        panelTimer = 0;
    }

    function interruptAction(reason) {
        if (!state.action) return;
        state.action = null;
        engine.notify(`${reason}: ДЕЙСТВИЕ ПРЕРВАНО`, { kind: 'warn' });
        panelTimer = 0;
    }

    function addSupplies(kind, n) {
        if (!(kind in state.supplies)) return 0;
        const before = state.supplies[kind];
        state.supplies[kind] = Math.min(SUPPLY_CAP, before + n);
        panelTimer = 0;
        return state.supplies[kind] - before;
    }

    // ------------------------------------------------------------------ HUD

    function buildUi() {
        const layer = engine.hudLayer;
        if (!layer) return;
        const style = document.createElement('style');
        style.id = 'health-style';
        style.textContent = CSS;
        document.head.appendChild(style);
        root = document.createElement('div');
        root.id = 'hp-fx';
        root.innerHTML = '<div class="hp-vig"></div><div class="hp-pulse"></div><div class="hp-dir"><div class="hp-wedge"></div></div><div class="hp-faint"></div>';
        layer.insertBefore(root, layer.firstChild);
        const death = document.createElement('div');
        death.id = 'hp-death';
        death.innerHTML = '<b>ВЫ ПОГИБЛИ</b><span id="hp-death-sub"></span>';
        layer.appendChild(death);
        const panel = document.createElement('div');
        panel.id = 'health-panel';
        panel.innerHTML = '<div class="hp-row hp-hp"><em>ЗДОР.</em><div class="hp-bar"><i></i></div><b class="hp-hpv"></b></div>'
            + '<div class="hp-row hp-blood"><em>КРОВЬ</em><div class="hp-bar"><i></i></div><b class="hp-bloodv"></b></div>'
            + '<div class="hp-body"></div><div class="hp-status"></div>'
            + '<div class="hp-supply"></div><div class="hp-ord"></div>'
            + '<div class="hp-action"><span></span><div class="hp-bar"><i></i></div></div>';
        layer.appendChild(panel);
        const body = panel.querySelector('.hp-body');
        const partEls = {};
        for (const k of PARTS) {
            const el = document.createElement('div');
            el.className = 'hp-part';
            el.textContent = PART_SHORT[k];
            el.title = PART_LABEL[k];
            body.appendChild(el);
            partEls[k] = el;
        }
        ui = {
            panel,
            death,
            deathSub: death.querySelector('#hp-death-sub'),
            vig: root.querySelector('.hp-vig'),
            pulse: root.querySelector('.hp-pulse'),
            dir: root.querySelector('.hp-dir'),
            faint: root.querySelector('.hp-faint'),
            hpFill: panel.querySelector('.hp-hp i'),
            bloodFill: panel.querySelector('.hp-blood i'),
            hpv: panel.querySelector('.hp-hpv'),
            bloodv: panel.querySelector('.hp-bloodv'),
            status: panel.querySelector('.hp-status'),
            supply: panel.querySelector('.hp-supply'),
            ord: panel.querySelector('.hp-ord'),
            action: panel.querySelector('.hp-action'),
            actionLabel: panel.querySelector('.hp-action span'),
            actionFill: panel.querySelector('.hp-action i'),
            parts: partEls
        };
    }

    function setText(el, text) {
        if (el.textContent !== text) el.textContent = text;
    }

    function statusText() {
        const src = bleedingSources();
        const out = [];
        if (state.dead) return 'ВЫ ПОГИБЛИ';
        if (src.heavy) {
            const k = heavyLimb() || (state.wounds.torso === 2 ? 'torso' : 'head');
            out.push(`СИЛЬНОЕ КРОВОТЕЧЕНИЕ: ${PART_LABEL[k]}`);
        } else if (src.light) {
            out.push('КРОВОТЕЧЕНИЕ: СЛАБОЕ');
        }
        if (legImpaired()) out.push('ХРОМОТА');
        if (state.consciousness === 'unconscious') out.push('ПОТЕРЯ СОЗНАНИЯ');
        else if (painEff() > 0.35) out.push('СИЛЬНАЯ БОЛЬ');
        if (state.painkiller > 0) out.push(`ОБЕЗБОЛ. ${Math.ceil(state.painkiller)} С`);
        return out.join(' • ');
    }

    function refreshPanel() {
        if (!ui) return;
        const hpPct = Math.round(state.hp / state.maxHp * 100);
        const blood = Math.max(0, Math.round(state.blood));
        ui.hpFill.style.width = `${hpPct}%`;
        ui.bloodFill.style.width = `${blood}%`;
        setText(ui.hpv, String(Math.round(state.hp)));
        setText(ui.bloodv, `${blood}%`);
        for (const k of PARTS) {
            let cls = 'hp-part';
            const w = state.wounds[k];
            if (w === 2) cls += ' heavy';
            else if (w === 1) cls += ' light';
            else if (state.limbs[k] === 'tourniquet') cls += ' tourniquet';
            else if (state.limbs[k] === 'wounded') cls += ' wounded';
            if (ui.parts[k].className !== cls) ui.parts[k].className = cls;
        }
        setText(ui.status, statusText());
        const s = state.supplies;
        setText(ui.supply, `[8] ПЕРЕВЯЗКА ×${s.bandage}  [9] ЖГУТ ×${s.tourniquet}  [0] ОБЕЗБОЛ. ×${s.painkiller}`);
        const inv = engine.ordnance && engine.ordnance.inventory;
        setText(ui.ord, inv ? `[5] ГРАНАТА ×${inv.frag}  [6] ДЫМ ×${inv.smoke}  [7] ТМ-62 ×${inv.mine}` : '');
        if (state.action) {
            ui.action.style.display = 'block';
            setText(ui.actionLabel, `${state.action.label}…`);
            ui.actionFill.style.width = `${Math.min(100, state.action.t / state.action.dur * 100)}%`;
        } else if (ui.action.style.display !== 'none') {
            ui.action.style.display = 'none';
        }
    }

    function refreshFx(dt) {
        if (!ui) return;
        pulse = Math.max(0, pulse - dt * 1.6);
        dirAlpha = Math.max(0, dirAlpha - dt * 0.9);
        const bf = bloodFrac();
        // Blood loss: tunnel vision closes in below 70 %, a heartbeat pulses the edge once it is low.
        const loss = Math.max(0, Math.min(1, (0.7 - bf) / 0.7));
        const lowHp = Math.max(0, Math.min(1, (0.45 - state.hp / state.maxHp) / 0.45));
        const beat = (loss > 0.15 || lowHp > 0.2) ? 0.5 + 0.5 * Math.sin(time * (3.5 + 5 * Math.max(loss, lowHp))) : 0;
        const intensity = Math.max(loss, lowHp * 0.8);
        const radius = Math.round(100 - intensity * 78 + beat * 4 * intensity);
        if (radius !== lastTunnel) {
            lastTunnel = radius;
            ui.vig.style.setProperty('--r', `${radius}%`);
        }
        const vigOpacity = Math.round(Math.min(1, intensity * 1.4 + (state.dead ? 1 : 0)) * 20) / 20;
        if (vigOpacity !== lastVig) {
            lastVig = vigOpacity;
            ui.vig.style.opacity = String(vigOpacity);
        }
        ui.pulse.style.opacity = (Math.min(1, pulse * 1.1 + beat * intensity * 0.35)).toFixed(2);
        ui.dir.style.opacity = dirAlpha.toFixed(2);
        ui.dir.style.transform = `rotate(${dirAngle.toFixed(3)}rad)`;
        const faint = state.consciousness === 'unconscious' ? 0.55 + 0.35 * Math.sin(time * 2.2) : 0;
        ui.faint.style.opacity = Math.max(0, faint).toFixed(2);
        const gray = Math.round(Math.max(0, Math.min(0.85, (0.65 - bf) / 0.65)) * 20) / 20;
        if (gray !== lastFilter) {
            lastFilter = gray;
            const canvas = engine.renderer && engine.renderer.domElement;
            if (canvas) canvas.style.filter = gray > 0 ? `grayscale(${gray})` : '';
        }
        if (state.dead) setText(ui.deathSub, `ВОЗРОЖДЕНИЕ ЧЕРЕЗ ${Math.max(0, Math.ceil(state.deathTimer))} С`);
    }

    // ------------------------------------------------------------------ frame

    function update(dt) {
        time += dt;
        // Legacy code that writes engine.playerHp directly (match start, cheats) is honoured.
        if (!state.dead && Math.abs(engine.playerHp - syncedHp) > 0.01) {
            state.hp = Math.min(state.maxHp, Math.max(0, engine.playerHp));
            syncedHp = state.hp;
            if (state.hp <= 0) die('');
        }
        if (state.dead) {
            state.deathTimer -= dt;
            if (state.deathTimer <= 0) respawn();
            refreshFx(dt);
            return;
        }
        const rate = bleedRate();
        if (rate > 0) state.blood = Math.max(0, state.blood - rate * dt);
        if (state.blood <= 0) {
            state.blood = 0;
            die('Кровопотеря');
            return;
        }
        state.pain = Math.max(0, state.pain - dt * (state.painkiller > 0 ? 0.12 : 0.035));
        if (state.painkiller > 0) state.painkiller = Math.max(0, state.painkiller - dt);
        const bf = bloodFrac();
        const next = bf < 0.15 ? 'unconscious' : (bf < 0.4 ? 'dazed' : 'ok');
        if (next !== state.consciousness) {
            state.consciousness = next;
            panelTimer = 0;
        }
        if (state.action) {
            const a = state.action;
            const keys = engine.keys;
            const pv = engine.playerVehicleState;
            if (engine.isFiring || keys.MouseLeft) interruptAction('ОГОНЬ');
            else if (engine.isSprinting || (keys.ShiftLeft && keys.KeyW)) interruptAction('БЕГ');
            else if ((pv && pv.vehicle && pv.role === 'DRIVER') || (engine.fpvMode && engine.fpvMode.active)) interruptAction('ПОСАДКА');
            else {
                a.t += dt;
                if (a.t >= a.dur) finishAction();
            }
        }
        panelTimer -= dt;
        if (panelTimer <= 0 || state.action) {
            panelTimer = 0.2;
            refreshPanel();
        }
        refreshFx(dt);
    }

    // Pain shakes the view, bleeding out tilts it; death drops the camera. Runs after the player controller.
    function lateUpdate() {
        const pv = engine.playerVehicleState;
        if ((pv && pv.vehicle && pv.role === 'DRIVER') || (engine.fpvMode && engine.fpvMode.active)) return;
        if (state.dead) {
            const k = Math.min(1, (RESPAWN_SECONDS - state.deathTimer) / 0.9);
            engine.cameraMount.position.y += (0.35 - engine.cameraMount.position.y) * k;
            _eul.set(0, 0, 1.25 * k);
            engine.camera.quaternion.multiply(_sway.setFromEuler(_eul));
            return;
        }
        const pe = painEff();
        const amp = 0.0006 + pe * 0.007 + (1 - bloodFrac()) * 0.004 + (armImpaired() ? 0.0015 : 0);
        if (amp < 0.0007) return;
        _eul.set(
            (Math.sin(time * 1.7) + 0.5 * Math.sin(time * 3.9)) * amp,
            (Math.sin(time * 1.3 + 1.2) + 0.5 * Math.sin(time * 3.1)) * amp,
            Math.sin(time * 0.9) * amp * 1.4
        );
        engine.camera.quaternion.multiply(_sway.setFromEuler(_eul));
    }

    function onExplosion(p) {
        if (!p || p.handledPlayer || state.dead || !engine.isStarted) return;
        const pv = engine.playerVehicleState;
        if (pv && pv.vehicle && pv.role === 'DRIVER') return;
        const c = engine.playerCollider;
        const dx = c.start.x - p.pos.x, dy = c.start.y + 0.5 - p.pos.y, dz = c.start.z - p.pos.z;
        const d = Math.hypot(dx, dy, dz);
        if (!(d < p.radius)) return;
        const falloff = Math.pow(1 - d / p.radius, 1.35);
        const amount = Math.min(140, (p.damage || 100) * falloff * 0.5);
        if (amount < 1) return;
        const len = Math.hypot(dx, dz) || 1;
        applyDamage({ amount, zone: 'TORSO', pos: p.pos, dir: { x: dx / len, y: 0, z: dz / len }, attacker: p.attacker || '', source: p.label, blast: true });
    }

    const mod = {
        name: 'health',
        state,
        applyDamage,
        startAction,
        addSupplies,
        respawn,
        reset: resetState,
        bleedRate,
        update,
        lateUpdate,
        install() {
            buildUi();
            removers.push(
                engine.addModifier('playerSpeed', playerSpeed),
                engine.addModifier('canSprint', canSprint),
                engine.addModifier('canFire', canFire),
                engine.addModifier('aimSway', aimSway),
                engine.addModifier('recoil', recoil),
                engine.events.on('explosion', onExplosion),
                engine.input.bind('Digit8', (e) => { if (!e.repeat) startAction('bandage'); return true; }),
                engine.input.bind('Digit9', (e) => { if (!e.repeat) startAction('tourniquet'); return true; }),
                engine.input.bind('Digit0', (e) => { if (!e.repeat) startAction('painkiller'); return true; })
            );
            refreshPanel();
        },
        onStart() {
            resetState();
            if (ui) ui.death.style.display = 'none';
            refreshPanel();
        }
    };
    return mod;
}
