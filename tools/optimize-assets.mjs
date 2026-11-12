#!/usr/bin/env node
// Asset pipeline: raw_models/*.glb -> individual_models/*.glb
//   - weld + meshopt simplification (per-asset triangle budgets) and baked LOD meshes
//   - textures resized to <=512/1024 px and transcoded to KTX2 (ETC1S colour/ORM, UASTC normals)
//   - KHR_mesh_quantization + EXT_meshopt_compression
// Requires the `ktx` CLI from KTX-Software >= 4.3 on PATH.
//   node tools/optimize-assets.mjs [--only substring] [--in raw_models] [--out individual_models]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join as joinPath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, flatten, join, listTextureSlots, meshopt, prune, simplify, simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { rigVehicle } from './vehicle-rig.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? def : args[i + 1];
};
const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const inDir = resolve(root, opt('in', 'raw_models'));
const outDir = resolve(root, opt('out', 'individual_models'));
const only = opt('only', null);

// tex: max texture edge; simplify: LOD0 triangle ratio; lods: extra baked LOD ratios (relative to LOD0);
// join: merge meshes per material (static props only, destroys node names); rig: vehicle part split.
const PROFILES = {
    '01_soldier_ru_ratnik': { tex: 1024, lods: [0.36, 0.12] },
    '02_soldier_ua_infantry': { tex: 1024, lods: [0.36, 0.12] },
    '03_unit_ua_javelin': { tex: 512, join: true },
    // Weapon LODs are the "world model" variants carried by AI soldiers.
    '04_weapon_ak12': { permissive: true, tex: 1024, lods: [0.22, 0.06] },
    '05_weapon_ak74m': { permissive: true, tex: 1024, lods: [0.3, 0.08] },
    '06_weapon_rpg7': { permissive: true, tex: 1024, lods: [0.4, 0.12] },
    '07_weapon_m4a1': { permissive: true, tex: 1024, lods: [0.4, 0.12] },
    '08_vehicle_bmp2_ua': { permissive: true, tex: 1024, simplify: 0.4, simplifyError: 0.04, rig: 'bmp2_ua' },
    '09_vehicle_btr80_ru': { tex: 1024, rig: 'btr80_ru' },
    '10_vehicle_bradley_m2a3_ua': { tex: 1024, rig: 'bradley_ua' },
    '11_vehicle_humvee_ua': { tex: 1024, rig: 'humvee_ua' },
    '12_vehicle_tank_t90m_ru': { tex: 1024, rig: 't90m_ru' },
    '13_vehicle_tank_t72b3_ru': { permissive: true, tex: 1024, simplify: 0.6, rig: 't72b3_ru' },
    '14_vehicle_uaz452_bukhanka': { tex: 1024, rig: 'uaz452' },
    '15_drone_fpv_kamikaze': { permissive: true, tex: 512, simplify: 0.5 },
    '16_drone_dji_mavic3': { permissive: true, tex: 512, simplify: 0.08, simplifyError: 0.03, join: true },
    '17_drone_zala_lancet': { permissive: true, tex: 512, simplify: 0.6 },
    '18_fortification_trench_system': { permissive: true, tex: 512, simplify: 0.45, simplifyError: 0.02, join: true },
    '19_fortification_dragons_teeth': { tex: 512, join: true },
    '20_fortification_hesco_bastion': { tex: 512, join: true }
};
const DEFAULT_PROFILE = { tex: 1024 };

// Hard-surface models ship as unwelded triangle soup; only permissive collapses can decimate them.
const permissiveSimplifier = {
    ...MeshoptSimplifier,
    simplify: (indices, positions, stride, target, error, flags = []) =>
        MeshoptSimplifier.simplify(indices, positions, stride, target, error, [...flags, 'Permissive'])
};

const COLOR_SLOT = /baseColor|emissive|diffuse|specularColor|sheenColor/i;
const NORMAL_SLOT = /normal/i;

function triCount(doc) {
    let tris = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
            const idx = prim.getIndices();
            const pos = prim.getAttribute('POSITION');
            tris += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
        }
    }
    return tris;
}

const pow2Floor = (n) => 2 ** Math.floor(Math.log2(Math.max(4, n)));

async function compressTextures(doc, maxSize, tmp) {
    const textures = doc.getRoot().listTextures();
    if (!textures.length) return;
    const alphaTextures = new Set();
    for (const mat of doc.getRoot().listMaterials()) {
        if (mat.getAlphaMode() !== 'OPAQUE' && mat.getBaseColorTexture()) alphaTextures.add(mat.getBaseColorTexture());
    }
    let n = 0;
    for (const tex of textures) {
        const image = tex.getImage();
        if (!image || tex.getMimeType() === 'image/ktx2') continue;
        const slots = listTextureSlots(tex);
        const isColor = slots.some((s) => COLOR_SLOT.test(s));
        const isNormal = !isColor && slots.some((s) => NORMAL_SLOT.test(s));
        const meta = await sharp(image).metadata();
        // Normal maps tolerate half resolution far better than ETC1S block artefacts.
        const cap = isNormal ? Math.max(256, maxSize / 2) : maxSize;
        const w = Math.min(cap, pow2Floor(meta.width));
        const h = Math.min(cap, pow2Floor(meta.height));
        const keepAlpha = alphaTextures.has(tex) && meta.hasAlpha;
        let img = sharp(image).resize(w, h, { fit: 'fill', kernel: 'lanczos3' });
        img = keepAlpha ? img.ensureAlpha() : img.removeAlpha();
        const png = joinPath(tmp, `t${n}.png`);
        const ktx = joinPath(tmp, `t${n}.ktx2`);
        n++;
        await img.png({ compressionLevel: 1 }).toFile(png);
        const format = `${keepAlpha ? 'R8G8B8A8' : 'R8G8B8'}_${isColor ? 'SRGB' : 'UNORM'}`;
        const params = ['create', '--format', format, '--assign-tf', isColor ? 'srgb' : 'linear', '--generate-mipmap'];
        if (isNormal) params.push('--encode', 'uastc', '--uastc-quality', '2', '--uastc-rdo', '--uastc-rdo-l', '2.0', '--zstd', '18');
        else params.push('--encode', 'basis-lz', '--clevel', '4', '--qlevel', isColor ? '170' : '140');
        execFileSync('ktx', [...params, png, ktx], { stdio: ['ignore', 'ignore', 'inherit'] });
        tex.setImage(readFileSync(ktx)).setMimeType('image/ktx2');
        if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.\w+$/, '.ktx2'));
    }
    doc.createExtension(KHRTextureBasisu).setRequired(true);
}

// Adds simplified copies of every mesh node as siblings tagged `extras.lod = n`.
function bakeLods(doc, ratios, simplifier) {
    const nodes = doc.getRoot().listNodes().filter((nd) => nd.getMesh());
    for (let li = 0; li < ratios.length; li++) {
        for (const node of nodes) {
            const src = node.getMesh();
            const lodMesh = doc.createMesh(`${src.getName()}_LOD${li + 1}`);
            for (const prim of src.listPrimitives()) {
                const copy = prim.clone();
                simplifyPrimitive(copy, { simplifier, ratio: ratios[li], error: 0.05, lockBorder: false });
                if (copy.getIndices() && copy.getIndices().getCount() >= 3) lodMesh.addPrimitive(copy);
            }
            if (!lodMesh.listPrimitives().length) continue;
            const lodNode = doc.createNode(`${node.getName()}_LOD${li + 1}`)
                .setMesh(lodMesh)
                .setSkin(node.getSkin())
                .setTranslation(node.getTranslation())
                .setRotation(node.getRotation())
                .setScale(node.getScale())
                .setExtras({ ...node.getExtras(), lod: li + 1 });
            const parent = node.getParentNode();
            if (parent) parent.addChild(lodNode);
            else doc.getRoot().listScenes().forEach((sc) => sc.listChildren().includes(node) && sc.addChild(lodNode));
        }
    }
    for (const node of nodes) node.setExtras({ ...node.getExtras(), lod: 0 });
}

async function processFile(io, file) {
    const name = basename(file, '.glb');
    const profile = PROFILES[name] || DEFAULT_PROFILE;
    const t0 = Date.now();
    const doc = await io.read(file);
    doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
    const trisBefore = triCount(doc);

    const simplifier = profile.permissive ? permissiveSimplifier : MeshoptSimplifier;
    await doc.transform(dedup(), weld());
    if (profile.join) await doc.transform(flatten(), join({ keepNamed: false }));
    if (profile.simplify) {
        await doc.transform(simplify({ simplifier, ratio: profile.simplify, error: profile.simplifyError || 0.008 }));
    }
    if (profile.rig) await rigVehicle(doc, profile.rig);
    if (profile.lods) bakeLods(doc, profile.lods, simplifier);

    const tmp = mkdtempSync(joinPath(tmpdir(), 'ktx-'));
    try {
        await compressTextures(doc, profile.tex, tmp);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }

    await doc.transform(
        prune({ keepLeaves: true }),
        // One shared quantization volume keeps every skinned mesh on a single skeleton.
        meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizationVolume: 'scene' }),
        dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.SKIN, PropertyType.MATERIAL] })
    );

    const out = joinPath(outDir, `${name}.glb`);
    await io.write(out, doc);
    const bytes = statSync(out).size;
    return {
        name,
        rawMB: statSync(file).size / 1e6,
        outMB: bytes / 1e6,
        trisBefore,
        trisLod0: doc.getRoot().listNodes().filter((nd) => nd.getMesh() && !(nd.getExtras().lod > 0))
            .reduce((s, nd) => s + nd.getMesh().listPrimitives().reduce((a, p) => a + Math.floor((p.getIndices()?.getCount() || 0) / 3), 0), 0),
        skins: doc.getRoot().listSkins().length,
        sec: (Date.now() - t0) / 1000,
        bytes,
        sha1: createHash('sha1').update(readFileSync(out)).digest('hex').slice(0, 12)
    };
}

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

mkdirSync(outDir, { recursive: true });
const files = readdirSync(inDir).filter((f) => f.endsWith('.glb') && (!only || f.includes(only))).sort();
if (!files.length) {
    console.error(`No .glb files in ${inDir}`);
    process.exit(1);
}

const manifestPath = joinPath(outDir, 'manifest.json');
let manifest = {};
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first run */ }

let rawTotal = 0;
let outTotal = 0;
for (const f of files) {
    const r = await processFile(io, joinPath(inDir, f));
    rawTotal += r.rawMB;
    outTotal += r.outMB;
    manifest[`${r.name}.glb`] = { bytes: r.bytes, sha1: r.sha1, tris: r.trisLod0 };
    console.log(`${r.name.padEnd(34)} ${r.rawMB.toFixed(2).padStart(6)}MB -> ${r.outMB.toFixed(2).padStart(5)}MB  tris ${String(r.trisBefore).padStart(6)} -> ${String(r.trisLod0).padStart(6)}  skins ${r.skins}  ${r.sec.toFixed(0)}s`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`TOTAL ${rawTotal.toFixed(1)}MB -> ${outTotal.toFixed(1)}MB (${files.length} files)`);
