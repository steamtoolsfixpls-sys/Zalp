export class SoundEngine {
    constructor() {
        this.ctx = null;
        this.noiseBuffer = null;
        this.engineNode = null;
    }
    init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            return;
        }
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        this.ctx = new AudioCtx();
        const sr = this.ctx.sampleRate;
        this.noiseBuffer = this.ctx.createBuffer(1, sr * 1.5, sr);
        const data = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.random() * 2 - 1;
        }
    }
    playGunshot(distance = 0, isHeavy = false) {
        if (!this.ctx || !this.noiseBuffer) return;
        const now = this.ctx.currentTime;
        const atten = Math.max(0.04, Math.min(1.0, 26.0 / (distance + 20.0)));
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(isHeavy ? 380 : 1250, now);
        filter.frequency.exponentialRampToValueAtTime(140, now + (isHeavy ? 0.42 : 0.17));
        filter.Q.value = 0.9;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime((isHeavy ? 1.25 : 0.78) * atten, now + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (isHeavy ? 0.46 : 0.21));

        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        src.start(now);
        src.stop(now + (isHeavy ? 0.48 : 0.23));

        const osc = this.ctx.createOscillator();
        const punchGain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(isHeavy ? 98 : 195, now);
        osc.frequency.exponentialRampToValueAtTime(28, now + 0.11);
        punchGain.gain.setValueAtTime(0.62 * atten, now);
        punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.115);
        osc.connect(punchGain);
        punchGain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.12);
    }
    playExplosion(distance = 0) {
        if (!this.ctx || !this.noiseBuffer) return;
        const now = this.ctx.currentTime;
        const atten = Math.max(0.08, Math.min(1.0, 55.0 / (distance + 18.0)));
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;

        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(540, now);
        lp.frequency.exponentialRampToValueAtTime(42, now + 1.45);

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(1.4 * atten, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);

        src.connect(lp);
        lp.connect(gain);
        gain.connect(this.ctx.destination);
        src.start(now);
        src.stop(now + 1.55);
    }
    playHitMarker(isHeadshot = false) {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = isHeadshot ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(isHeadshot ? 1680 : 920, now);
        osc.frequency.exponentialRampToValueAtTime(isHeadshot ? 620 : 340, now + 0.075);
        gain.gain.setValueAtTime(0.28, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.085);
    }
    playReloadClick(pitch = 640) {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(pitch, now);
        osc.frequency.exponentialRampToValueAtTime(180, now + 0.045);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.055);
    }
    createDroneMotorNode() {
        if (!this.ctx) return null;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = 390;
        gain.gain.value = 0.0;
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        return { osc, gain };
    }
    updateVehicleEngineSound(active, speedKmh, throttle) {
        if (!this.ctx) return;
        if (!this.engineNode) {
            const osc = this.ctx.createOscillator();
            const filter = this.ctx.createBiquadFilter();
            const gain = this.ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.value = 48;
            filter.type = 'lowpass';
            filter.frequency.value = 190;
            gain.gain.value = 0.0;
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            this.engineNode = { osc, filter, gain };
        }
        if (!active) {
            this.engineNode.gain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.08);
            return;
        }
        const rpmFreq = 46 + Math.min(85, speedKmh * 1.15 + Math.abs(throttle) * 28);
        this.engineNode.osc.frequency.setTargetAtTime(rpmFreq, this.ctx.currentTime, 0.06);
        this.engineNode.filter.frequency.setTargetAtTime(160 + rpmFreq * 2.2, this.ctx.currentTime, 0.06);
        this.engineNode.gain.gain.setTargetAtTime(0.11, this.ctx.currentTime, 0.08);
    }
}
