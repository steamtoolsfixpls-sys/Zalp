#!/usr/bin/env node
// Vehicle part split for the asset pipeline (work in progress: inspection only).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const VEHICLE_RIGS = {
    bmp2_ua: { file: '08_vehicle_bmp2_ua', span: 6.75 },
    btr80_ru: { file: '09_vehicle_btr80_ru', span: 7.65 },
    bradley_ua: { file: '10_vehicle_bradley_m2a3_ua', span: 6.65 },
    humvee_ua: { file: '11_vehicle_humvee_ua', span: 4.85 },
    t90m_ru: { file: '12_vehicle_tank_t90m_ru', span: 9.2 },
    t72b3_ru: { file: '13_vehicle_tank_t72b3_ru', span: 8.9 },
    uaz452: { file: '14_vehicle_uaz452_bukhanka', span: 4.5 }
};

export async function rigVehicle() {}

const mulPoint = (m, x, y, z, out, o) => {
    out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
};
const mulMat = (a, b) => {
    const r = new Array(16);
    for (let c = 0; c < 4; c++) for (let rI = 0; rI < 4; rI++) {
        r[c * 4 + rI] = a[rI] * b[c * 4] + a[4 + rI] * b[c * 4 + 1] + a[8 + rI] * b[c * 4 + 2] + a[12 + rI] * b[c * 4 + 3];
    }
    return r;
};

// Triangle soup of every LOD0 primitive in file world space, plus the three.js style bounding box.
export function extractSoup(doc) {
    const chunks = [];
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const grow = (x, y, z) => {
        if (x < box.min[0]) box.min[0] = x; if (y < box.min[1]) box.min[1] = y; if (z < box.min[2]) box.min[2] = z;
        if (x > box.max[0]) box.max[0] = x; if (y > box.max[1]) box.max[1] = y; if (z > box.max[2]) box.max[2] = z;
    };
    const tmp = [0, 0, 0];
    const el = [];
    let nv = 0;
    let nt = 0;
    doc.getRoot().listNodes().forEach((node, nodeIndex) => {
        const mesh = node.getMesh();
        if (!mesh || node.getExtras().lod > 0) return;
        const world = node.getWorldMatrix();
        const skin = node.getSkin();
        let jointMats = null;
        if (skin) {
            const ibm = skin.getInverseBindMatrices();
            jointMats = skin.listJoints().map((j, i) => mulMat(j.getWorldMatrix(), ibm ? ibm.getElement(i, []) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
        }
        mesh.listPrimitives().forEach((prim, primIndex) => {
            const pos = prim.getAttribute('POSITION');
            if (!pos || prim.getMode() !== 4) return;
            const count = pos.getCount();
            const verts = new Float32Array(count * 3);
            const joints = skin ? prim.getAttribute('JOINTS_0') : null;
            const weights = skin ? prim.getAttribute('WEIGHTS_0') : null;
            const dom = joints ? new Int16Array(count) : null;
            for (let i = 0; i < count; i++) {
                pos.getElement(i, el);
                const [x, y, z] = el;
                if (joints && weights) {
                    const js = joints.getElement(i, []);
                    const ws = weights.getElement(i, []);
                    let sx = 0, sy = 0, sz = 0, best = 0, bw = -1, wsum = 0;
                    for (let k = 0; k < js.length; k++) {
                        if (ws[k] <= 0) continue;
                        mulPoint(jointMats[js[k]], x, y, z, tmp, 0);
                        sx += tmp[0] * ws[k]; sy += tmp[1] * ws[k]; sz += tmp[2] * ws[k];
                        wsum += ws[k];
                        if (ws[k] > bw) { bw = ws[k]; best = js[k]; }
                    }
                    verts[i * 3] = sx / (wsum || 1); verts[i * 3 + 1] = sy / (wsum || 1); verts[i * 3 + 2] = sz / (wsum || 1);
                    dom[i] = best;
                    grow(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
                } else {
                    mulPoint(world, x, y, z, verts, i * 3);
                }
            }
            if (!joints) {
                const mn = pos.getMinNormalized([]);
                const mx = pos.getMaxNormalized([]);
                for (let c = 0; c < 8; c++) {
                    mulPoint(world, c & 1 ? mx[0] : mn[0], c & 2 ? mx[1] : mn[1], c & 4 ? mx[2] : mn[2], tmp, 0);
                    grow(tmp[0], tmp[1], tmp[2]);
                }
            }
            const idx = prim.getIndices();
            const indices = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
            chunks.push({ node, nodeIndex, prim, primIndex, verts, indices, dom, base: nv, triBase: nt, skinned: Boolean(skin) });
            nv += count;
            nt += Math.floor(indices.length / 3);
        });
    });
    const positions = new Float32Array(nv * 3);
    const tris = new Uint32Array(nt * 3);
    const triChunk = new Uint16Array(nt);
    chunks.forEach((ch, ci) => {
        positions.set(ch.verts, ch.base * 3);
        for (let i = 0; i < ch.indices.length - 2; i += 3) {
            const t = ch.triBase + i / 3;
            tris[t * 3] = ch.indices[i] + ch.base;
            tris[t * 3 + 1] = ch.indices[i + 1] + ch.base;
            tris[t * 3 + 2] = ch.indices[i + 2] + ch.base;
            triChunk[t] = ci;
        }
    });
    return { chunks, positions, tris, triChunk, box, nv, nt };
}

// Runtime normalization (AssetManager._fill): longest side = span, centred on XZ, resting on y = 0.
export function normalize(soup, span) {
    const { min, max } = soup.box;
    const scale = span / Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
    const off = [-(min[0] + max[0]) * 0.5 * scale, -min[1] * scale, -(min[2] + max[2]) * 0.5 * scale];
    const p = soup.positions;
    for (let i = 0; i < p.length; i += 3) {
        p[i] = p[i] * scale + off[0];
        p[i + 1] = p[i + 1] * scale + off[1];
        p[i + 2] = p[i + 2] * scale + off[2];
    }
    soup.scale = scale;
    soup.offset = off;
    return soup;
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
        if (c !== a) parent[find(c)] = a;
    }
    const triIsland = new Int32Array(nt);
    const byRoot = new Map();
    const islands = [];
    for (let t = 0; t < nt; t++) {
        const root = find(weld[tris[t * 3]]);
        let isl = byRoot.get(root);
        if (!isl) {
            isl = { id: islands.length, tris: 0, area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], c: [0, 0, 0] };
            byRoot.set(root, isl);
            islands.push(isl);
        }
        triIsland[t] = isl.id;
        const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        isl.tris++;
        isl.area += area;
        for (let k = 0; k < 3; k++) {
            const m = (p[a + k] + p[b + k] + p[c + k]) / 3;
            isl.c[k] += m * area;
            isl.min[k] = Math.min(isl.min[k], p[a + k], p[b + k], p[c + k]);
            isl.max[k] = Math.max(isl.max[k], p[a + k], p[b + k], p[c + k]);
        }
    }
    for (const isl of islands) for (let k = 0; k < 3; k++) isl.c[k] /= isl.area || 1;
    return { islands, triIsland };
}

// Software render of three orthographic views (side from +X, front from -Z, top) for visual checks.
export async function renderSheet(soup, triColor, file, pose = null) {
    const S = 84, W = 1240, H = 700;
    const rgb = new Uint8Array(W * H * 3).fill(238);
    const depth = new Float32Array(W * H).fill(-Infinity);
    const views = [
        { ox: 420, oy: 300, u: [0, 0, 1], v: [0, 1, 0], d: [1, 0, 0], x0: 0, x1: 840, y0: 0, y1: 310 },
        { ox: 1040, oy: 300, u: [1, 0, 0], v: [0, 1, 0], d: [0, 0, -1], x0: 850, x1: 1240, y0: 0, y1: 310 },
        { ox: 420, oy: 510, u: [0, 0, 1], v: [1, 0, 0], d: [0, 1, 0], x0: 0, x1: 840, y0: 320, y1: 700 }
    ];
    const p = pose ? pose(soup) : soup.positions;
    const { tris, nt } = soup;
    const L = [0.35, 0.8, 0.48];
    for (const vw of views) {
        for (let m = -6; m <= 6; m++) {
            const gx = Math.round(vw.ox + m * S);
            const gy = Math.round(vw.oy - m * S);
            const shade = m === 0 ? 120 : 205;
            if (gx >= vw.x0 && gx < vw.x1) for (let y = vw.y0; y < vw.y1; y++) rgb.fill(shade, (y * W + gx) * 3, (y * W + gx) * 3 + 3);
            if (gy >= vw.y0 && gy < vw.y1) for (let x = vw.x0; x < vw.x1; x++) rgb.fill(shade, (gy * W + x) * 3, (gy * W + x) * 3 + 3);
        }
        for (let t = 0; t < nt; t++) {
            const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
            const P = [a, b, c].map((i) => [
                vw.ox + (p[i] * vw.u[0] + p[i + 1] * vw.u[1] + p[i + 2] * vw.u[2]) * S,
                vw.oy - (p[i] * vw.v[0] + p[i + 1] * vw.v[1] + p[i + 2] * vw.v[2]) * S,
                p[i] * vw.d[0] + p[i + 1] * vw.d[1] + p[i + 2] * vw.d[2]
            ]);
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            if (nx * vw.d[0] + ny * vw.d[1] + nz * vw.d[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
            const lit = 0.45 + 0.55 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
            const col = triColor(t);
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
        depth.fill(-Infinity);
    }
    await sharp(Buffer.from(rgb.buffer), { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

const hue = (i) => {
    const h = (i * 0.61803398875) % 1, s = 0.55, v = 0.95;
    const f = (n) => { const k = (n + h * 6) % 6; return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))); };
    return [f(5), f(3), f(1)];
};

export async function openVehicle(key, dir) {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
    const cfg = VEHICLE_RIGS[key];
    const doc = await io.read(resolve(dir, `${cfg.file}.glb`));
    return { io, doc, cfg };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
    const root = resolve(fileURLToPath(import.meta.url), '..', '..');
    const dir = resolve(root, opt('dir', 'individual_models'));
    const out = resolve(opt('out', '/tmp/rig'));
    const only = opt('only', null);
    mkdirSync(out, { recursive: true });
    const f2 = (a) => a.map((v) => v.toFixed(2)).join(',');
    for (const key of Object.keys(VEHICLE_RIGS)) {
        if (only && !key.includes(only)) continue;
        const { doc, cfg } = await openVehicle(key, dir);
        const soup = normalize(extractSoup(doc), cfg.span);
        const { islands, triIsland } = findIslands(soup);
        const lines = [];
        const b = soup.box;
        lines.push(`${key}: file bbox ${f2(b.min)} .. ${f2(b.max)} scale ${soup.scale.toFixed(4)} tris ${soup.nt} verts ${soup.nv} islands ${islands.length} skins ${doc.getRoot().listSkins().length} anims ${doc.getRoot().listAnimations().length}`);
        const perNode = new Map();
        for (const ch of soup.chunks) {
            const e = perNode.get(ch.node) || { tris: 0, min: [9, 9, 9], max: [-9, -9, -9], prims: 0, skinned: ch.skinned };
            e.tris += ch.indices.length / 3; e.prims++;
            for (let i = 0; i < ch.verts.length; i += 3) for (let k = 0; k < 3; k++) {
                const v = soup.positions[(ch.base * 3) + i + k];
                if (v < e.min[k]) e.min[k] = v; if (v > e.max[k]) e.max[k] = v;
            }
            perNode.set(ch.node, e);
        }
        const nodes = [...perNode.entries()].sort((x, y) => y[1].tris - x[1].tris);
        lines.push(`mesh nodes ${nodes.length}:`);
        for (const [node, e] of nodes.slice(0, 22)) {
            const mats = [...new Set(node.getMesh().listPrimitives().map((pr) => pr.getMaterial()?.getName() || '?'))].join('|');
            lines.push(` ${node.getName().slice(0, 30).padEnd(30)} t${String(e.tris).padStart(6)} p${e.prims}${e.skinned ? ' SKIN' : ''} [${f2(e.min)}]..[${f2(e.max)}] ${mats.slice(0, 40)}`);
        }
        for (const skin of doc.getRoot().listSkins()) lines.push(` skin joints: ${skin.listJoints().map((j) => j.getName()).join(' ')}`);
        const big = islands.slice().sort((x, y) => y.area - x.area);
        lines.push('islands by area:');
        for (const isl of big.slice(0, 26)) lines.push(` #${String(isl.id).padStart(4)} t${String(isl.tris).padStart(6)} a${isl.area.toFixed(1).padStart(6)} [${f2(isl.min)}]..[${f2(isl.max)}]`);
        writeFileSync(resolve(out, `${key}.txt`), lines.join('\n') + '\n');
        await renderSheet(soup, (t) => hue(triIsland[t]), resolve(out, `${key}_islands.png`));
        console.log(lines[0]);
    }
}
