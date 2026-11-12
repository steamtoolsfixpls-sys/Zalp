#!/usr/bin/env node
// Vehicle part split: turns a vehicle GLB merged by material into a rig the game can animate.
//   node tools/vehicle-rig.mjs [--in individual_models] [--out individual_models] [--only key] [--debug dir] [--dry]
// Also called from tools/optimize-assets.mjs as rigVehicle(doc, key).
//
// Steps: bake the per-vehicle orientation fix and the runtime normalization (AssetManager._fill) so the
// file is in the vehicle frame (metres, origin on the ground under the hull centre, forward -Z); split the
// geometry into connected islands; classify islands (per triangle when an island spans regions) into
// hull / turret / gun / wheels / tracks by the per-vehicle rules below; emit
//   root (extras.rig) -> hull mesh, `turret` pivot -> `gun` pivot, `wheel_<i>` pivots, `track_l|r`
// where pivots are empty nodes with mesh children and carry extras.part. `--debug` renders every split
// (parts tinted, turret yawed 60 degrees, gun elevated 15 degrees, front wheels steered) as PNG sheets.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const D2R = Math.PI / 180;
const HULL = 0, TURRET = 1, GUN = 2, TRACK_L = 3, TRACK_R = 4, WHEEL = 10;

// Per-vehicle rules, in the vehicle frame (x right, y up, z back; the vehicle faces -Z).
//   yaw / skinFixX   degrees that turn the source model to face -Z (skinFixX: skinned chunks only)
//   turret           box [[min], [max]] holding the turret, or materials / skin joints that mark it;
//                    ring = [x, z] of the traverse axis, deck = pivot height, traverse deg/s
//   gun              box of the barrel and mantlet (islands of the turret inside it), trunnion [y, z],
//                    elevation limits in degrees, recoil travel in metres
//   wheels           auto-detected discs: diameter range, minimum |x|, axles that steer (factors)
export const VEHICLE_RIGS = {
    t90m_ru: {
        file: '12_vehicle_tank_t90m_ru', span: 9.2, yaw: 180, tracked: true,
        turret: { materials: /T90M_Turret|6P49MT|TankCloth/, ring: [0, 1.3], deck: 1.3, traverse: 40 },
        gun: { box: [[-0.32, 1.42, -9], [0.32, 1.95, -0.5]], trunnion: [1.67, 0.3], elev: [-6, 14], recoil: 0.3 },
        wheels: { dia: [0.5, 0.95], minX: 1.0 }, track: { materials: /Track/ }
    },
    t72b3_ru: {
        file: '13_vehicle_tank_t72b3_ru', span: 8.9, yaw: 0, tracked: true,
        turret: { box: [[-1.95, 1.38, -0.5], [1.95, 9, 3.35]], ring: [0, 1.25], deck: 1.36, traverse: 40 },
        gun: { box: [[-0.32, 1.38, -9], [0.32, 1.88, -0.2]], trunnion: [1.6, 0.25], elev: [-6, 14], recoil: 0.3 },
        wheels: { dia: [0.5, 0.95], minX: 1.0 }, track: {}
    },
    bmp2_ua: {
        file: '08_vehicle_bmp2_ua', span: 6.75, yaw: 180, tracked: true,
        turret: { box: [[-1.15, 1.68, -0.35], [1.15, 9, 1.95]], ring: [0, 0.75], deck: 1.67, traverse: 30 },
        gun: { box: [[-0.25, 1.78, -9], [0.25, 2.08, -0.15]], trunnion: [1.93, 0.05], elev: [-5, 74], recoil: 0.05 },
        wheels: { dia: [0.45, 0.8], minX: 0.9 }, track: {}
    },
    bradley_ua: {
        file: '10_vehicle_bradley_m2a3_ua', span: 6.65, yaw: 0, tracked: true,
        turret: { box: [[-1.35, 1.84, -1.05], [1.55, 9, 1.8]], ring: [0.15, 0.35], deck: 1.82, traverse: 60 },
        gun: { box: [[-0.2, 2.0, -9], [0.5, 2.38, -0.7]], trunnion: [2.17, -0.3], elev: [-10, 57], recoil: 0.05 },
        wheels: { dia: [0.45, 0.8], minX: 0.9 }, track: {}
    },
    btr80_ru: {
        file: '09_vehicle_btr80_ru', span: 7.65, yaw: 90, tracked: false,
        turret: { nodes: /^turret/i, box: [[-0.8, 2.0, -1.8], [0.8, 9, -0.2]], ring: [0, -1.0], deck: 2.0, traverse: 30 },
        gun: { box: [[-0.25, 2.1, -9], [0.25, 2.5, -1.5]], trunnion: [2.3, -1.3], elev: [-4, 60], recoil: 0.04 },
        wheels: { dia: [0.9, 1.3], minX: 0.8, steer: [1, 0.62, 0, 0] }
    },
    humvee_ua: {
        file: '11_vehicle_humvee_ua', span: 4.85, yaw: 0, skinFixX: 90, tracked: false,
        turret: { joints: /turret_yaw/, traverse: 60 },
        gun: { joints: /cannon_pitch|machingun/, elev: [-10, 45], recoil: 0.03 },
        wheels: { dia: [0.7, 1.15], minX: 0.6, steer: [1, 0] }
    },
    uaz452: {
        file: '14_vehicle_uaz452_bukhanka', span: 4.5, yaw: 180, tracked: false,
        wheels: { dia: [0.55, 0.95], minX: 0.45, steer: [1, 0] }
    }
};

// ---------------------------------------------------------------- math

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mulMat = (a, b) => {
    const r = new Array(16);
    for (let c = 0; c < 4; c++) {
        for (let i = 0; i < 4; i++) r[c * 4 + i] = a[i] * b[c * 4] + a[4 + i] * b[c * 4 + 1] + a[8 + i] * b[c * 4 + 2] + a[12 + i] * b[c * 4 + 3];
    }
    return r;
};
const rotX = (deg) => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotY = (deg) => { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const point = (m, x, y, z, out, o) => {
    out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
};
const dir = (m, x, y, z, out, o) => {
    const a = m[0] * x + m[4] * y + m[8] * z, b = m[1] * x + m[5] * y + m[9] * z, c = m[2] * x + m[6] * y + m[10] * z;
    const l = Math.hypot(a, b, c) || 1;
    out[o] = a / l; out[o + 1] = b / l; out[o + 2] = c / l;
};
const inBox = (box, x, y, z) => x >= box[0][0] && x <= box[1][0] && y >= box[0][1] && y <= box[1][1] && z >= box[0][2] && z <= box[1][2];

// ---------------------------------------------------------------- geometry extraction

// Triangle soup of every LOD0 primitive, oriented and normalized into the vehicle frame.
export function extractSoup(doc, cfg) {
    const rigged = Boolean(doc.getRoot().listNodes().some((n) => n.getExtras().rig));
    const orient = rigged ? IDENTITY : rotY(cfg.yaw || 0);
    const skinFix = rigged ? IDENTITY : rotX(cfg.skinFixX || 0);
    const chunks = [];
    let nv = 0;
    let nt = 0;
    const el = [];
    const tmp = [0, 0, 0];
    for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh || node.getExtras().lod > 0) continue;
        const skin = node.getSkin();
        let jointMats = null;
        let jointNames = null;
        if (skin) {
            const ibm = skin.getInverseBindMatrices();
            jointNames = skin.listJoints().map((j) => j.getName());
            jointMats = skin.listJoints().map((j, i) => mulMat(orient, mulMat(skinFix, mulMat(j.getWorldMatrix(), ibm ? ibm.getElement(i, []) : IDENTITY))));
        }
        const world = mulMat(orient, node.getWorldMatrix());
        for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute('POSITION');
            if (!pos || prim.getMode() !== 4) continue;
            const count = pos.getCount();
            const verts = new Float32Array(count * 3);
            const vmat = skin ? new Array(count) : null;
            const joint = skin ? new Int16Array(count) : null;
            const js = skin ? prim.getAttribute('JOINTS_0') : null;
            const ws = skin ? prim.getAttribute('WEIGHTS_0') : null;
            for (let i = 0; i < count; i++) {
                pos.getElement(i, el);
                const x = el[0], y = el[1], z = el[2];
                if (js && ws) {
                    const jv = js.getElement(i, []);
                    const wv = ws.getElement(i, []);
                    let sx = 0, sy = 0, sz = 0, sum = 0, best = 0, bw = -1;
                    for (let k = 0; k < jv.length; k++) {
                        if (!(wv[k] > 0)) continue;
                        point(jointMats[jv[k]], x, y, z, tmp, 0);
                        sx += tmp[0] * wv[k]; sy += tmp[1] * wv[k]; sz += tmp[2] * wv[k];
                        sum += wv[k];
                        if (wv[k] > bw) { bw = wv[k]; best = jv[k]; }
                    }
                    verts[i * 3] = sx / (sum || 1); verts[i * 3 + 1] = sy / (sum || 1); verts[i * 3 + 2] = sz / (sum || 1);
                    joint[i] = best;
                    vmat[i] = jointMats[best];
                } else {
                    point(world, x, y, z, verts, i * 3);
                }
            }
            const idx = prim.getIndices();
            const indices = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
            chunks.push({
                node, prim, verts, indices, world, vmat, joint, jointNames, base: nv, triBase: nt, count,
                material: prim.getMaterial(), matName: prim.getMaterial()?.getName() || '', nodeName: node.getName()
            });
            nv += count;
            nt += Math.floor(indices.length / 3);
        }
    }
    const positions = new Float32Array(nv * 3);
    const tris = new Uint32Array(nt * 3);
    const triChunk = new Uint16Array(nt);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    chunks.forEach((ch, ci) => {
        positions.set(ch.verts, ch.base * 3);
        for (let i = 0; i + 2 < ch.indices.length; i += 3) {
            const t = ch.triBase + i / 3;
            tris[t * 3] = ch.indices[i] + ch.base;
            tris[t * 3 + 1] = ch.indices[i + 1] + ch.base;
            tris[t * 3 + 2] = ch.indices[i + 2] + ch.base;
            triChunk[t] = ci;
        }
    });
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (positions[i + k] < min[k]) min[k] = positions[i + k];
            if (positions[i + k] > max[k]) max[k] = positions[i + k];
        }
    }
    // Same normalization as AssetManager._fill: longest side = span, centred on XZ, resting on y = 0.
    const scale = cfg.span / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
    const offset = [-(min[0] + max[0]) * 0.5 * scale, -min[1] * scale, -(min[2] + max[2]) * 0.5 * scale];
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = positions[i] * scale + offset[0];
        positions[i + 1] = positions[i + 1] * scale + offset[1];
        positions[i + 2] = positions[i + 2] * scale + offset[2];
    }
    return { chunks, positions, tris, triChunk, nv, nt, scale, offset, rigged };
}

// Connected components over position-welded vertices.
export function findIslands(soup, cell = 0.002) {
    const { positions: p, tris, nv, nt } = soup;
    const weld = new Uint32Array(nv);
    const seen = new Map();
    for (let i = 0; i < nv; i++) {
        const key = ((Math.round(p[i * 3] / cell) + 32768) * 65536 + (Math.round(p[i * 3 + 1] / cell) + 32768)) * 65536 + (Math.round(p[i * 3 + 2] / cell) + 32768);
        let id = seen.get(key);
        if (id === undefined) { id = i; seen.set(key, id); }
        weld[i] = id;
    }
    const parent = new Uint32Array(nv);
    for (let i = 0; i < nv; i++) parent[i] = i;
    const find = (a) => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
    };
    for (let t = 0; t < nt; t++) {
        const a = find(weld[tris[t * 3]]);
        const b = find(weld[tris[t * 3 + 1]]);
        const c = find(weld[tris[t * 3 + 2]]);
        if (b !== a) parent[b] = a;
        const c2 = find(c);
        if (c2 !== a) parent[c2] = a;
    }
    const triIsland = new Int32Array(nt);
    const triArea = new Float32Array(nt);
    const triCentre = new Float32Array(nt * 3);
    const byRoot = new Map();
    const islands = [];
    for (let t = 0; t < nt; t++) {
        const root = find(weld[tris[t * 3]]);
        let isl = byRoot.get(root);
        if (!isl) {
            isl = { id: islands.length, tris: [], area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], c: [0, 0, 0] };
            byRoot.set(root, isl);
            islands.push(isl);
        }
        triIsland[t] = isl.id;
        isl.tris.push(t);
        const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        triArea[t] = area;
        isl.area += area;
        for (let k = 0; k < 3; k++) {
            const m = (p[a + k] + p[b + k] + p[c + k]) / 3;
            triCentre[t * 3 + k] = m;
            isl.c[k] += m * area;
            isl.min[k] = Math.min(isl.min[k], p[a + k], p[b + k], p[c + k]);
            isl.max[k] = Math.max(isl.max[k], p[a + k], p[b + k], p[c + k]);
        }
    }
    for (const isl of islands) {
        for (let k = 0; k < 3; k++) isl.c[k] = isl.area > 0 ? isl.c[k] / isl.area : (isl.min[k] + isl.max[k]) * 0.5;
    }
    return { islands, triIsland, triArea, triCentre };
}

// ---------------------------------------------------------------- classification

export function classify(soup, cfg) {
    const { islands, triIsland, triArea, triCentre } = findIslands(soup);
    const { chunks, triChunk, nt, positions: p, tris } = soup;
    const cls = new Int16Array(nt);
    const report = { wheels: [], notes: [] };

    // Already rigged files keep their parts: read them back from the pivot hierarchy.
    if (soup.rigged) {
        chunks.forEach((ch, ci) => {
            let part = HULL;
            for (let n = ch.node; n; n = n.getParentNode()) {
                const ex = n.getExtras();
                if (ex.part === 'gun') { part = GUN; break; }
                if (ex.part === 'turret') { part = TURRET; break; }
                if (ex.part === 'wheel') { part = WHEEL + ex.index; break; }
                if (ex.part === 'track') { part = ex.side === 'l' ? TRACK_L : TRACK_R; break; }
            }
            for (let t = 0; t < nt; t++) if (triChunk[t] === ci) cls[t] = part;
        });
    }

    const chunkIs = (ch, rule, jointRule) => {
        if (!rule) return false;
        if (rule.materials && rule.materials.test(ch.matName)) return true;
        if (rule.nodes && rule.nodes.test(ch.nodeName)) return true;
        return false;
    };
    // Share of an island's area that satisfies `test(tri)`; islands that straddle are split per triangle.
    const assign = (candidates, test, value, splitArea = 3) => {
        for (const isl of candidates) {
            let inside = 0;
            for (const t of isl.tris) if (test(t)) inside += triArea[t];
            const frac = isl.area > 0 ? inside / isl.area : 0;
            if (frac >= 0.85 || (frac >= 0.5 && isl.area <= splitArea)) {
                for (const t of isl.tris) cls[t] = value;
            } else if (frac > 0.15 && isl.area > splitArea) {
                for (const t of isl.tris) if (test(t)) cls[t] = value;
                report.notes.push(`island ${isl.id} (${isl.area.toFixed(1)} m2) split per triangle for part ${value}`);
            }
        }
    };

    if (!soup.rigged) {
        const T = cfg.turret;
        if (T) {
            const hinted = chunks.map((ch) => chunkIs(ch, T));
            const hasHints = hinted.some(Boolean);
            const jointHit = (t, re) => {
                const ch = chunks[triChunk[t]];
                if (!ch.joint || !re) return false;
                let hits = 0;
                for (let k = 0; k < 3; k++) if (re.test(ch.jointNames[ch.joint[tris[t * 3 + k] - ch.base]])) hits++;
                return hits >= 2;
            };
            if (T.joints) {
                for (let t = 0; t < nt; t++) {
                    if (jointHit(t, cfg.gun?.joints)) cls[t] = GUN;
                    else if (jointHit(t, T.joints)) cls[t] = TURRET;
                }
            } else if (hasHints && !T.box) {
                for (let t = 0; t < nt; t++) if (hinted[triChunk[t]]) cls[t] = TURRET;
            } else {
                assign(islands, (t) => (hasHints && hinted[triChunk[t]]) || inBox(T.box, triCentre[t * 3], triCentre[t * 3 + 1], triCentre[t * 3 + 2]), TURRET);
            }
            const G = cfg.gun;
            if (G && G.box) {
                // Barrel and mantlet: turret islands that sit inside the gun box (thin and ahead of the ring).
                for (const isl of islands) {
                    if (!isl.tris.some((t) => cls[t] === TURRET)) continue;
                    const fits = isl.min[0] >= G.box[0][0] - 0.05 && isl.max[0] <= G.box[1][0] + 0.05
                        && isl.min[1] >= G.box[0][1] - 0.05 && isl.max[1] <= G.box[1][1] + 0.05
                        && isl.max[2] <= G.box[1][2] + 0.6 && inBox(G.box, isl.c[0], isl.c[1], isl.c[2]);
                    if (fits) for (const t of isl.tris) cls[t] = GUN;
                }
            }
        }

        // Wheels: disc-like islands outboard of the hull, clustered per axle and side.
        const W = cfg.wheels;
        if (W) {
            const discs = [];
            for (const isl of islands) {
                if (isl.tris.length < 12 || cls[isl.tris[0]] !== HULL) continue;
                const dx = isl.max[0] - isl.min[0], dy = isl.max[1] - isl.min[1], dz = isl.max[2] - isl.min[2];
                const dia = (dy + dz) * 0.5;
                const cx = (isl.min[0] + isl.max[0]) * 0.5;
                if (dia < W.dia[0] || dia > W.dia[1] || Math.abs(dy - dz) > 0.14 * dia || dx > 0.8 * dia || Math.abs(cx) < W.minX) continue;
                discs.push({ isl, x: cx, y: (isl.min[1] + isl.max[1]) * 0.5, z: (isl.min[2] + isl.max[2]) * 0.5, r: dia * 0.5 });
            }
            const wheels = [];
            for (const d of discs) {
                let w = wheels.find((o) => (o.x < 0) === (d.x < 0) && Math.abs(o.z - d.z) < 0.3 * o.r && Math.abs(o.y - d.y) < 0.3 * o.r);
                if (!w) {
                    w = { x: d.x, y: d.y, z: d.z, r: d.r, minX: d.isl.min[0], maxX: d.isl.max[0], islands: [], area: 0 };
                    wheels.push(w);
                }
                w.islands.push(d.isl);
                w.area += d.isl.area;
                w.minX = Math.min(w.minX, d.isl.min[0]);
                w.maxX = Math.max(w.maxX, d.isl.max[0]);
                if (d.r > w.r) { w.r = d.r; w.y = d.y; w.z = d.z; }
            }
            for (const w of wheels) w.x = (w.minX + w.maxX) * 0.5;
            // Axle order front to rear, left before right: the same order as the physics suspension points.
            const lowest = Math.min(...wheels.map((w) => w.y));
            const axles = [];
            for (const w of wheels.slice().sort((a, b) => a.z - b.z)) {
                let axle = axles.find((a) => Math.abs(a.z - w.z) < 0.25);
                if (!axle) { axle = { z: w.z, list: [] }; axles.push(axle); }
                axle.list.push(w);
            }
            let index = 0;
            axles.forEach((axle, ai) => {
                for (const w of axle.list.sort((a, b) => a.x - b.x)) {
                    w.index = index++;
                    w.axle = ai;
                    w.road = w.y < lowest + 0.18;
                    for (const isl of w.islands) for (const t of isl.tris) cls[t] = WHEEL + w.index;
                }
            });
            // Hub caps, bolts and rims: small leftovers inside a wheel's disc join it.
            for (const isl of islands) {
                if (cls[isl.tris[0]] !== HULL) continue;
                for (const w of wheels) {
                    const dy = isl.max[1] - isl.min[1], dz = isl.max[2] - isl.min[2];
                    if (dy > 2.1 * w.r || dz > 2.1 * w.r) continue;
                    if (isl.min[0] < w.minX - 0.12 || isl.max[0] > w.maxX + 0.12) continue;
                    if (Math.hypot(isl.c[1] - w.y, isl.c[2] - w.z) > 0.55 * w.r) continue;
                    if (Math.hypot(Math.max(isl.max[1] - w.y, w.y - isl.min[1]), Math.max(isl.max[2] - w.z, w.z - isl.min[2])) > 1.5 * w.r) continue;
                    for (const t of isl.tris) cls[t] = WHEEL + w.index;
                    break;
                }
            }
            report.wheels = wheels.sort((a, b) => a.index - b.index);
        }

        // Track belts: long islands (or the track material) outboard of the hull.
        if (cfg.tracked && cfg.track) {
            const R = cfg.track;
            for (const isl of islands) {
                if (cls[isl.tris[0]] !== HULL) continue;
                const ch = chunks[triChunk[isl.tris[0]]];
                const byMaterial = R.materials && R.materials.test(ch.matName);
                const long = isl.max[2] - isl.min[2] > 2.5 && isl.max[0] - isl.min[0] < 0.95 && Math.abs(isl.c[0]) > (cfg.wheels?.minX || 0.9) && isl.max[1] < 1.3;
                if (!(R.materials ? byMaterial : long)) continue;
                for (const t of isl.tris) cls[t] = triCentre[t * 3] < 0 ? TRACK_L : TRACK_R;
            }
        }
    }

    // Pivots and muzzle from the classified geometry.
    const bounds = (value) => {
        const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], tris: 0 };
        for (let t = 0; t < nt; t++) {
            if (cls[t] !== value) continue;
            b.tris++;
            for (let k = 0; k < 3; k++) {
                const v = tris[t * 3 + k] * 3;
                for (let a = 0; a < 3; a++) {
                    if (p[v + a] < b.min[a]) b.min[a] = p[v + a];
                    if (p[v + a] > b.max[a]) b.max[a] = p[v + a];
                }
            }
        }
        return b;
    };
    const rig = { key: cfg.key, version: 1, tracked: Boolean(cfg.tracked), wheels: [], turret: null, gun: null, tracks: [] };
    const tb = bounds(TURRET);
    const gb = bounds(GUN);
    if (tb.tris + gb.tris > 0 && cfg.turret) {
        const T = cfg.turret;
        const src = tb.tris ? tb : gb;
        const ring = T.ring || [(src.min[0] + src.max[0]) * 0.5, (src.min[2] + src.max[2]) * 0.5];
        rig.turret = { pivot: [ring[0], T.deck ?? src.min[1], ring[1]], traverse: T.traverse || 40 };
        if (gb.tris) {
            const G = cfg.gun;
            // Muzzle: centre of the most forward 12 cm of the gun.
            let mx = 0, my = 0, n = 0;
            for (let t = 0; t < nt; t++) {
                if (cls[t] !== GUN) continue;
                for (let k = 0; k < 3; k++) {
                    const v = tris[t * 3 + k] * 3;
                    if (p[v + 2] < gb.min[2] + 0.12) { mx += p[v]; my += p[v + 1]; n++; }
                }
            }
            mx /= n || 1; my /= n || 1;
            const trunnion = G.trunnion
                ? [mx, G.trunnion[0], G.trunnion[1]]
                : [mx, my, Math.min(gb.max[2], gb.min[2] + (gb.max[2] - gb.min[2]) * 0.85)];
            rig.gun = {
                pivot: trunnion,
                muzzle: [mx - trunnion[0], my - trunnion[1], gb.min[2] - trunnion[2]],
                elev: G.elev || [-5, 20],
                recoil: G.recoil || 0.05
            };
        }
    }
    if (soup.rigged) {
        // keep the stored rig description
        const stored = soup.chunks[0]?.node && soup.chunks.map((c) => c.node).concat([]).length ? null : null;
        void stored;
    }
    for (const w of report.wheels) {
        const steer = cfg.wheels?.steer ? (cfg.wheels.steer[w.axle] || 0) : 0;
        rig.wheels.push({ index: w.index, pivot: [w.x, w.y, w.z], radius: w.r, side: w.x < 0 ? 'l' : 'r', axle: w.axle, steer, road: w.road });
    }
    for (const value of [TRACK_L, TRACK_R]) {
        const b = bounds(value);
        if (!b.tris) continue;
        rig.tracks.push({ side: value === TRACK_L ? 'l' : 'r', value, ...trackUv(soup, cls, value) });
    }
    report.counts = { hull: 0, turret: 0, gun: 0, track: 0, wheel: 0 };
    for (let t = 0; t < nt; t++) {
        const c = cls[t];
        report.counts[c === HULL ? 'hull' : c === TURRET ? 'turret' : c === GUN ? 'gun' : c >= WHEEL ? 'wheel' : 'track']++;
    }
    return { cls, rig, report, islands };
}

// Does the belt texture run along the track? Fit u and v against z on the ground run.
function trackUv(soup, cls, value) {
    const { chunks, triChunk, tris, nt, positions: p } = soup;
    const uvCache = new Map();
    const sums = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];   // n, sz, su, szz, suu, szu
    const range = [[Infinity, -Infinity], [Infinity, -Infinity]];
    const el = [];
    for (let t = 0; t < nt; t++) {
        if (cls[t] !== value) continue;
        const ch = chunks[triChunk[t]];
        let uv = uvCache.get(ch);
        if (uv === undefined) { uv = ch.prim.getAttribute('TEXCOORD_0') || null; uvCache.set(ch, uv); }
        if (!uv) return { scroll: false };
        for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k];
            uv.getElement(v - ch.base, el);
            for (let a = 0; a < 2; a++) {
                range[a][0] = Math.min(range[a][0], el[a]);
                range[a][1] = Math.max(range[a][1], el[a]);
                if (p[v * 3 + 1] > 0.12) continue;
                const s = sums[a], z = p[v * 3 + 2];
                s[0]++; s[1] += z; s[2] += el[a]; s[3] += z * z; s[4] += el[a] * el[a]; s[5] += z * el[a];
            }
        }
    }
    let best = { scroll: false };
    for (let a = 0; a < 2; a++) {
        const [n, sz, su, szz, suu, szu] = sums[a];
        if (n < 12) continue;
        const cov = szu / n - (sz / n) * (su / n);
        const vz = szz / n - (sz / n) ** 2;
        const vu = suu / n - (su / n) ** 2;
        if (vz < 1e-6 || vu < 1e-9) continue;
        const corr = cov / Math.sqrt(vz * vu);
        // The texture must tile along the belt, otherwise scrolling would slide into other atlas regions.
        if (Math.abs(corr) > 0.97 && range[a][1] - range[a][0] > 1.5 && (!best.scroll || Math.abs(corr) > best.corr)) {
            best = { scroll: true, uvAxis: a, uvPerMeter: cov / vz, corr: Math.abs(corr) };
        }
    }
    return best;
}

// ---------------------------------------------------------------- rebuild

const COPY = ['NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0'];

function rebuild(doc, soup, cfg, cls, rig) {
    const { chunks, triChunk, tris, nt, positions: p } = soup;
    const root = doc.getRoot();
    const buffer = root.listBuffers()[0] || doc.createBuffer();
    const pivotOf = (value) => {
        if (value === TURRET && rig.turret) return rig.turret.pivot;
        if (value === GUN && rig.gun) return rig.gun.pivot;
        if (value >= WHEEL) return rig.wheels[value - WHEEL].pivot;
        return [0, 0, 0];
    };

    // Group triangles by part, material and attribute layout.
    const groups = new Map();
    for (let t = 0; t < nt; t++) {
        const ch = chunks[triChunk[t]];
        if (ch.signature === undefined) {
            ch.attrs = COPY.map((s) => ch.prim.getAttribute(s)).map((a, i) => (a ? { semantic: COPY[i], accessor: a, size: a.getElementSize() } : null)).filter(Boolean);
            ch.signature = ch.attrs.map((a) => `${a.semantic}${a.size}`).join(',');
            ch.matIndex = ch.material ? root.listMaterials().indexOf(ch.material) : -1;
        }
        const key = `${cls[t]}|${ch.matIndex}|${ch.signature}`;
        let g = groups.get(key);
        if (!g) {
            g = { value: cls[t], material: ch.material, attrs: ch.attrs.map((a) => ({ semantic: a.semantic, size: a.size, data: [] })), pos: [], index: [], remap: new Map() };
            groups.set(key, g);
        }
        const pivot = pivotOf(g.value);
        for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k];
            let ni = g.remap.get(v);
            if (ni === undefined) {
                ni = g.pos.length / 3;
                g.remap.set(v, ni);
                g.pos.push(p[v * 3] - pivot[0], p[v * 3 + 1] - pivot[1], p[v * 3 + 2] - pivot[2]);
                const local = v - ch.base;
                const m = ch.vmat ? ch.vmat[local] : ch.world;
                const el = [];
                const out = [0, 0, 0];
                ch.attrs.forEach((a, ai) => {
                    a.accessor.getElement(local, el);
                    if (a.semantic === 'NORMAL' || a.semantic === 'TANGENT') {
                        dir(m, el[0], el[1], el[2], out, 0);
                        g.attrs[ai].data.push(out[0], out[1], out[2]);
                        if (a.size === 4) g.attrs[ai].data.push(el[3]);
                    } else {
                        for (let c = 0; c < a.size; c++) g.attrs[ai].data.push(el[c]);
                    }
                });
            }
            g.index.push(ni);
        }
    }

    // Drop the old scene graph, then emit the part hierarchy.
    const scene = root.listScenes()[0] || doc.createScene('Scene');
    for (const node of root.listNodes()) node.dispose();
    for (const mesh of root.listMeshes()) mesh.dispose();
    for (const skin of root.listSkins()) skin.dispose();

    const TYPES = { 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };
    const meshFor = new Map();
    for (const g of groups.values()) {
        const prim = doc.createPrimitive()
            .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer))
            .setIndices(doc.createAccessor().setType('SCALAR').setArray(g.pos.length / 3 > 65535 ? new Uint32Array(g.index) : new Uint16Array(g.index)).setBuffer(buffer));
        for (const a of g.attrs) prim.setAttribute(a.semantic, doc.createAccessor().setType(TYPES[a.size]).setArray(new Float32Array(a.data)).setBuffer(buffer));
        if (g.material) prim.setMaterial(g.material);
        let mesh = meshFor.get(g.value);
        if (!mesh) { mesh = doc.createMesh(); meshFor.set(g.value, mesh); }
        mesh.addPrimitive(prim);
    }

    const rootNode = doc.createNode(cfg.key).setExtras({ rig: describe(rig) });
    scene.addChild(rootNode);
    const attach = (parent, name, value, extras, pivot, parentPivot = [0, 0, 0]) => {
        const node = doc.createNode(name).setExtras(extras).setTranslation([pivot[0] - parentPivot[0], pivot[1] - parentPivot[1], pivot[2] - parentPivot[2]]);
        parent.addChild(node);
        const mesh = meshFor.get(value);
        if (mesh) node.addChild(doc.createNode(`${name}_mesh`).setMesh(mesh.setName(name)));
        return node;
    };
    if (meshFor.has(HULL)) rootNode.addChild(doc.createNode('hull').setMesh(meshFor.get(HULL).setName('hull')).setExtras({ part: 'hull' }));
    if (rig.turret) {
        const turret = attach(rootNode, 'turret', TURRET, { part: 'turret' }, rig.turret.pivot);
        if (rig.gun) attach(turret, 'gun', GUN, { part: 'gun' }, rig.gun.pivot, rig.turret.pivot);
    }
    for (const w of rig.wheels) {
        attach(rootNode, `wheel_${w.index}`, WHEEL + w.index, { part: 'wheel', index: w.index, side: w.side, axle: w.axle, radius: +w.radius.toFixed(4), steer: w.steer, road: w.road }, w.pivot);
    }
    for (const tr of rig.tracks) {
        const extras = { part: 'track', side: tr.side, scroll: tr.scroll };
        if (tr.scroll) Object.assign(extras, { uvAxis: tr.uvAxis, uvPerMeter: +tr.uvPerMeter.toFixed(5) });
        rootNode.addChild(doc.createNode(`track_${tr.side}`).setMesh(meshFor.get(tr.value).setName(`track_${tr.side}`)).setExtras(extras));
    }
}

const round = (a) => a.map((v) => +v.toFixed(4));
function describe(rig) {
    return {
        key: rig.key, version: rig.version, tracked: rig.tracked, wheels: rig.wheels.length,
        turret: rig.turret ? { pivot: round(rig.turret.pivot), traverse: rig.turret.traverse } : null,
        gun: rig.gun ? { pivot: round(rig.gun.pivot), muzzle: round(rig.gun.muzzle), elev: rig.gun.elev, recoil: rig.gun.recoil } : null
    };
}

// Pipeline entry: splits `doc` in place. A vehicle without rules is left untouched.
export async function rigVehicle(doc, key) {
    const cfg = VEHICLE_RIGS[key] && { key, ...VEHICLE_RIGS[key] };
    if (!cfg) return null;
    const soup = extractSoup(doc, cfg);
    if (soup.rigged) return null;
    const result = classify(soup, cfg);
    rebuild(doc, soup, cfg, result.cls, result.rig);
    return { soup, ...result };
}

// ---------------------------------------------------------------- debug renders

// Three orthographic views (side from +X, front from -Z, top) of unindexed triangles.
async function renderSheet(tri, colors, file) {
    const { default: sharp } = await import('sharp');
    const S = 84, W = 1240, H = 700;
    const rgb = new Uint8Array(W * H * 3).fill(238);
    const depth = new Float32Array(W * H);
    // u: screen right, v: screen up, d: towards the viewer
    const views = [
        { ox: 420, oy: 300, u: [0, 0, -1], v: [0, 1, 0], d: [1, 0, 0], x0: 0, x1: 840, y0: 0, y1: 310 },
        { ox: 1040, oy: 300, u: [1, 0, 0], v: [0, 1, 0], d: [0, 0, -1], x0: 850, x1: 1240, y0: 0, y1: 310 },
        { ox: 420, oy: 510, u: [0, 0, -1], v: [-1, 0, 0], d: [0, 1, 0], x0: 0, x1: 840, y0: 320, y1: 700 }
    ];
    const L = [0.35, 0.8, -0.48];
    const nt = tri.length / 9;
    for (const vw of views) {
        depth.fill(-Infinity);
        for (let m = -6; m <= 6; m++) {
            const gx = Math.round(vw.ox + m * S);
            const gy = Math.round(vw.oy - m * S);
            const shade = m === 0 ? 110 : 205;
            if (gx >= vw.x0 && gx < vw.x1) for (let y = vw.y0; y < vw.y1; y++) rgb.fill(shade, (y * W + gx) * 3, (y * W + gx) * 3 + 3);
            if (gy >= vw.y0 && gy < vw.y1) for (let x = vw.x0; x < vw.x1; x++) rgb.fill(shade, (gy * W + x) * 3, (gy * W + x) * 3 + 3);
        }
        for (let t = 0; t < nt; t++) {
            const P = [];
            for (let k = 0; k < 3; k++) {
                const i = t * 9 + k * 3;
                P.push([
                    vw.ox + (tri[i] * vw.u[0] + tri[i + 1] * vw.u[1] + tri[i + 2] * vw.u[2]) * S,
                    vw.oy - (tri[i] * vw.v[0] + tri[i + 1] * vw.v[1] + tri[i + 2] * vw.v[2]) * S,
                    tri[i] * vw.d[0] + tri[i + 1] * vw.d[1] + tri[i + 2] * vw.d[2]
                ]);
            }
            const i = t * 9;
            const ux = tri[i + 3] - tri[i], uy = tri[i + 4] - tri[i + 1], uz = tri[i + 5] - tri[i + 2];
            const vx = tri[i + 6] - tri[i], vy = tri[i + 7] - tri[i + 1], vz = tri[i + 8] - tri[i + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            if (nx * vw.d[0] + ny * vw.d[1] + nz * vw.d[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
            const lit = 0.5 + 0.5 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
            const col = colors(t);
            const minX = Math.max(vw.x0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
            const maxX = Math.min(vw.x1 - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
            const minY = Math.max(vw.y0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
            const maxY = Math.min(vw.y1 - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
            const den = (P[1][1] - P[2][1]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][1] - P[2][1]);
            if (Math.abs(den) < 1e-9) continue;
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const w0 = ((P[1][1] - P[2][1]) * (x + 0.5 - P[2][0]) + (P[2][0] - P[1][0]) * (y + 0.5 - P[2][1])) / den;
                    const w1 = ((P[2][1] - P[0][1]) * (x + 0.5 - P[2][0]) + (P[0][0] - P[2][0]) * (y + 0.5 - P[2][1])) / den;
                    const w2 = 1 - w0 - w1;
                    if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
                    const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
                    const o = y * W + x;
                    if (z <= depth[o]) continue;
                    depth[o] = z;
                    rgb[o * 3] = col[0] * lit; rgb[o * 3 + 1] = col[1] * lit; rgb[o * 3 + 2] = col[2] * lit;
                }
            }
        }
    }
    await sharp(Buffer.from(rgb.buffer), { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

const PART_COLORS = { [HULL]: [150, 152, 150], [TURRET]: [222, 72, 60], [GUN]: [245, 205, 40], [TRACK_L]: [50, 160, 85], [TRACK_R]: [50, 160, 85] };
const partColor = (c) => PART_COLORS[c] || ((c - WHEEL) % 2 ? [120, 175, 255] : [45, 100, 235]);

// Unindexed triangles with the test pose applied: turret yaw, gun elevation, steered wheels.
function posed(soup, cls, rig, yawDeg, elevDeg, steerDeg) {
    const { tris, nt, positions: p } = soup;
    const out = new Float32Array(nt * 9);
    const rot = (x, y, z, pivot, axis, deg) => {
        const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
        const dx = x - pivot[0], dy = y - pivot[1], dz = z - pivot[2];
        if (axis === 'y') return [pivot[0] + dx * c + dz * s, y, pivot[2] - dx * s + dz * c];
        return [x, pivot[1] + dy * c - dz * s, pivot[2] + dy * s + dz * c];
    };
    for (let t = 0; t < nt; t++) {
        const c = cls[t];
        for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k] * 3;
            let q = [p[v], p[v + 1], p[v + 2]];
            if (c === GUN && rig.gun) q = rot(q[0], q[1], q[2], rig.gun.pivot, 'x', -elevDeg);
            if ((c === GUN || c === TURRET) && rig.turret) q = rot(q[0], q[1], q[2], rig.turret.pivot, 'y', yawDeg);
            if (c >= WHEEL) {
                const w = rig.wheels[c - WHEEL];
                if (w.steer) q = rot(q[0], q[1], q[2], w.pivot, 'y', steerDeg * w.steer);
            }
            out[t * 9 + k * 3] = q[0]; out[t * 9 + k * 3 + 1] = q[1]; out[t * 9 + k * 3 + 2] = q[2];
        }
    }
    return out;
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
    const repo = resolve(fileURLToPath(import.meta.url), '..', '..');
    const inDir = resolve(repo, opt('in', 'individual_models'));
    const outDir = resolve(repo, opt('out', 'individual_models'));
    const debugDir = opt('debug', null);
    const only = opt('only', null);
    const dry = args.includes('--dry');
    if (debugDir) mkdirSync(resolve(debugDir), { recursive: true });
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
    const manifestPath = resolve(outDir, 'manifest.json');
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* none yet */ }
    const f2 = (a) => a.map((v) => v.toFixed(2)).join(',');

    for (const key of Object.keys(VEHICLE_RIGS)) {
        if (only && !only.split(',').includes(key)) continue;
        const cfg = { key, ...VEHICLE_RIGS[key] };
        const doc = await io.read(resolve(inDir, `${cfg.file}.glb`));
        doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
        const soup = extractSoup(doc, cfg);
        if (soup.rigged && !debugDir) {
            console.log(`${key}: already rigged, skipped`);
            continue;
        }
        const { cls, rig, report } = classify(soup, cfg);
        console.log(`${key}: tris ${soup.nt} scale ${soup.scale.toFixed(4)} parts ${JSON.stringify(report.counts)}${soup.rigged ? ' (already rigged)' : ''}`);
        if (rig.turret) console.log(`  turret pivot [${f2(rig.turret.pivot)}]${rig.gun ? ` gun pivot [${f2(rig.gun.pivot)}] muzzle [${f2(rig.gun.muzzle)}]` : ' (no gun)'}`);
        if (rig.wheels.length) console.log(`  wheels ${rig.wheels.map((w) => `${w.index}${w.side}${w.road ? '' : '*'}(${f2([w.pivot[0], w.pivot[1], w.pivot[2]])} r${w.radius.toFixed(2)}${w.steer ? ' s' + w.steer : ''})`).join(' ')}`);
        for (const tr of rig.tracks) console.log(`  track_${tr.side}: ${tr.scroll ? `uv axis ${tr.uvAxis}, ${tr.uvPerMeter.toFixed(3)} per metre` : 'no tiling belt texture: road wheels spin, the belt stays static'}`);
        for (const note of report.notes.slice(0, 6)) console.log(`  ${note}`);
        if (debugDir) {
            await renderSheet(posed(soup, cls, rig, 0, 0, 0), (t) => partColor(cls[t]), resolve(debugDir, `${key}_parts.png`));
            await renderSheet(posed(soup, cls, rig, 60, 15, 25), (t) => partColor(cls[t]), resolve(debugDir, `${key}_pose.png`));
        }
        if (dry || soup.rigged) continue;
        rebuild(doc, soup, cfg, cls, rig);
        await doc.transform(
            prune(),
            meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene' }),
            dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MATERIAL] })
        );
        const out = resolve(outDir, `${cfg.file}.glb`);
        await io.write(out, doc);
        const bytes = statSync(out).size;
        manifest[`${cfg.file}.glb`] = {
            bytes,
            sha1: createHash('sha1').update(readFileSync(out)).digest('hex').slice(0, 12),
            tris: soup.nt
        };
        console.log(`  wrote ${out} (${(bytes / 1e6).toFixed(2)} MB)`);
    }
    if (!dry) writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
}
