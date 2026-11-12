import * as THREE from 'three';
import { mergeStaticModel, mergeSkinnedModel, createFarWeaponMesh, createPropBatcher } from '../gfx/batching.js';

// "lod" feature module: distance LOD for soldiers and carried weapons, distance / frustum culling,
// shadow-caster cutoff, draw-call merging of streamed models and instancing of repeated props.
// Public surface: register(object, kind), unregister(object), levelOf(target), isVisible(target),
// setInstanceVisible(source, visible), releaseInstance(source).

const INSTANCED_KEYS = ['dragons_teeth', 'hesco_bastion'];
const UNIT_STAGGER = 4;         // a soldier re-evaluates distance LOD every 4th frame
const OBJECT_STAGGER = 8;
const SCAN_INTERVAL = 90;       // frames between sweeps for newly added models
const HYSTERESIS = 0.1;
const FAR = 3;                  // weapon level drawn as a single flat silhouette
const SOLDIER_RADIUS = 1.6;
const SHADOW_SLACK = 2.5;       // keep off-screen soldiers whose shadow can still reach the view

const _camPos = new THREE.Vector3();
const _center = new THREE.Vector3();
const _viewProj = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();

function pickLevel(current, d, d1, d2) {
    let level = d < d1 ? 0 : d < d2 ? 1 : 2;
    if (current >= 0 && level < current) {
        const edge = current >= 2 ? d2 : d1;
        if (d > edge * (1 - HYSTERESIS)) level = current;
    }
    return level;
}

// Meshes of a model grouped by baked LOD level, plus shadow casters and un-LODed attachments.
function scanModel(root, skip) {
    const set = { levels: [[], [], []], far: null, casters: [], extras: [], populated: false };
    const visit = (node) => {
        if (node === skip) return;
        if (node.isMesh) {
            if (node.castShadow) set.casters.push(node);
            const lod = node.userData.lod;
            if (node.userData.lodFar) {
                set.far = node;
            } else if (typeof lod === 'number' && lod >= 0) {
                set.levels[Math.min(2, lod)].push(node);
                set.populated = true;
            } else if (!node.isSkinnedMesh) {
                set.extras.push(node);
            }
        }
        const children = node.children;
        for (let i = 0; i < children.length; i++) visit(children[i]);
    };
    visit(root);
    return set;
}

// Shows one LOD level of a set; falls back to the nearest populated level, never below `minLevel`.
function showLevel(set, level, minLevel) {
    if (!set || !set.populated) return;
    let use = -1;
    if (level >= FAR && set.far) {
        use = FAR;
    } else {
        const want = Math.min(2, level);
        for (let l = want; l <= 2 && use < 0; l++) if (set.levels[l].length) use = l;
        for (let l = want - 1; l >= minLevel && use < 0; l--) if (set.levels[l].length) use = l;
        if (use < 0) return;
    }
    for (let l = 0; l < 3; l++) {
        const list = set.levels[l];
        const visible = l === use;
        for (let i = 0; i < list.length; i++) list[i].visible = visible;
    }
    if (set.far) set.far.visible = use === FAR;
}

export function createLod(engine) {
    const entries = [];                 // vehicles, props, batches, world weapons
    const byObject = new WeakMap();     // Object3D -> entry (including soldier roots)
    const unitEntries = new WeakMap();  // unit -> entry
    const fixedMaterials = new WeakSet();
    let batcher = null;
    let frame = 0;
    let forceAll = true;
    let warned = false;

    const mod = {
        name: 'lod',
        frustumCulling: true,           // turn off while rendering the world from a second camera
        stats: { mergedDraws: 0, batches: 0 },
        install,
        lateUpdate,
        register,
        unregister,
        levelOf,
        isVisible,
        setInstanceVisible: (source, visible) => (batcher ? batcher.setVisible(source, visible) : false),
        releaseInstance: (source) => (batcher ? batcher.release(source) : false)
    };

    function guard(fn) {
        try {
            return fn();
        } catch (err) {
            if (!warned) console.warn('[lod] model optimisation skipped:', err.message);
            warned = true;
            return 0;
        }
    }

    // Soldier GLBs flag their opaque cloth as blended: that draws every piece twice without depth writes.
    function fixSkinnedMaterials(root) {
        root.traverse((o) => {
            if (!o.isSkinnedMesh || Array.isArray(o.material)) return;
            const mat = o.material;
            if (fixedMaterials.has(mat)) return;
            fixedMaterials.add(mat);
            if (mat.transparent && mat.opacity >= 1) {
                mat.transparent = false;
                mat.depthWrite = true;
                mat.alphaTest = Math.max(mat.alphaTest, 0.5);
                mat.needsUpdate = true;
            }
        });
    }

    function mergeModel(wrapper) {
        const model = wrapper.userData.model;
        if (!model) return;
        const key = wrapper.userData.assetKey || model.uuid;
        mod.stats.mergedDraws += guard(() => mergeStaticModel(model, key));
        mod.stats.mergedDraws += guard(() => mergeSkinnedModel(model));
    }

    function prepareWeapon(wrapper) {
        const model = wrapper.userData.model;
        if (!model) return null;
        mergeModel(wrapper);
        let set = scanModel(model, null);
        if (!set.far && set.populated && guard(() => createFarWeaponMesh(model, wrapper.userData.assetKey || model.uuid))) {
            set = scanModel(model, null);
        }
        return set;
    }

    function makeEntry(object, kind) {
        return {
            object,
            kind,
            unit: null,
            hips: null,
            level: -1,
            body: null,
            weapon: null,
            weaponWrapper: null,
            casters: [],
            radius: 1,
            offset: new THREE.Vector3(),
            scale: 1,
            culled: false,
            offscreen: false,
            hidden: false,
            shadows: true,
            dirty: false
        };
    }

    function setHidden(entry, hidden) {
        const object = entry.object;
        if (hidden) {
            // Only take over objects that are currently shown, so other owners of `visible` win.
            if (!entry.hidden && object.visible) {
                object.visible = false;
                entry.hidden = true;
            }
        } else if (entry.hidden) {
            object.visible = true;
            entry.hidden = false;
        }
    }

    function setShadows(entry, on) {
        if (entry.shadows === on) return;
        entry.shadows = on;
        const list = entry.casters;
        for (let i = 0; i < list.length; i++) list[i].castShadow = on;
    }

    function setupSoldier(entry, unit) {
        if (entry.hidden) entry.object.visible = true;
        const root = unit.root;
        entry.object = root;
        entry.hidden = false;
        entry.culled = false;
        entry.offscreen = false;
        entry.shadows = true;
        entry.level = -1;
        entry.dirty = false;
        entry.hips = unit.bones?.hips || null;
        byObject.set(root, entry);

        guard(() => fixSkinnedMaterials(root));
        mod.stats.mergedDraws += guard(() => mergeSkinnedModel(root));
        const rifle = root.userData.rifleMesh || null;
        entry.weaponWrapper = rifle;
        entry.body = scanModel(root, rifle);
        entry.casters = entry.body.casters;
        entry.weapon = rifle ? prepareWeapon(rifle) : null;
        if (entry.weapon) for (const mesh of entry.weapon.casters) entry.casters.push(mesh);
        root.updateWorldMatrix(true, true);
    }

    function applySoldierLevel(entry, level) {
        entry.level = level;
        showLevel(entry.body, level, 0);
        if (entry.body.populated) {
            // Armbands and other small attachments are dropped with the last body LOD.
            const extras = entry.body.extras;
            for (let i = 0; i < extras.length; i++) extras[i].visible = level < 2;
        }
        // AI rifles use the baked world models only: LOD 1 up close, LOD 2, then the flat silhouette.
        showLevel(entry.weapon, level + 1, 1);
    }

    function setupObject(entry) {
        const object = entry.object;
        entry.dirty = false;
        entry.level = -1;
        entry.shadows = true;
        let set = null;
        if (entry.kind === 'worldWeapon') {
            set = prepareWeapon(object) || scanModel(object, null);
        } else if (entry.kind !== 'batch') {
            mergeModel(object);
            set = scanModel(object, null);
        }
        entry.body = set;
        entry.casters = set ? set.casters : (object.castShadow ? [object] : []);

        object.updateWorldMatrix(true, true);
        _box.setFromObject(object);
        if (_box.isEmpty()) {
            entry.radius = 1;
            entry.offset.set(0, 0, 0);
        } else {
            _box.getBoundingSphere(_sphere);
            entry.radius = _sphere.radius;
            entry.offset.copy(_sphere.center).sub(_center.setFromMatrixPosition(object.matrixWorld));
        }
        // Small props drop detail sooner than a soldier, large hulls later.
        entry.scale = entry.kind === 'vehicle' ? 1.5 : THREE.MathUtils.clamp(entry.radius / 0.9, 0.5, 1.5);
    }

    function register(object, kind = 'prop') {
        if (!object || !object.isObject3D) return null;
        let entry = byObject.get(object);
        if (entry) {
            if (entry.kind !== kind && !entry.unit) {
                entry.kind = kind;
                entry.dirty = true;
            }
            return object;
        }
        entry = makeEntry(object, kind);
        entry.dirty = true;     // set up and evaluated on the next update
        byObject.set(object, entry);
        entries.push(entry);
        return object;
    }

    function unregister(object) {
        const entry = byObject.get(object);
        if (!entry || entry.unit) return;
        if (entry.hidden) object.visible = true;
        byObject.delete(object);
        const i = entries.indexOf(entry);
        if (i !== -1) entries.splice(i, 1);
    }

    function entryOf(target) {
        if (!target) return null;
        return (target.root ? unitEntries.get(target) : null) || byObject.get(target) || null;
    }

    // Current LOD level: 0 (full detail) .. 2; carried weapons draw one level coarser than the body.
    function levelOf(target) {
        const entry = entryOf(target);
        return entry ? Math.max(0, entry.level) : 0;
    }

    function isVisible(target) {
        const entry = entryOf(target);
        return entry ? !entry.hidden : true;
    }

    function adoptScene() {
        const vehicles = engine.physics?.vehicles || [];
        for (let i = 0; i < vehicles.length; i++) {
            if (vehicles[i].mesh && !byObject.has(vehicles[i].mesh)) register(vehicles[i].mesh, 'vehicle');
        }
        const instanced = new Map();
        const boxes = [];
        const flying = new Set((engine.drones || []).map((d) => d.mesh));
        for (const child of engine.scene.children) {
            const key = child.userData?.assetKey;
            if (key && !byObject.has(child)) {
                if (INSTANCED_KEYS.includes(key) && child.userData.model) {
                    if (!instanced.has(key)) instanced.set(key, []);
                    instanced.get(key).push(child);
                } else if (flying.has(child)) {
                    mergeModel(child);
                } else {
                    register(child, 'prop');
                }
            } else if (child.userData?.batchable && child.isMesh) {
                boxes.push(child);
            }
        }
        const made = [];
        for (const [key, list] of instanced) made.push(...guard(() => batcher.addWrappers(list, key)) || []);
        if (boxes.length) made.push(...guard(() => batcher.addBoxes(boxes, 'stand')) || []);
        for (const batch of made) register(batch, 'batch');
        mod.stats.batches = batcher.batches.length;
    }

    // Models that appear after boot (player drones, late spawns) still get their draw calls merged.
    function sweepScene() {
        const vehicles = engine.physics?.vehicles || [];
        for (let i = 0; i < vehicles.length; i++) {
            if (vehicles[i].mesh && !byObject.has(vehicles[i].mesh)) register(vehicles[i].mesh, 'vehicle');
        }
        const children = engine.scene.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const model = child.userData.model;
            if (model && !model.userData.gfxMerged && !byObject.has(child)) mergeModel(child);
        }
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].object.parent) continue;
            byObject.delete(entries[i].object);
            entries.splice(i, 1);
        }
    }

    function updateSoldier(entry, full, lod, zoom, shadowsOn, shadowDist) {
        if (entry.hips) {
            _center.setFromMatrixPosition(entry.hips.matrixWorld);
        } else {
            _center.setFromMatrixPosition(entry.object.matrixWorld);
            _center.y += 0.9;
        }
        if (mod.frustumCulling) {
            _sphere.center.copy(_center);
            _sphere.radius = SOLDIER_RADIUS + (shadowsOn ? SHADOW_SLACK : 0);
            entry.offscreen = !_frustum.intersectsSphere(_sphere);
        } else {
            entry.offscreen = false;
        }
        if (full) {
            const d = _center.distanceTo(_camPos) * zoom;
            entry.culled = d > lod.cullDistance * (entry.culled ? 1 - HYSTERESIS : 1);
            if (!entry.culled) {
                const level = pickLevel(entry.level, d, lod.soldierLod1, lod.soldierLod2);
                if (level !== entry.level) applySoldierLevel(entry, level);
                setShadows(entry, !shadowsOn || d < shadowDist * (entry.shadows ? 1 : 1 - HYSTERESIS));
            }
        }
        setHidden(entry, entry.culled || entry.offscreen);
    }

    function updateObject(entry, lod, zoom, shadowsOn, shadowDist) {
        const object = entry.object;
        _center.setFromMatrixPosition(object.matrixWorld).add(entry.offset);
        const centerDist = _center.distanceTo(_camPos) * zoom;
        const d = Math.max(0, centerDist - entry.radius);
        entry.culled = d > lod.cullDistance * (entry.culled ? 1 - HYSTERESIS : 1);
        if (!entry.culled) {
            if (entry.body && entry.body.populated) {
                const level = pickLevel(entry.level, centerDist, lod.soldierLod1 * entry.scale, lod.soldierLod2 * entry.scale);
                if (level !== entry.level) {
                    entry.level = level;
                    if (entry.kind === 'worldWeapon') showLevel(entry.body, level + 1, 1);
                    else showLevel(entry.body, level, 0);
                }
            }
            setShadows(entry, !shadowsOn || d < shadowDist * (entry.shadows ? 1 : 1 - HYSTERESIS));
        }
        setHidden(entry, entry.culled);
    }

    function refresh(force) {
        const camera = engine.camera;
        const profile = engine.quality.profile;
        const lod = profile.lod;
        const shadowsOn = profile.shadows.enabled;
        const shadowDist = lod.shadowCasterDistance > 0 ? lod.shadowCasterDistance : profile.shadows.distance;
        frame++;

        camera.updateWorldMatrix(true, false);
        _camPos.setFromMatrixPosition(camera.matrixWorld);
        _viewProj.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
        _frustum.setFromProjectionMatrix(_viewProj);
        // Optics narrow the field of view: scale distances so magnified targets keep their detail.
        const baseFov = engine.baseFov || camera.fov;
        const zoom = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) / Math.tan(THREE.MathUtils.degToRad(baseFov) * 0.5);

        const units = engine.units;
        for (let i = 0; i < units.length; i++) {
            const unit = units[i];
            if (!unit.root) continue;
            let entry = unitEntries.get(unit);
            if (!entry) {
                entry = makeEntry(unit.root, 'soldier');
                entry.unit = unit;
                entry.dirty = true;
                unitEntries.set(unit, entry);
            }
            // Respawn replaces unit.root; other packages may swap the carried weapon.
            const rebuilt = entry.dirty || entry.object !== unit.root || entry.weaponWrapper !== (unit.root.userData.rifleMesh || null);
            if (rebuilt) setupSoldier(entry, unit);
            updateSoldier(entry, rebuilt || force || (i + frame) % UNIT_STAGGER === 0, lod, zoom, shadowsOn, shadowDist);
        }

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (entry.dirty) {
                setupObject(entry);
                updateObject(entry, lod, zoom, shadowsOn, shadowDist);
            } else if (force || (i + frame) % OBJECT_STAGGER === 0) {
                updateObject(entry, lod, zoom, shadowsOn, shadowDist);
            }
        }
    }

    function lateUpdate() {
        if (frame % SCAN_INTERVAL === 0) sweepScene();
        refresh(forceAll);
        forceAll = false;
    }

    function install() {
        batcher = createPropBatcher(engine.scene);
        adoptScene();
        engine.events.on('asset:ready', ({ wrapper }) => {
            let node = wrapper;
            let entry = null;
            while (node && !(entry = byObject.get(node))) node = node.parent;
            if (entry) entry.dirty = true;
            else if (wrapper) mergeModel(wrapper);
        });
        engine.events.on('quality:changed', () => { forceAll = true; });
        // Apply LODs before the first frame: the simulation does not tick until the match starts.
        refresh(true);
        forceAll = true;
    }

    return mod;
}
