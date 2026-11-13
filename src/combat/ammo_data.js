// Ammunition tables (pure data, no three.js): mass kg, muzzle velocity m/s, drag coefficient k in 1/m
// (deceleration = k * |v| * v), penetration in mm of rolled homogeneous armour versus distance flown,
// damage against soldiers, hull damage on penetration and warhead flags.
export const AMMO = {};

function def(id, spec) {
    AMMO[id] = Object.freeze({ id, impactMass: 0.04, vehDamage: 1, damage: 30, tracer: null, ...spec });
}

// --- small arms
def('5.45x39', {
    name: '5.45x39 7Н6', caliber: 5.45, mass: 0.0034, v0: 900, k: 0.00105, kind: 'ball',
    pen: [[0, 9], [100, 7.2], [200, 5.5], [400, 3.4], [800, 1.2]], damage: 36, vehDamage: 1.5, impactMass: 0.042, tracer: 'faction'
});
def('5.56x45', {
    name: '5.56x45 M855', caliber: 5.56, mass: 0.004, v0: 940, k: 0.00115, kind: 'ball',
    pen: [[0, 8], [100, 6.5], [200, 5], [400, 3], [800, 1]], damage: 34, vehDamage: 1.5, impactMass: 0.04, tracer: 'faction'
});
def('7.62x54R', {
    name: '7.62x54R ЛПС', caliber: 7.62, mass: 0.0096, v0: 820, k: 0.0006, kind: 'ball',
    pen: [[0, 12], [100, 10.5], [300, 8], [600, 5]], damage: 54, vehDamage: 3, impactMass: 0.09, tracer: 'faction'
});
def('12.7x99', {
    name: '12.7x99 M33', caliber: 12.7, mass: 0.043, v0: 890, k: 0.00045, kind: 'ap',
    pen: [[0, 20], [500, 15], [1000, 10], [2000, 4]], damage: 72, vehDamage: 10, impactMass: 0.22, tracer: 0xffaa22
});
def('14.5x114', {
    name: '14.5x114 БЗТ', caliber: 14.5, mass: 0.064, v0: 976, k: 0.00038, kind: 'ap',
    pen: [[0, 32], [100, 30], [300, 26], [500, 22], [1000, 14], [2000, 6]], damage: 90, vehDamage: 20, impactMass: 0.32, tracer: 0xffaa22
});

// --- autocannons
def('25x137', {
    name: '25x137 M791 APDS-T', caliber: 25, mass: 0.134, v0: 1345, k: 0.00028, kind: 'ap',
    pen: [[0, 55], [500, 42], [1000, 32], [2000, 18]], damage: 110, vehDamage: 34, impactMass: 0.5, tracer: 0xffaa22
});
def('30AP', {
    name: '30x165 3УБР8 БПТ', caliber: 30, mass: 0.37, v0: 970, k: 0.00026, kind: 'ap',
    pen: [[0, 75], [500, 62], [1000, 48], [2000, 30]], damage: 120, vehDamage: 42, impactMass: 0.6, tracer: 0xffaa22
});
def('30HE', {
    name: '30x165 3УОР6 ОФ', caliber: 30, mass: 0.39, v0: 960, k: 0.00028, kind: 'he', explosive: true,
    pen: [[0, 14], [1000, 6]], damage: 80, vehDamage: 20, impactMass: 0.6, tracer: 0xffaa22,
    blast: { radius: 3.4, force: 14, damage: 70 }
});

// --- 125 mm
def('125APFSDS', {
    name: '125 мм 3БМ42 БПС', caliber: 125, mass: 4.85, v0: 1750, k: 0.00007, kind: 'apfsds',
    pen: [[0, 650], [1000, 620], [2000, 590], [3000, 550]], damage: 450, vehDamage: 650, impactMass: 2.0, tracer: 0xffaa22
});
def('125HE', {
    name: '125 мм 3ОФ26 ОФС', caliber: 125, mass: 23, v0: 850, k: 0.00008, kind: 'he', explosive: true,
    pen: [[0, 40], [2000, 30]], damage: 300, vehDamage: 90, impactMass: 2.0, tracer: 0xffaa22, blast: { fromSpec: true }
});
def('125HEAT', {
    name: '125 мм 3БК29 КС', caliber: 125, mass: 19, v0: 905, k: 0.00008, kind: 'heat', explosive: true, heat: true,
    pen: [[0, 750], [3000, 750]], damage: 300, vehDamage: 700, impactMass: 2.0, tracer: 0xffaa22,
    blast: { radius: 6, force: 40, damage: 200 }
});

// --- shoulder-fired and drone warheads
def('PG7VL', {
    name: 'ПГ-7ВЛ', caliber: 93, mass: 2.6, v0: 115, k: 0.0001, kind: 'heat', explosive: true, heat: true, tandem: false,
    rocket: { vMax: 300, delay: 0.08, accel: 750 }, gravity: 1,
    pen: [[0, 500], [1000, 500]], damage: 360, vehDamage: 520, impactMass: 2.6, tracer: null, blast: { fromWeapon: true }
});
def('PG7VR', {
    name: 'ПГ-7ВР (тандем)', caliber: 105, mass: 4.5, v0: 112, k: 0.0001, kind: 'heat', explosive: true, heat: true, tandem: true,
    rocket: { vMax: 280, delay: 0.08, accel: 700 }, gravity: 1,
    pen: [[0, 750], [1000, 750]], damage: 380, vehDamage: 600, impactMass: 4.5, tracer: null, blast: { fromWeapon: true }
});
def('FPV_RKG3', {
    name: 'FPV РКГ-3', caliber: 70, mass: 1.1, v0: 30, k: 0, kind: 'heat', explosive: true, heat: true, tandem: false,
    pen: [[0, 220], [1000, 220]], damage: 300, vehDamage: 260, impactMass: 1.1, blast: { radius: 6, force: 40, damage: 220 }
});
def('FPV_HE', {
    name: 'FPV ОФ', caliber: 70, mass: 1.4, v0: 30, k: 0, kind: 'he', explosive: true,
    pen: [[0, 40], [1000, 40]], damage: 300, vehDamage: 120, impactMass: 1.4, blast: { radius: 8, force: 54, damage: 320 }
});
def('VOG17', {
    name: 'ВОГ-17', caliber: 30, mass: 0.28, v0: 185, k: 0.0012, kind: 'he', explosive: true,
    pen: [[0, 10]], damage: 120, vehDamage: 15, impactMass: 0.3, blast: { radius: 5.5, force: 20, damage: 110 }
});

// --- hand grenades and fragments
def('F1', {
    name: 'Ф-1', caliber: 55, mass: 0.6, v0: 18, k: 0, kind: 'grenade', explosive: true, fuse: [3.2, 4.0],
    pen: [[0, 20]], damage: 160, vehDamage: 35, impactMass: 0.6,
    blast: { radius: 3.8, force: 16, damage: 150 }, fragments: 56, fragRange: 30
});
def('RGD5', {
    name: 'РГД-5', caliber: 58, mass: 0.31, v0: 20, k: 0, kind: 'grenade', explosive: true, fuse: [3.2, 3.8],
    pen: [[0, 10]], damage: 110, vehDamage: 20, impactMass: 0.31,
    blast: { radius: 3.0, force: 12, damage: 100 }, fragments: 44, fragRange: 24
});
def('FRAG', {
    name: 'осколок', caliber: 6, mass: 0.003, v0: 1100, k: 0.004, kind: 'frag',
    pen: [[0, 3.2], [10, 2], [25, 0.8]], damage: 26, vehDamage: 0.5, impactMass: 0.01, tracer: null
});

export const MINES = {
    TM62: {
        id: 'TM62', name: 'ТМ-62М', mass: 9.0, minTriggerMass: 150, armDelay: 1.2, radius: 0.55,
        blast: { radius: 5.5, force: 60, damage: 420 }, vehDamage: 480
    }
};

// STATS.WEAPONS id -> ammunition id.
export const WEAPON_AMMO = {
    ak12: '5.45x39',
    ak74m: '5.45x39',
    m4a1: '5.56x45',
    rpg7: 'PG7VL'
};

// Vehicle spec key -> ammunition by shell type ('default' when the caller gives none or an unknown type).
export const VEHICLE_AMMO = {
    t90m_ru: { default: '125HE', HE: '125HE', AP: '125APFSDS', APFSDS: '125APFSDS', HEAT: '125HEAT' },
    t72b3_ru: { default: '125HE', HE: '125HE', AP: '125APFSDS', APFSDS: '125APFSDS', HEAT: '125HEAT' },
    btr80_ru: { default: '14.5x114' },
    bmp2_ua: { default: '30AP', AP: '30AP', HE: '30HE' },
    bradley_ua: { default: '25x137' },
    humvee_ua: { default: '12.7x99' },
    uaz452: { default: '7.62x54R' }
};

export function ammoForVehicle(vehicleKey, shellType) {
    const table = VEHICLE_AMMO[vehicleKey];
    if (!table) return AMMO['7.62x54R'];
    return AMMO[table[shellType] || table.default];
}
