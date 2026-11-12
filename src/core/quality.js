import * as THREE from 'three';

// Graphics presets. Modules read `engine.quality.profile` and react to the `quality:changed` event.
// `lod` distances are metres from the camera; `postfx.composer` selects the post-processing chain
// (`samples` = MSAA of its render target, `bloomScale` = bloom resolution factor).
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const QUALITY_PRESETS = {
    low: {
        label: 'НИЗКОЕ',
        maxPixelRatio: 1.0,
        resolutionScale: 0.8,
        msaa: false,
        drawDistance: 260,
        dynamicResolution: { enabled: true, minScale: 0.55 },
        shadows: { enabled: false, mapSize: 1024, type: 'basic', distance: 35 },
        lighting: { envMap: false, maxDynamicLights: 2 },
        textures: { skipMips: 2, anisotropy: 1 },
        lod: { soldierLod1: 12, soldierLod2: 30, cullDistance: 170, shadowCasterDistance: 0 },
        anim: { ik: 'off', farUpdateHz: 8, farDistance: 28 },
        particles: { budget: 1200, emission: 0.45, soft: false },
        decals: { budget: 48 },
        debris: { max: 12 },
        ragdolls: { max: 4 },
        smoke: { puffs: 20 },
        postfx: { composer: false, bloom: false, ssao: false, grain: false, vignette: true },
        audio: { maxVoices: 16, hrtf: false, reverb: false },
        physics: { hz: 45 }
    },
    medium: {
        label: 'СРЕДНЕЕ',
        maxPixelRatio: 1.25,
        resolutionScale: 1.0,
        msaa: true,
        drawDistance: 400,
        dynamicResolution: { enabled: true, minScale: 0.6 },
        shadows: { enabled: true, mapSize: 1024, type: 'pcf', distance: 45 },
        lighting: { envMap: true, maxDynamicLights: 4 },
        textures: { skipMips: 1, anisotropy: 2 },
        lod: { soldierLod1: 22, soldierLod2: 50, cullDistance: 280, shadowCasterDistance: 45 },
        anim: { ik: 'arms', farUpdateHz: 15, farDistance: 45 },
        particles: { budget: 3500, emission: 0.7, soft: false },
        decals: { budget: 128 },
        debris: { max: 30 },
        ragdolls: { max: 8 },
        smoke: { puffs: 44 },
        postfx: { composer: true, samples: 2, bloom: true, bloomScale: 0.5, ssao: false, grain: true, vignette: true },
        audio: { maxVoices: 24, hrtf: true, reverb: true },
        physics: { hz: 60 }
    },
    high: {
        label: 'ВЫСОКОЕ',
        maxPixelRatio: 1.75,
        resolutionScale: 1.0,
        msaa: true,
        drawDistance: 600,
        dynamicResolution: { enabled: true, minScale: 0.7 },
        shadows: { enabled: true, mapSize: 2048, type: 'pcfsoft', distance: 70 },
        lighting: { envMap: true, maxDynamicLights: 8 },
        textures: { skipMips: 0, anisotropy: 4 },
        lod: { soldierLod1: 40, soldierLod2: 80, cullDistance: 450, shadowCasterDistance: 80 },
        anim: { ik: 'full', farUpdateHz: 30, farDistance: 70 },
        particles: { budget: 9000, emission: 1.0, soft: true },
        decals: { budget: 320 },
        debris: { max: 60 },
        ragdolls: { max: 14 },
        smoke: { puffs: 90 },
        postfx: { composer: true, samples: 4, bloom: true, bloomScale: 1, ssao: false, grain: true, vignette: true },
        audio: { maxVoices: 40, hrtf: true, reverb: true },
        physics: { hz: 60 }
    },
    ultra: {
        label: 'УЛЬТРА',
        maxPixelRatio: 2.0,
        resolutionScale: 1.0,
        msaa: true,
        drawDistance: 800,
        dynamicResolution: { enabled: false, minScale: 0.85 },
        shadows: { enabled: true, mapSize: 4096, type: 'pcfsoft', distance: 105 },
        lighting: { envMap: true, maxDynamicLights: 12 },
        textures: { skipMips: 0, anisotropy: 8 },
        lod: { soldierLod1: 60, soldierLod2: 140, cullDistance: 900, shadowCasterDistance: 160 },
        anim: { ik: 'full', farUpdateHz: 60, farDistance: 120 },
        particles: { budget: 20000, emission: 1.3, soft: true },
        decals: { budget: 800 },
        debris: { max: 120 },
        ragdolls: { max: 24 },
        smoke: { puffs: 150 },
        postfx: { composer: true, samples: 4, bloom: true, bloomScale: 1, ssao: true, grain: true, vignette: true },
        audio: { maxVoices: 64, hrtf: true, reverb: true },
        physics: { hz: 60 }
    }
};

const SHADOW_TYPES = {
    basic: THREE.BasicShadowMap,
    pcf: THREE.PCFShadowMap,
    pcfsoft: THREE.PCFSoftShadowMap
};

export function detectPreset() {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    const memory = navigator.deviceMemory || 8;
    const cores = navigator.hardwareConcurrency || 4;
    if (mobile) return memory <= 4 || cores <= 6 ? 'low' : 'medium';
    if (memory <= 4 || cores <= 4) return 'medium';
    return 'high';
}

export class QualityManager {
    constructor(engine) {
        this.engine = engine;
        this.preset = 'high';
        this.profile = QUALITY_PRESETS.high;
        this.resolutionScale = 1;       // dynamic resolution factor, (minScale..1]
        this._appliedRatio = -1;
        this._fpsAvg = 60;
        this._slowTime = 0;
        this._fastTime = 0;
        this._sunOffset = new THREE.Vector3(65, 95, 55);
        this._resolve();
        engine.events.on('settings:changed', ({ key }) => {
            if (key === 'quality' || key === 'shadowQuality' || key === 'dynamicResolution' || key === 'targetFps' || key === 'ragdollLimit') {
                this._resolve();
                this.apply();
            }
        });
    }

    setPreset(name) {
        this.engine.settings.set('quality', name);
    }

    _resolve() {
        const settings = this.engine.settings;
        let name = settings.get('quality');
        if (!QUALITY_PRESETS[name]) name = detectPreset();
        const profile = structuredClone(QUALITY_PRESETS[name]);
        profile.name = name;
        const shadowOverride = settings.get('shadowQuality');
        if (shadowOverride === 'off') profile.shadows.enabled = false;
        else if (QUALITY_PRESETS[shadowOverride]) {
            profile.shadows = structuredClone(QUALITY_PRESETS[shadowOverride].shadows);
            profile.shadows.enabled = true;
        }
        const ragdollLimit = settings.get('ragdollLimit');
        if (ragdollLimit > 0) profile.ragdolls.max = ragdollLimit;
        profile.dynamicResolution.enabled = profile.dynamicResolution.enabled && settings.get('dynamicResolution');
        profile.dynamicResolution.targetFps = settings.get('targetFps') === 30 ? 30 : 60;
        this.preset = name;
        this.profile = profile;
        this.resolutionScale = 1;
    }

    apply() {
        const { renderer, sunLight, scene, camera } = this.engine;
        if (!renderer) return;
        const p = this.profile;
        this._applyPixelRatio();

        const prevType = renderer.shadowMap.type;
        const prevEnabled = renderer.shadowMap.enabled;
        renderer.shadowMap.enabled = p.shadows.enabled;
        renderer.shadowMap.type = SHADOW_TYPES[p.shadows.type] ?? THREE.PCFShadowMap;
        if (sunLight) {
            sunLight.castShadow = p.shadows.enabled;
            if (sunLight.shadow.mapSize.x !== p.shadows.mapSize) {
                sunLight.shadow.mapSize.set(p.shadows.mapSize, p.shadows.mapSize);
                if (sunLight.shadow.map) {
                    sunLight.shadow.map.dispose();
                    sunLight.shadow.map = null;
                }
            }
            const d = p.shadows.distance;
            const cam = sunLight.shadow.camera;
            cam.left = -d;
            cam.right = d;
            cam.top = d;
            cam.bottom = -d;
            cam.updateProjectionMatrix();
            if (!sunLight.target.parent) scene.add(sunLight.target);
        }
        if (prevType !== renderer.shadowMap.type || prevEnabled !== renderer.shadowMap.enabled) {
            scene.traverse((obj) => {
                if (!obj.material) return;
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) m.needsUpdate = true;
            });
        }
        camera.far = p.drawDistance;
        camera.updateProjectionMatrix();
        this.engine.events.emit('quality:changed', { preset: this.preset, profile: p });
    }

    _applyPixelRatio() {
        const p = this.profile;
        const ratio = Math.min(window.devicePixelRatio || 1, p.maxPixelRatio) * p.resolutionScale * this.resolutionScale;
        if (Math.abs(ratio - this._appliedRatio) > 0.01) {
            this._appliedRatio = ratio;
            this.engine.renderer.setPixelRatio(ratio);
        }
    }

    update(dt) {
        const engine = this.engine;
        const p = this.profile;

        // Keep the (small) shadow frustum centred on the viewer, snapped to texels to avoid shimmer.
        const sun = engine.sunLight;
        if (sun && p.shadows.enabled) {
            const snap = (2 * p.shadows.distance / p.shadows.mapSize) * 8;
            const focus = engine.cameraMount.position;
            const fx = Math.round(focus.x / snap) * snap;
            const fz = Math.round(focus.z / snap) * snap;
            sun.target.position.set(fx, 0, fz);
            sun.position.set(fx + this._sunOffset.x, this._sunOffset.y, fz + this._sunOffset.z);
            sun.target.updateMatrixWorld();
        }

        const dr = p.dynamicResolution;
        if (!dr.enabled || !engine.isStarted || engine.isPaused || dt <= 0) return;
        this._fpsAvg += (1 / dt - this._fpsAvg) * Math.min(1, dt * 2);
        if (this._fpsAvg < dr.targetFps * 0.86) {
            this._slowTime += dt;
            this._fastTime = 0;
        } else if (this._fpsAvg > dr.targetFps * 0.97) {
            this._fastTime += dt;
            this._slowTime = 0;
        } else {
            this._slowTime = 0;
            this._fastTime = 0;
        }
        if (this._slowTime > 0.6 && this.resolutionScale > dr.minScale) {
            this.resolutionScale = Math.max(dr.minScale, this.resolutionScale - 0.08);
            this._slowTime = 0;
            this._applyPixelRatio();
        } else if (this._fastTime > 2.5 && this.resolutionScale < 1) {
            this.resolutionScale = Math.min(1, this.resolutionScale + 0.05);
            this._fastTime = 0;
            this._applyPixelRatio();
        }
    }
}
