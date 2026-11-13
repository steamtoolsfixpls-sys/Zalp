import test from 'node:test';
import assert from 'node:assert/strict';
import { AMMO, ammoForVehicle, WEAPON_AMMO } from '../src/combat/ammo_data.js';
import { ARMOR, armorFor, MATERIAL_RESIST } from '../src/combat/armor_data.js';
import {
    penetrationAt, speedAtRange, energyJ, flightTo, evaluateArmor, capsuleRay, segmentBox, launchAngle,
    turretFace, faceOf, residualSpeedFraction, integrateStep, G
} from '../src/combat/ballistics_math.js';

const cosDeg = (d) => Math.cos(d * Math.PI / 180);

test('5.45 takes measurable time to 100 m, drops and loses speed', () => {
    const f = flightTo(AMMO['5.45x39'], 100);
    assert.ok(f.time > 0.1 && f.time < 0.13, `time ${f.time}`);
    assert.ok(f.drop > 0.04 && f.drop < 0.08, `drop ${f.drop}`);
    assert.ok(f.speed < 840 && f.speed > 780, `speed ${f.speed}`);
    const far = flightTo(AMMO['5.45x39'], 400);
    assert.ok(far.drop > 0.9 && far.drop < 1.8, `drop at 400 m ${far.drop}`);
});

test('closed form speed agrees with the integrated flight', () => {
    const a = AMMO['7.62x54R'];
    const f = flightTo(a, 300);
    assert.ok(Math.abs(f.speed - speedAtRange(a, 300)) < 8, `${f.speed} vs ${speedAtRange(a, 300)}`);
});

test('wind pushes the round sideways, a stronger wind pushes further', () => {
    const calm = flightTo(AMMO['5.45x39'], 300).drift;
    const wind = flightTo(AMMO['5.45x39'], 300, { wind: [0, 0, 5] }).drift;
    const gale = flightTo(AMMO['5.45x39'], 300, { wind: [0, 0, 10] }).drift;
    assert.equal(calm, 0);
    assert.ok(wind > 0.1 && gale > wind * 1.8, `${wind} ${gale}`);
});

test('energy falls with range and heavier rounds carry far more', () => {
    const a = AMMO['5.45x39'];
    assert.ok(energyJ(a, speedAtRange(a, 200)) < energyJ(a, a.v0) * 0.7);
    assert.ok(energyJ(AMMO['14.5x114'], 976) > energyJ(a, 900) * 20);
});

test('penetration decreases with range and is interpolated', () => {
    const a = AMMO['5.45x39'];
    assert.ok(penetrationAt(a, 0) > penetrationAt(a, 100));
    assert.ok(penetrationAt(a, 100) > penetrationAt(a, 200));
    assert.equal(penetrationAt(a, 150), (7.2 + 5.5) / 2);
    assert.equal(penetrationAt(a, 5000), 1.2);
});

test('BTR-80 side: 5.45 fails at 200 m, 14.5 and APFSDS go through', () => {
    const side = ARMOR.btr80_ru.hull.side;
    assert.equal(evaluateArmor(AMMO['5.45x39'], 200, side, 1).penetrated, false);
    assert.equal(evaluateArmor(AMMO['14.5x114'], 200, side, 1).penetrated, true);
    assert.equal(evaluateArmor(AMMO['125APFSDS'], 200, side, 1).penetrated, true);
});

test('UAZ-452 sheet metal is penetrated by every calibre', () => {
    const mm = ARMOR.uaz452.hull.side;
    for (const id of ['5.45x39', '5.56x45', '7.62x54R', '12.7x99', '14.5x114', '30AP']) {
        assert.equal(evaluateArmor(AMMO[id], 100, mm, 1).penetrated, true, id);
    }
});

test('T-90M turret front stops 30 mm, the 125 mm sabot, PG-7VL and even PG-7VR', () => {
    const a = armorFor('t90m_ru');
    const front = a.turret.front;
    assert.equal(evaluateArmor(AMMO['30AP'], 100, front, 1).penetrated, false);
    assert.equal(evaluateArmor(AMMO['125APFSDS'], 500, front, 1).penetrated, false);
    assert.equal(evaluateArmor(AMMO.PG7VL, 50, front * a.heatMul, 1).penetrated, false);
    assert.equal(evaluateArmor(AMMO.PG7VR, 50, front * a.heatMul, 1).penetrated, false);
});

test('PG-7VL goes through the side of a T-72B3 once the reactive brick is gone', () => {
    const a = armorFor('t72b3_ru');
    assert.equal(evaluateArmor(AMMO.PG7VL, 50, a.hull.side * a.heatMul, 1).penetrated, true);
    assert.ok(a.era && a.era.zones.includes('hull_side'));
});

test('shallow hits ricochet unless the round overmatches the plate', () => {
    const btrFront = ARMOR.btr80_ru.hull.front;
    const shallow = evaluateArmor(AMMO['5.45x39'], 50, btrFront, cosDeg(78));
    assert.equal(shallow.ricochet, true);
    assert.equal(shallow.penetrated, false);
    assert.equal(evaluateArmor(AMMO['5.45x39'], 50, btrFront, cosDeg(60)).ricochet, false);
    assert.equal(evaluateArmor(AMMO['14.5x114'], 50, ARMOR.btr80_ru.hull.side, cosDeg(78)).ricochet, false);
    const tank = evaluateArmor(AMMO['30AP'], 300, ARMOR.t90m_ru.hull.side, cosDeg(80));
    assert.equal(tank.ricochet, true);
});

test('a steeper hit needs more penetration (line-of-sight thickness)', () => {
    const flat = evaluateArmor(AMMO['14.5x114'], 100, 30, 1);
    const slope = evaluateArmor(AMMO['14.5x114'], 100, 30, cosDeg(50));
    assert.ok(slope.effMm > flat.effMm * 1.5);
    assert.equal(flat.penetrated, true);
    assert.equal(slope.penetrated, false);
});

test('wall-bang materials: wood and crates are thin, sandbags stop rifle rounds', () => {
    const pen = penetrationAt(AMMO['5.45x39'], 50);
    assert.ok(25 * MATERIAL_RESIST.wood < pen);
    assert.ok(300 * MATERIAL_RESIST.crate < pen * 4);
    assert.ok(400 * MATERIAL_RESIST.sandbag > pen);
    assert.ok(residualSpeedFraction(2, 8) < 1 && residualSpeedFraction(2, 8) > 0.7);
    assert.ok(residualSpeedFraction(8, 8) < 0.6);
});

test('weapons and vehicles map to ammunition', () => {
    for (const id of Object.values(WEAPON_AMMO)) assert.ok(AMMO[id], id);
    assert.equal(ammoForVehicle('btr80_ru').id, '14.5x114');
    assert.equal(ammoForVehicle('t90m_ru', 'AP').id, '125APFSDS');
    assert.equal(ammoForVehicle('t90m_ru').id, '125HE');
    assert.equal(ammoForVehicle('bmp2_ua', 'HE').id, '30HE');
});

test('capsuleRay hits the body, the caps, and misses', () => {
    const hit = capsuleRay(0, 1, -5, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0.3);
    assert.ok(Math.abs(hit - 4.7) < 1e-9, `${hit}`);
    const cap = capsuleRay(0, 5, 0, 0, -1, 0, 0, 0, 0, 0, 2, 0, 0.3);
    assert.ok(Math.abs(cap - 2.7) < 1e-9, `${cap}`);
    assert.equal(capsuleRay(1, 1, -5, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0.3), -1);
    assert.equal(capsuleRay(0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0.3), 0);
});

test('segmentBox reports entry face, exit face and the inside case', () => {
    const out = {};
    assert.equal(segmentBox(-5, 0, 0, 5, 0, 0, 1, 1, 1, out), 1);
    assert.ok(Math.abs(out.tIn - 0.4) < 1e-9 && out.inAxis === 0 && out.inSign === -1);
    assert.ok(Math.abs(out.tOut - 0.6) < 1e-9 && out.outAxis === 0 && out.outSign === 1);
    assert.equal(segmentBox(-5, 3, 0, 5, 3, 0, 1, 1, 1, out), 0);
    assert.equal(segmentBox(0, 0, 0, 5, 0, 0, 1, 1, 1, out), 2);
    assert.equal(segmentBox(0, 5, 0, 0, -5, 0, 1, 1, 1, out), 1);
    assert.equal(out.inAxis, 1);
    assert.equal(out.inSign, 1);
});

test('faces: front is -Z, turret facing follows its yaw', () => {
    assert.equal(faceOf(2, -1), 'front');
    assert.equal(faceOf(2, 1), 'rear');
    assert.equal(faceOf(0, 1), 'side');
    // Turret looking along -Z; a shot travelling +Z comes from the front.
    assert.equal(turretFace(0, 0, 1), 'front');
    assert.equal(turretFace(0, 0, -1), 'rear');
    assert.equal(turretFace(0, 1, 0), 'side');
    // Turret traversed 90 degrees left (looks along -X): a shot travelling +X comes from its front.
    assert.equal(turretFace(Math.PI / 2, 1, 0), 'front');
});

test('lob angle reaches the target and rejects out-of-range throws', () => {
    const a = launchAngle(20, 0, 18);
    assert.ok(a > 0 && a < Math.PI / 4);
    const range = 18 * 18 * Math.sin(2 * a) / G;
    assert.ok(Math.abs(range - 20) < 0.01);
    assert.equal(launchAngle(200, 0, 18), null);
});

test('integrateStep conserves speed without drag and gravity', () => {
    const s = { x: 0, y: 0, z: 0, vx: 10, vy: 0, vz: 0 };
    for (let i = 0; i < 100; i++) integrateStep(s, 0.01, 0, 0, 0, 0, 0);
    assert.ok(Math.abs(s.x - 10) < 1e-9 && s.vx === 10);
});
