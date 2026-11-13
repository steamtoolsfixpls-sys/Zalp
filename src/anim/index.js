import { bakeTemplate } from './clips.js';
import { Animator } from './animator.js';
import { WEAPONS, weaponSpec } from './weapons.js';

// "anim" feature module: skeletal animation of soldiers. Clips are baked once per soldier rig (see clips.js),
// every unit gets one Animator (`unit.animator`). Public: attach(unit), setWeapon(unit, weaponKey), templates.
export function createAnim(engine) {
    const templates = new Map();

    function templateFor(unit) {
        const key = unit.faction === 'RU' ? 'soldier_ru' : 'soldier_ua';
        if (!templates.has(key)) {
            let tpl = null;
            try {
                tpl = bakeTemplate(engine, key);
            } catch (err) {
                console.error(`[anim] baking "${key}" failed`, err);
            }
            templates.set(key, tpl);
        }
        return templates.get(key);
    }

    function attach(unit) {
        if (!unit || !unit.root || !unit.modelNode || !unit.bones || !unit.bones.hips) return null;
        if (unit.animator) unit.animator.dispose();
        const tpl = templateFor(unit);
        if (!tpl) return null;
        unit.animator = new Animator(engine, unit, tpl, unit.weaponKey);
        return unit.animator;
    }

    // Swaps the carried weapon model (rifle, RPG-7) and the arm poses that hold it.
    function setWeapon(unit, weaponKey) {
        if (!unit || !WEAPONS[weaponKey]) return false;
        const spec = weaponSpec(weaponKey);
        const old = unit.root.userData.rifleMesh;
        const wrapper = engine.instantiateStaticModel(spec.model, spec.span);
        if (!wrapper) return false;
        if (old && old.parent) old.parent.remove(old);
        unit.root.add(wrapper);
        unit.root.userData.rifleMesh = wrapper;
        unit.weaponKey = weaponKey;
        if (unit.animator) unit.animator.setWeaponKey(weaponKey);
        return true;
    }

    const mod = {
        name: 'anim',
        templates,
        attach,
        setWeapon,
        install() {
            for (const unit of engine.units) attach(unit);
        },
        update(dt) {
            const units = engine.units;
            for (let i = 0; i < units.length; i++) {
                const a = units[i].animator;
                if (a) a.update(dt);
            }
        }
    };
    return mod;
}
