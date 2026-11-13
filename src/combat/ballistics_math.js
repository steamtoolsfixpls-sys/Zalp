// Pure ballistics and intersection math (no three.js, no DOM) shared by the simulation and the Node tests.
export const G = 9.81;
export const RICOCHET_COS = Math.cos(70 * Math.PI / 180);
const MIN_COS = 0.17;

export function interp(table, x) {
    const n = table.length;
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < n; i++) {
        const b = table[i];
        if (x <= b[0]) {
            const a = table[i - 1];
            return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
        }
    }
    return table[n - 1][1];
}

// mm RHA the round can defeat after flying `range` metres.
export function penetrationAt(ammo, range) {
    return interp(ammo.pen, range);
}

export function speedAtRange(ammo, range) {
    return ammo.v0 * Math.exp(-ammo.k * range);
}

export function energyJ(ammo, speed) {
    return 0.5 * ammo.mass * speed * speed;
}

// Fraction of muzzle energy left at `speed`.
export function energyFraction(ammo, speed) {
    const r = speed / ammo.v0;
    return r * r;
}

// One drag + gravity step in place on plain numbers; `s` = { x, y, z, vx, vy, vz }. Wind moves the air mass.
export function integrateStep(s, dt, k, wx, wy, wz, gravity = G) {
    const rx = s.vx - wx;
    const ry = s.vy - wy;
    const rz = s.vz - wz;
    const drag = k * Math.sqrt(rx * rx + ry * ry + rz * rz);
    s.vx -= drag * rx * dt;
    s.vy -= (drag * ry + gravity) * dt;
    s.vz -= drag * rz * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
}

// Level shot along +X from the muzzle: time of flight, vertical drop and speed when x reaches `range`.
export function flightTo(ammo, range, { wind = [0, 0, 0], elevation = 0, dt = 1 / 240 } = {}) {
    const s = { x: 0, y: 0, z: 0, vx: ammo.v0 * Math.cos(elevation), vy: ammo.v0 * Math.sin(elevation), vz: 0 };
    let t = 0;
    while (s.x < range && t < 30) {
        integrateStep(s, dt, ammo.k, wind[0], wind[1], wind[2]);
        t += dt;
    }
    return { time: t, drop: -s.y, drift: s.z, speed: Math.hypot(s.vx, s.vy, s.vz) };
}

// Result of a kinetic or shaped-charge round against a plate of `nominalMm` hit at incidence cosine `cosTheta`.
export function evaluateArmor(ammo, range, nominalMm, cosTheta, penScale = 1) {
    const pen = (ammo.heat ? interp(ammo.pen, 0) : penetrationAt(ammo, range)) * penScale;
    const c = Math.max(cosTheta, ammo.heat ? 0.5 : MIN_COS);
    const effMm = nominalMm / c;
    const ricochet = !ammo.heat && !ammo.explosive && cosTheta < RICOCHET_COS && pen < 3 * nominalMm;
    return { penMm: pen, effMm, ricochet, penetrated: !ricochet && pen >= effMm };
}

// Velocity retained after pushing through `effMm` of RHA-equivalent material with `penMm` available.
export function residualSpeedFraction(effMm, penMm) {
    if (penMm <= 0) return 0;
    const f = Math.min(1, effMm / penMm);
    return Math.sqrt(Math.max(0.12, 1 - 0.75 * f));
}

// Launch elevation (rad) for a lob that covers `dist` horizontally and `dy` vertically at `speed`; null = out of reach.
export function launchAngle(dist, dy, speed, gravity = G) {
    const v2 = speed * speed;
    const disc = v2 * v2 - gravity * (gravity * dist * dist + 2 * dy * v2);
    if (disc < 0 || dist < 1e-6) return null;
    return Math.atan((v2 - Math.sqrt(disc)) / (gravity * dist));
}

// Ray (unit direction) against a capsule; returns the distance along the ray, or -1. A start inside gives 0.
export function capsuleRay(rx, ry, rz, dx, dy, dz, ax, ay, az, bx, by, bz, radius) {
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const oax = rx - ax, oay = ry - ay, oaz = rz - az;
    const baba = bax * bax + bay * bay + baz * baz;
    const bard = bax * dx + bay * dy + baz * dz;
    const baoa = bax * oax + bay * oay + baz * oaz;
    const rdoa = dx * oax + dy * oay + dz * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    if (baba < 1e-9) return sphereRay(oax, oay, oaz, dx, dy, dz, radius);
    const a = baba - bard * bard;
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - radius * radius * baba;
    if (a > 1e-9) {
        const h = b * b - a * c;
        if (h >= 0) {
            const sq = Math.sqrt(h);
            const t = (-b - sq) / a;
            const y = baoa + t * bard;
            if (y > 0 && y < baba) return t >= 0 ? t : ((-b + sq) / a >= 0 ? 0 : -1);
            const capx = y <= 0 ? oax : rx - bx;
            const capy = y <= 0 ? oay : ry - by;
            const capz = y <= 0 ? oaz : rz - bz;
            const t2 = sphereRay(capx, capy, capz, dx, dy, dz, radius);
            if (t2 >= 0) return t2;
        }
        return -1;
    }
    // Ray parallel to the axis: only the end caps can be hit.
    const t1 = sphereRay(oax, oay, oaz, dx, dy, dz, radius);
    const t2 = sphereRay(rx - bx, ry - by, rz - bz, dx, dy, dz, radius);
    if (t1 < 0) return t2;
    if (t2 < 0) return t1;
    return Math.min(t1, t2);
}

function sphereRay(ox, oy, oz, dx, dy, dz, radius) {
    const b = dx * ox + dy * oy + dz * oz;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const h = b * b - c;
    if (h < 0) return -1;
    const sq = Math.sqrt(h);
    const t = -b - sq;
    if (t >= 0) return t;
    return -b + sq >= 0 ? 0 : -1;
}

const _o = [0, 0, 0];
const _d = [0, 0, 0];
const _h = [0, 0, 0];

// Segment (0..1) against an axis-aligned box centred on the origin. Returns 0 = miss, 1 = enters from outside,
// 2 = starts inside. out: tIn, inAxis, inSign (face normal = sign on that axis), tOut, outAxis, outSign.
export function segmentBox(x0, y0, z0, x1, y1, z1, hx, hy, hz, out) {
    _o[0] = x0; _o[1] = y0; _o[2] = z0;
    _d[0] = x1 - x0; _d[1] = y1 - y0; _d[2] = z1 - z0;
    _h[0] = hx; _h[1] = hy; _h[2] = hz;
    let tmin = 0;
    let tmax = 1;
    let axisIn = -1;
    let signIn = 0;
    let axisOut = -1;
    let signOut = 0;
    for (let i = 0; i < 3; i++) {
        const o = _o[i];
        const d = _d[i];
        const h = _h[i];
        if (Math.abs(d) < 1e-12) {
            if (o < -h || o > h) return 0;
            continue;
        }
        const ta = (-h - o) / d;
        const tb = (h - o) / d;
        const near = d > 0 ? ta : tb;
        const far = d > 0 ? tb : ta;
        if (near > tmin) {
            tmin = near;
            axisIn = i;
            signIn = d > 0 ? -1 : 1;
        }
        if (far < tmax) {
            tmax = far;
            axisOut = i;
            signOut = d > 0 ? 1 : -1;
        }
        if (tmin > tmax) return 0;
    }
    out.tIn = tmin;
    out.inAxis = axisIn;
    out.inSign = signIn;
    out.tOut = tmax;
    out.outAxis = axisOut;
    out.outSign = signOut;
    return axisIn === -1 ? 2 : 1;
}

// Armour face and component of a hit in vehicle-local coordinates.
// normal axis 0 = X (side), 1 = Y (top / bottom), 2 = Z (front -Z / rear +Z).
export function faceOf(axis, sign) {
    if (axis === 0) return 'side';
    if (axis === 1) return 'top';
    return sign < 0 ? 'front' : 'rear';
}

// Where a shot came from relative to the way a turret points: 'front' | 'side' | 'rear'. Yaw 0 looks along -Z.
export function turretFace(turretYaw, dirX, dirZ) {
    const fx = -Math.sin(turretYaw);
    const fz = -Math.cos(turretYaw);
    const len = Math.hypot(dirX, dirZ) || 1;
    const cos = (-dirX * fx - dirZ * fz) / len;
    if (cos > 0.7071) return 'front';
    if (cos < -0.7071) return 'rear';
    return 'side';
}
