// Persisted user settings. `?key=value` URL parameters override stored values for the session.
const STORAGE_KEY = 'battle.settings.v1';

export const SETTING_DEFAULTS = Object.freeze({
    quality: 'auto',            // auto | low | medium | high | ultra
    shadowQuality: 'auto',      // auto (from preset) | off | low | medium | high | ultra
    dynamicResolution: true,
    targetFps: 60,              // 30 | 60
    fov: 75,
    mouseSensitivity: 1.0,
    adsSensitivity: 1.0,
    fpvSensitivity: 1.0,
    invertY: false,
    freeAim: true,
    ragdollLimit: 0,            // 0 = from preset
    masterVolume: 0.8,
    sfxVolume: 1.0,
    radioVolume: 0.8,
    touchControls: 'auto',      // auto | on | off
    gyroAim: false,
    showFps: false,
    physicsWorker: true,
    progressiveLoading: true
});

function coerce(raw, sample) {
    if (typeof sample === 'boolean') return raw === 'true' || raw === '1';
    if (typeof sample === 'number') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : sample;
    }
    return raw;
}

export class Settings {
    constructor(events) {
        this.events = events;
        this.values = { ...SETTING_DEFAULTS };
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            for (const key of Object.keys(SETTING_DEFAULTS)) {
                if (typeof stored[key] === typeof SETTING_DEFAULTS[key]) this.values[key] = stored[key];
            }
        } catch {
            // Storage unavailable (private mode): run on defaults.
        }
        this.overrides = {};
        for (const [key, raw] of new URLSearchParams(location.search)) {
            if (key in SETTING_DEFAULTS) this.overrides[key] = coerce(raw, SETTING_DEFAULTS[key]);
        }
    }

    get(key) {
        return key in this.overrides ? this.overrides[key] : this.values[key];
    }

    set(key, value) {
        if (!(key in SETTING_DEFAULTS)) return;
        delete this.overrides[key];
        if (this.values[key] === value) return;
        this.values[key] = value;
        this._persist();
        this.events.emit('settings:changed', { key, value });
    }

    reset() {
        this.overrides = {};
        for (const key of Object.keys(SETTING_DEFAULTS)) this.set(key, SETTING_DEFAULTS[key]);
    }

    _persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
        } catch {
            // Ignore quota / privacy errors.
        }
    }
}
