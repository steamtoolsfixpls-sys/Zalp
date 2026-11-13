import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerPose, DURATION, NOMINAL_SPEED, LOWER_STATES } from '../src/anim/clips.js';
import { WEAPONS, HOLDS } from '../src/anim/weapons.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('gait cycles loop seamlessly', () => {
    for (const kind of ['walk', 'run', 'crouchWalk', 'idle']) {
        const a = lowerPose(kind, 0);
        const b = lowerPose(kind, 1);
        for (const side of ['L', 'R']) {
            assert.ok(near(a.legs[side].t, b.legs[side].t), `${kind} thigh`);
            assert.ok(near(a.legs[side].s, b.legs[side].s), `${kind} shin`);
        }
        assert.ok(near(a.hips.rot[1], b.hips.rot[1]), `${kind} hips yaw`);
    }
});

test('the two legs are half a cycle apart', () => {
    for (const kind of ['walk', 'run']) {
        for (const u of [0, 0.13, 0.4, 0.77]) {
            const a = lowerPose(kind, u);
            const b = lowerPose(kind, (u + 0.5) % 1);
            assert.ok(near(a.legs.L.t, b.legs.R.t, 1e-9), `${kind} ${u}`);
            assert.ok(near(a.legs.L.s, b.legs.R.s, 1e-9), `${kind} ${u}`);
        }
    }
});

test('knees bend most in mid swing and stay modest on the stance leg', () => {
    for (const kind of ['walk', 'run']) {
        const flex = (u) => { const p = lowerPose(kind, u).legs.L; return p.t - p.s; };
        assert.ok(flex(0.75) > flex(0.0) + 0.5, `${kind}: swing ${flex(0.75)} vs heel strike ${flex(0)}`);
        assert.ok(flex(0.75) > flex(0.25));
    }
});

test('stride amplitude matches the nominal speed', () => {
    // The stance foot is planted while the hips cover its front-to-back excursion in half a cycle.
    const leg = 0.88;
    for (const kind of ['walk', 'run']) {
        let max = -9;
        let min = 9;
        for (let i = 0; i < 64; i++) {
            const t = lowerPose(kind, i / 64).legs.L.t;
            max = Math.max(max, t);
            min = Math.min(min, t);
        }
        const step = leg * (Math.sin(max) - Math.sin(min));
        const speed = 2 * step / DURATION[kind];
        assert.ok(Math.abs(speed - NOMINAL_SPEED[kind]) / NOMINAL_SPEED[kind] < 0.3, `${kind}: stride speed ${speed.toFixed(2)} vs ${NOMINAL_SPEED[kind]}`);
    }
});

test('every lower state has a duration and a pose', () => {
    for (const k of LOWER_STATES) {
        assert.ok(DURATION[k] > 0);
        const p = lowerPose(k, 0.3);
        assert.ok(p.legs.L && p.legs.R && p.hips && p.spine && p.chest && p.head, k);
    }
});

test('sitting puts the pelvis near the seat and the knees up', () => {
    const p = lowerPose('sit', 0);
    assert.ok(p.hips.y > 0.1 && p.hips.y < 0.3);
    assert.ok(p.legs.L.t > Math.PI / 2, 'thigh above horizontal');
    assert.ok(p.legs.L.s < 0, 'shin points back and down');
});

test('weapons have grips and rifle holds are mirrored for the left-hand rider', () => {
    for (const k of Object.keys(WEAPONS)) {
        const w = WEAPONS[k];
        assert.equal(w.grip.length, 3);
        assert.equal(w.handguard.length, 3);
        assert.ok(w.span > 0.5);
    }
    assert.ok(near(HOLDS.sitL.g[0], -HOLDS.sitR.g[0]));
    assert.ok(near(HOLDS.sitL.yaw, -HOLDS.sitR.yaw));
});
