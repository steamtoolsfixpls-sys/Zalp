// Armour and material tables (pure data, no three.js). Thickness is mm of rolled homogeneous armour (kinetic
// equivalent) at normal incidence; `heatMul` scales it against shaped charges.
export const SURFACE_COLORS = {
    dirt: 0x8a7962, concrete: 0x9a9a94, metal: 0xffaa33, wood: 0xb08a5a, sandbag: 0xa8976a, glass: 0xcfe6ee, foliage: 0x4f7a3a
};

// RHA-mm of resistance per mm of material, used for `userData.penetrable = { mm, material }` wall-bang.
export const MATERIAL_RESIST = {
    wood: 0.03, plywood: 0.045, crate: 0.06, sheet_metal: 0.8, metal: 0.8, foliage: 0.004, glass: 0.12, sandbag: 0.18, concrete: 0.9
};

const face = (front, side, rear, top) => ({ front, side, rear, top });

// deck: height of the hull deck as a fraction of the hit-proxy box; hits above it count as turret.
// era: bricks of explosive reactive armour per zone, `cell` metres each, `coverage` = share of cells fitted.
export const ARMOR = {
    t90m_ru: {
        hull: face(650, 110, 70, 40), turret: face(780, 380, 200, 70), deck: 0.56, heatMul: 1.15, blast: 0.1,
        era: { type: 'relikt', zones: ['turret_front', 'turret_side', 'hull_front', 'hull_side'], cell: 0.3, coverage: 1 }
    },
    t72b3_ru: {
        hull: face(560, 80, 70, 45), turret: face(520, 280, 150, 60), deck: 0.56, heatMul: 1.1, blast: 0.12,
        era: { type: 'kontakt5', zones: ['turret_front', 'hull_front', 'hull_side'], cell: 0.3, coverage: 1 }
    },
    btr80_ru: { hull: face(9, 7, 7, 6), turret: face(10, 8, 7, 6), deck: 0.72, heatMul: 1, blast: 0.55, era: null },
    bmp2_ua: { hull: face(19, 16, 16, 6), turret: face(23, 19, 19, 8), deck: 0.66, heatMul: 1, blast: 0.6, era: null },
    bradley_ua: { hull: face(30, 25, 20, 8), turret: face(32, 25, 20, 10), deck: 0.68, heatMul: 1, blast: 0.55, era: null },
    humvee_ua: { hull: face(8, 7, 6, 4), turret: null, deck: 1, heatMul: 1, blast: 0.8, era: null },
    uaz452: { hull: face(1.5, 1.5, 1.5, 1.5), turret: null, deck: 1, heatMul: 1, blast: 1, era: null }
};

export const DEFAULT_ARMOR = { hull: face(20, 15, 12, 8), turret: null, deck: 1, heatMul: 1, blast: 0.6, era: null };

export function armorFor(vehicleKey) {
    return ARMOR[vehicleKey] || DEFAULT_ARMOR;
}
