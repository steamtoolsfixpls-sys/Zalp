// Real combat masses and drivetrain tuning. Pure data and math, shared by the main thread and the worker.
// The world runs at 2 g (see GRAVITY): rolling resistance and first-gear tractive effort are tuned against it.
export const GRAVITY = 19.62;

const CURVE_X = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.06];
const CURVE_T = [0.55, 0.78, 0.96, 1.0, 0.95, 0.86, 0];
const POWER_PEAK = 0.86;    // max of torque(x) * x, reached at the redline

// Normalized engine torque over rpm / rpmMax: lugging below 40 %, peak at 60 %, hard cut past the redline.
export function torqueAt(x) {
    if (x <= 0) return CURVE_T[0];
    for (let i = 1; i < CURVE_X.length; i++) {
        if (x <= CURVE_X[i]) {
            const f = (x - CURVE_X[i - 1]) / (CURVE_X[i] - CURVE_X[i - 1]);
            return CURVE_T[i - 1] + (CURVE_T[i] - CURVE_T[i - 1]) * f;
        }
    }
    return 0;
}

// mass kg, powerKw at the flywheel, top / reverse speed km/h, track = half distance between wheel or
// track centres (m), axles = suspension station z (m, negative is forward), hullZ = front and rear end of
// the hull (the mesh origin is the bounding box centre, which a long gun pulls ahead of the hull centre),
// wheelR = road wheel radius; all four are measured on the rigged models (tools/vehicle-rig.mjs),
// freq / damp = suspension natural frequency (Hz) and damping ratio, comY = centre of mass above ground.
const TABLE = {
    t90m_ru: {
        mass: 46000, powerKw: 840, rpmIdle: 800, rpmMax: 2000, gears: 7, topKmh: 61, reverseKmh: 9, shift: 0.42,
        track: 1.31, axles: [-0.87, 0.43, 1.73, 3.03], hullZ: [-2.0, 4.55], wheelR: 0.36, freq: 1.75, damp: 0.62, comY: 1.0, pivotRate: 0.7,
        tractive: 0.6
    },
    t72b3_ru: {
        mass: 46000, powerKw: 843, rpmIdle: 800, rpmMax: 2000, gears: 7, topKmh: 60, reverseKmh: 9, shift: 0.45,
        track: 1.3, axles: [-0.95, 0.34, 1.63, 2.92], hullZ: [-1.96, 4.45], wheelR: 0.34, freq: 1.75, damp: 0.62, comY: 1.0, pivotRate: 0.68,
        tractive: 0.6
    },
    bradley_ua: {
        mass: 30000, powerKw: 447, rpmIdle: 750, rpmMax: 2600, gears: 5, topKmh: 61, reverseKmh: 16, shift: 0.3,
        track: 1.08, axles: [-1.95, -0.76, 0.44, 1.63], hullZ: [-3.2, 3.25], wheelR: 0.27, freq: 1.8, damp: 0.6, comY: 1.05, pivotRate: 0.8,
        tractive: 0.42
    },
    bmp2_ua: {
        mass: 14000, powerKw: 221, rpmIdle: 800, rpmMax: 2600, gears: 5, topKmh: 65, reverseKmh: 9, shift: 0.4,
        track: 1.28, axles: [-1.37, -0.24, 0.89, 2.02], hullZ: [-3.3, 3.3], wheelR: 0.3, freq: 1.9, damp: 0.58, comY: 0.9, pivotRate: 0.9,
        tractive: 0.42
    },
    btr80_ru: {
        mass: 13600, powerKw: 191, rpmIdle: 700, rpmMax: 2600, gears: 5, topKmh: 80, reverseKmh: 13, shift: 0.5,
        track: 1.21, axles: [-2.14, -0.67, 1.05, 2.4], hullZ: [-3.75, 3.75], steer: [1, 0.62, 0, 0], wheelR: 0.62, freq: 1.9, damp: 0.52,
        comY: 1.05, steerMax: 0.45, tireDrop: 0.24, tractive: 0.36, dragArea: 4.6
    },
    humvee_ua: {
        mass: 3500, powerKw: 142, rpmIdle: 700, rpmMax: 3400, gears: 4, topKmh: 105, reverseKmh: 22, shift: 0.3,
        track: 0.94, axles: [-1.87, 1.32], hullZ: [-2.4, 2.4], steer: [1, 0], wheelR: 0.43, freq: 2.1, damp: 0.56, comY: 0.8, tireDrop: 0.2,
        tractive: 0.3
    },
    uaz452: {
        mass: 2000, powerKw: 82, rpmIdle: 800, rpmMax: 4000, gears: 4, topKmh: 95, reverseKmh: 18, shift: 0.45,
        track: 0.69, axles: [-1.09, 1.14], hullZ: [-2.0, 2.0], steer: [1, 0], wheelR: 0.365, freq: 2.2, damp: 0.56, comY: 0.8, tireDrop: 0.16,
        tractive: 0.3
    }
};

const cache = new Map();

// Resolved tuning for a STATS.VEHICLE_SPECS entry (only key, driveType, halfExtents and mass are read).
// Unknown vehicles get a table row derived from their spec, with the placeholder mass scaled to tonnes.
export function getVehicleTuning(spec) {
    const cached = cache.get(spec.key);
    if (cached) return cached;
    const tracked = spec.driveType === 'TRACKED';
    const [hx, hy, hz] = spec.halfExtents;
    const row = TABLE[spec.key] || {
        mass: (spec.mass || 3000) * 10, powerKw: (spec.mass || 3000) * 0.15, rpmIdle: 800, rpmMax: 2600,
        gears: 5, topKmh: tracked ? 60 : 90, reverseKmh: 12, shift: 0.4, track: hx * 0.8,
        axles: tracked || spec.driveType === 'WHEELED_8X8' ? [-0.58 * hz, -0.19 * hz, 0.19 * hz, 0.58 * hz] : [-0.68 * hz, 0.68 * hz],
        steer: tracked ? null : (spec.driveType === 'WHEELED_8X8' ? [1, 0.62, 0, 0] : [1, 0]),
        wheelR: tracked ? 0.33 : 0.45, freq: 1.9, damp: 0.55, comY: 0.95
    };

    const weight = row.mass * GRAVITY;
    const eff = tracked ? 0.72 : 0.8;
    const top = row.topKmh / 3.6;
    // First gear is sized for its peak tractive effort as a fraction of weight; the rest spread geometrically.
    const tractive = row.tractive || 0.5;
    const first = Math.min(top * 0.45, (row.powerKw * 1000 * eff) / (POWER_PEAK * tractive * weight));
    const ratio = Math.pow(top / first, 1 / (row.gears - 1));
    const gearTop = [];
    for (let i = 0; i < row.gears; i++) gearTop.push(first * Math.pow(ratio, i));
    const reverseTop = row.reverseKmh / 3.6;

    const originY = Math.max(1.0, hy * 1.2);    // body origin above the ground at static ride height
    const rayTop = 0.95;
    const omega = 2 * Math.PI * row.freq;
    const sag = GRAVITY / (omega * omega);
    const count = row.axles.length * 2;
    const perWheel = row.mass / count;
    const points = [];
    row.axles.forEach((z, axle) => {
        for (let side = 0; side < 2; side++) {
            points.push({
                x: side === 0 ? -row.track : row.track, y: rayTop - originY, z,
                side, axle, steer: row.steer ? row.steer[axle] : 0, driven: true
            });
        }
    });

    const hullBottom = 0.62;
    const hullTop = Math.max(hy * 2.0, 1.7);
    const bx = hx * 0.9;
    const hullZ = row.hullZ || [-hz * 0.93, hz * 0.93];
    const zc = (hullZ[0] + hullZ[1]) * 0.5;
    const bz = (hullZ[1] - hullZ[0]) * 0.5 * 0.97;
    const mid = hullBottom + 0.45;
    const hull = [];
    // Boat-shaped convex hull: the chamfered belly slides over kerbs and debris instead of snagging on them.
    for (const [x, y, z] of [[bx, hullTop, bz], [bx, mid, bz], [bx * 0.86, hullBottom, bz - 0.85]]) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) hull.push(sx * x, y - originY, zc + sz * z);
    }
    const W = bx * 2;
    const H = hullTop - hullBottom;
    const L = bz * 2;

    const steerAxles = row.steer ? row.axles.filter((_, i) => row.steer[i] > 0) : [];
    const fixedAxles = row.steer ? row.axles.filter((_, i) => !(row.steer[i] > 0)) : [];
    const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

    const tuning = {
        key: spec.key,
        tracked,
        mass: row.mass,
        originY,
        comLocalY: row.comY - originY,
        comLocalZ: row.axles.reduce((s, z) => s + z, 0) / row.axles.length,
        hull: new Float32Array(hull),
        hullHalf: [bx, H * 0.5, bz],
        hullCenterY: (hullTop + hullBottom) * 0.5 - originY,
        hullCenterZ: zc,
        inertia: [row.mass / 12 * (H * H + L * L), row.mass / 12 * (W * W + L * L), row.mass / 12 * (W * W + H * H) * 1.3],
        angularDamping: 0.6,
        points,
        track: row.track,
        wheelR: row.wheelR,
        rest: rayTop + sag,
        sag,
        k: perWheel * omega * omega,
        c: 2 * row.damp * perWheel * omega,
        nMax: perWheel * GRAVITY * 2.8,
        travel: 0.3,
        droop: 0.22,
        climbRate: 5,
        tireDrop: row.tireDrop || 0.2,
        flatRoll: 0.25,
        // drivetrain
        torquePeak: (row.powerKw * 1000) / (POWER_PEAK * row.rpmMax * Math.PI / 30),
        rpmIdle: row.rpmIdle,
        rpmMax: row.rpmMax,
        eff,
        gearTop,
        gearK: gearTop.map((v) => row.rpmMax / v),
        reverseTop,
        reverseK: row.rpmMax / reverseTop,
        shiftTime: row.shift,
        upFrac: 0.93,
        downFrac: 0.68,
        topSpeed: top,
        // contact patch
        muLong: tracked ? 0.95 : 0.9,
        muLat: tracked ? 0.7 : 0.95,
        latGain: tracked ? 6 : 11,
        rollRes: tracked ? 0.014 : 0.009,
        engineBrake: tracked ? 0.35 : 0.25,
        brakeDecel: tracked ? 7.5 : 9,
        dragArea: row.dragArea || (tracked ? 5.0 : row.mass > 8000 ? 5.5 : row.mass > 3000 ? 3.0 : 2.2),
        // steering
        steerMax: row.steerMax || 0.55,
        steerRate: 1.7,
        wheelbase: row.steer ? Math.max(1.5, mean(fixedAxles) - mean(steerAxles)) : 0,
        latAccMax: tracked ? 6.0 : 6.5,
        pivotRate: row.pivotRate || 0.8,
        steerGain: 20,
        steerMoment: 0.8 * weight * row.track
    };
    cache.set(spec.key, tuning);
    return tuning;
}
