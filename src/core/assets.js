import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { STATS } from '../../stats.js';

const BASIS_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/';
const CACHE_NAME = 'battle-assets-v1';
const MANIFEST_URL = './individual_models/manifest.json';

// Loaded before the match can start; everything else streams in behind placeholders.
const PRIORITY_KEYS = new Set([
    'soldier_ru', 'soldier_ua', 'weapon_ak12', 'weapon_m4a1', 'weapon_ak74m', 'weapon_rpg7',
    'dragons_teeth', 'hesco_bastion'
]);

async function runLimited(items, limit, worker) {
    let next = 0;
    const lanes = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        lanes.push((async () => {
            while (next < items.length) await worker(items[next++]);
        })());
    }
    await Promise.all(lanes);
}

// GLB loading (meshopt + KTX2), Cache API persistence, progressive streaming and normalized instancing.
export class AssetManager {
    constructor(engine) {
        this.engine = engine;
        this.templates = new Map();     // key -> template | null (failed)
        this.pending = new Map();       // key -> [{ wrapper, span }] waiting for the model
        this.manifest = {};
        this.complete = false;
        this.backgroundDone = Promise.resolve();
        this._waiters = new Map();

        this.loader = new GLTFLoader();
        this.loader.setMeshoptDecoder(MeshoptDecoder);
        this.ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(engine.renderer);
        this.loader.setKTX2Loader(this.ktx2);
    }

    // onProgress(done, total, entry) reports the blocking (priority) tier only.
    async loadAll(onProgress) {
        try {
            const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
            if (res.ok) this.manifest = await res.json();
        } catch {
            this.manifest = {};
        }
        let cache = null;
        try {
            if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME);
        } catch {
            cache = null;   // insecure context or storage disabled
        }

        const progressive = this.engine.settings.get('progressiveLoading');
        const all = STATS.MODELS;
        const first = progressive ? all.filter((e) => PRIORITY_KEYS.has(e.key)) : all.slice();
        const rest = progressive ? all.filter((e) => !PRIORITY_KEYS.has(e.key)) : [];
        const used = new Set();
        let loaded = 0;
        let firstDone = 0;

        const loadOne = async (entry, blocking) => {
            try {
                const gltf = await this._loadGltf(entry, cache, used);
                this._register(entry, gltf);
            } catch (err) {
                console.warn(`[assets] ${entry.key} failed to load: ${err.message}`);
                this.templates.set(entry.key, null);
                this._settle(entry.key);
            }
            loaded++;
            if (blocking && onProgress) onProgress(++firstDone, first.length, entry);
            this.engine.events.emit('assets:progress', { key: entry.key, loaded, total: all.length });
        };

        await runLimited(first, 4, (e) => loadOne(e, true));
        this.backgroundDone = runLimited(rest, 3, (e) => loadOne(e, false)).then(async () => {
            this.complete = true;
            this.engine.events.emit('assets:complete', {});
            if (cache) {
                for (const req of await cache.keys()) {
                    if (!used.has(req.url)) cache.delete(req);
                }
            }
        });
        if (!rest.length) await this.backgroundDone;
    }

    async _loadGltf(entry, cache, used) {
        const name = entry.file.split('/').pop();
        const version = this.manifest[name]?.sha1 || '0';
        const url = new URL(`${entry.file}?v=${version}`, location.href).href;
        used.add(url);
        let res = cache ? await cache.match(url) : null;
        if (!res) {
            res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (cache) cache.put(url, res.clone()).catch(() => {});
        }
        const buffer = await res.arrayBuffer();
        const base = entry.file.slice(0, entry.file.lastIndexOf('/') + 1);
        return this.loader.parseAsync(buffer, base);
    }

    _register(entry, gltf) {
        const { skipMips, anisotropy } = this.engine.quality.profile.textures;
        const seenTextures = new Set();
        const scene = gltf.scene;
        const drop = [];
        scene.traverse((child) => {
            if (entry.isSkinned && child.name && child.name.startsWith('Armband_')) drop.push(child);
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            if (entry.isSkinned) child.frustumCulled = false;
            if (child.userData.lod > 0) child.visible = false;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            for (const mat of mats) {
                if (!mat) continue;
                if (!entry.isSkinned) mat.side = THREE.DoubleSide;
                for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
                    const tex = mat[slot];
                    if (!tex || seenTextures.has(tex)) continue;
                    seenTextures.add(tex);
                    tex.anisotropy = anisotropy;
                    // Low presets drop the largest mip levels of KTX2 textures to save VRAM.
                    if (skipMips > 0 && tex.isCompressedTexture && Array.isArray(tex.mipmaps) && tex.mipmaps.length > skipMips + 2) {
                        tex.mipmaps.splice(0, skipMips);
                        tex.image.width = tex.mipmaps[0].width;
                        tex.image.height = tex.mipmaps[0].height;
                        tex.needsUpdate = true;
                    }
                }
            }
        });
        for (const node of drop) node.parent?.remove(node);

        scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(scene);
        const template = {
            key: entry.key,
            entry,
            gltf,
            scene,
            box,
            size: box.getSize(new THREE.Vector3()),
            center: box.getCenter(new THREE.Vector3())
        };
        this.templates.set(entry.key, template);

        const waiting = this.pending.get(entry.key);
        if (waiting) {
            this.pending.delete(entry.key);
            for (const { wrapper, span } of waiting) {
                if (wrapper.userData.placeholder) {
                    wrapper.remove(wrapper.userData.placeholder);
                    wrapper.userData.placeholder = null;
                }
                this._fill(wrapper, template, span);
                this.engine.events.emit('asset:ready', { key: entry.key, wrapper });
            }
        }
        this._settle(entry.key);
    }

    _settle(key) {
        const waiters = this._waiters.get(key);
        if (!waiters) return;
        this._waiters.delete(key);
        for (const resolve of waiters) resolve(this.templates.get(key));
    }

    has(key) {
        return Boolean(this.templates.get(key));
    }

    getTemplate(key) {
        return this.templates.get(key) || null;
    }

    whenLoaded(key) {
        if (this.templates.has(key)) return Promise.resolve(this.templates.get(key));
        return new Promise((resolve) => {
            const list = this._waiters.get(key) || [];
            list.push(resolve);
            this._waiters.set(key, list);
        });
    }

    // Static model normalized like the original engine: centred on XZ, resting on y=0, longest side = span.
    // Models that are still streaming return a wrapper that is filled in later (`asset:ready`).
    instantiate(key, spanOverride = null) {
        const wrapper = new THREE.Group();
        wrapper.userData.assetKey = key;
        const template = this.templates.get(key);
        if (template) {
            this._fill(wrapper, template, spanOverride);
        } else if (template === undefined && STATS.MODELS.some((m) => m.key === key)) {
            const spec = STATS.VEHICLE_SPECS[key];
            if (spec) {
                const [hx, hy, hz] = spec.halfExtents;
                const ph = new THREE.Mesh(
                    new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
                    new THREE.MeshStandardMaterial({ color: 0x3a4034, roughness: 0.9, transparent: true, opacity: 0.55 })
                );
                ph.position.y = hy;
                wrapper.add(ph);
                wrapper.userData.placeholder = ph;
            }
            const list = this.pending.get(key) || [];
            list.push({ wrapper, span: spanOverride });
            this.pending.set(key, list);
        } else {
            const fallback = new THREE.Mesh(
                new THREE.BoxGeometry(1.5, 1.2, 2.5),
                new THREE.MeshStandardMaterial({ color: 0x4a5240, roughness: 0.8 })
            );
            fallback.position.y = 0.6;
            wrapper.add(fallback);
        }
        return wrapper;
    }

    _fill(wrapper, template, spanOverride) {
        const clone = template.scene.clone(true);
        const span = spanOverride || template.entry.targetSize || 2.0;
        const scale = span / Math.max(template.size.x, template.size.y, template.size.z, 0.001);
        clone.scale.multiplyScalar(scale);
        clone.position.set(-template.center.x * scale, -template.box.min.y * scale, -template.center.z * scale);
        wrapper.add(clone);
        wrapper.userData.model = clone;
        wrapper.userData.modelScale = scale;
        return clone;
    }

    // Skinned character clone scaled to `height` metres, feet on y=0. Returns null if the model is missing.
    instantiateSkinned(key, height = 1.82) {
        const template = this.templates.get(key);
        if (!template) return null;
        const model = SkeletonUtils.clone(template.scene);
        const scale = height / Math.max(template.size.y, 0.1);
        model.scale.multiplyScalar(scale);
        model.position.set(-template.center.x * scale, -template.box.min.y * scale, -template.center.z * scale);
        return { model, scale };
    }
}
