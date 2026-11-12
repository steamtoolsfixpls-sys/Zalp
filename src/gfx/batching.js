import * as THREE from 'three';

// Draw-call reduction helpers: merging meshes that share a material and instancing repeated props.
// Merged geometries are cached per asset, so every clone of a model reuses the same buffers.

const _rel = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _zero = new THREE.Vector3(0, 0, 0);

const staticCache = new Map();
const skinnedCache = new Map();
const farCache = new Map();
let unitBox = null;
let farMaterial = null;

function lodOf(obj) {
    return typeof obj.userData.lod === 'number' ? obj.userData.lod : -1;
}

function mergeable(mesh) {
    return !Array.isArray(mesh.material) && mesh.children.length === 0 && !mesh.geometry.morphAttributes.position;
}

function attributeNames(geometry) {
    return Object.keys(geometry.attributes).sort().join(',');
}

function rawSignature(geometry) {
    const parts = [];
    for (const name of Object.keys(geometry.attributes).sort()) {
        const a = geometry.attributes[name];
        parts.push(`${name}:${a.array.constructor.name}:${a.itemSize}:${a.normalized}`);
    }
    return parts.join(',');
}

function indexCountOf(geometry) {
    return geometry.index ? geometry.index.count : geometry.attributes.position.count;
}

// Bakes each mesh's transform (relative to `root`) into one float geometry. `names` limits the attributes.
function bakeGeometry(meshes, root, names) {
    root.updateWorldMatrix(true, true);
    _inv.copy(root.matrixWorld).invert();
    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
        vertexCount += mesh.geometry.attributes.position.count;
        indexCount += indexCountOf(mesh.geometry);
    }
    const first = meshes[0].geometry;
    const arrays = {};
    for (const name of names) arrays[name] = new Float32Array(vertexCount * first.attributes[name].itemSize);
    const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

    let vOff = 0;
    let iOff = 0;
    for (const mesh of meshes) {
        const g = mesh.geometry;
        const count = g.attributes.position.count;
        _rel.multiplyMatrices(_inv, mesh.matrixWorld);
        _normalMatrix.getNormalMatrix(_rel);
        const mirrored = _rel.determinant() < 0;
        for (const name of names) {
            const src = g.attributes[name];
            const size = src.itemSize;
            const dst = arrays[name];
            let o = vOff * size;
            if (name === 'position') {
                for (let i = 0; i < count; i++, o += 3) {
                    _v.fromBufferAttribute(src, i).applyMatrix4(_rel);
                    dst[o] = _v.x; dst[o + 1] = _v.y; dst[o + 2] = _v.z;
                }
            } else if (name === 'normal') {
                for (let i = 0; i < count; i++, o += 3) {
                    _v.fromBufferAttribute(src, i).applyMatrix3(_normalMatrix).normalize();
                    dst[o] = _v.x; dst[o + 1] = _v.y; dst[o + 2] = _v.z;
                }
            } else if (name === 'tangent') {
                for (let i = 0; i < count; i++, o += 4) {
                    _v.fromBufferAttribute(src, i).transformDirection(_rel);
                    dst[o] = _v.x; dst[o + 1] = _v.y; dst[o + 2] = _v.z;
                    dst[o + 3] = mirrored ? -src.getW(i) : src.getW(i);
                }
            } else {
                for (let i = 0; i < count; i++) {
                    for (let c = 0; c < size; c++) dst[o++] = src.getComponent(i, c);
                }
            }
        }
        const n = indexCountOf(g);
        if (g.index) {
            for (let j = 0; j < n; j++) index[iOff + j] = g.index.getX(j) + vOff;
        } else {
            for (let j = 0; j < n; j++) index[iOff + j] = vOff + j;
        }
        if (mirrored) {
            for (let j = 0; j + 2 < n; j += 3) {
                const t = index[iOff + j + 1];
                index[iOff + j + 1] = index[iOff + j + 2];
                index[iOff + j + 2] = t;
            }
        }
        vOff += count;
        iOff += n;
    }

    const out = new THREE.BufferGeometry();
    for (const name of names) out.setAttribute(name, new THREE.BufferAttribute(arrays[name], first.attributes[name].itemSize));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
}

// Collapses rigid meshes that share a material (and LOD level) into one mesh each. The detailed LOD 0 of
// models with baked LODs and anything rigged (`userData.part`) or opted out (`userData.noMerge`) is left
// alone so parts stay individually addressable. Returns the number of draw calls saved.
export function mergeStaticModel(root, cacheKey, minGain = 4) {
    if (!root || root.userData.gfxMerged) return 0;
    root.userData.gfxMerged = true;
    let hasLods = false;
    let blocked = false;
    const meshes = [];
    root.traverse((o) => {
        if (o.userData.part !== undefined || o.userData.noMerge) blocked = true;
        if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) return;
        if (typeof o.userData.lod === 'number') hasLods = true;
        meshes.push(o);
    });
    if (blocked) return 0;

    const groups = new Map();
    for (const mesh of meshes) {
        const lod = lodOf(mesh);
        if ((hasLods && lod <= 0) || !mergeable(mesh)) continue;
        const key = `${lod}|${mesh.material.uuid}|${attributeNames(mesh.geometry)}`;
        let list = groups.get(key);
        if (!list) groups.set(key, list = []);
        list.push(mesh);
    }
    let gain = 0;
    for (const list of groups.values()) gain += list.length - 1;
    if (gain < minGain) return 0;

    for (const [key, list] of groups) {
        if (list.length < 2) continue;
        const id = `${cacheKey}|${key}`;
        let geometry = staticCache.get(id);
        if (!geometry) {
            geometry = bakeGeometry(list, root, Object.keys(list[0].geometry.attributes));
            staticCache.set(id, geometry);
        }
        const src = list[0];
        const merged = new THREE.Mesh(geometry, src.material);
        merged.name = `merged_${src.material.name || 'mesh'}`;
        merged.castShadow = src.castShadow;
        merged.receiveShadow = src.receiveShadow;
        merged.visible = src.visible;
        if (lodOf(src) >= 0) merged.userData.lod = lodOf(src);
        root.add(merged);
        for (const mesh of list) mesh.removeFromParent();
    }
    return gain;
}

function rawMerge(meshes) {
    const first = meshes[0].geometry;
    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
        vertexCount += mesh.geometry.attributes.position.count;
        indexCount += indexCountOf(mesh.geometry);
    }
    const out = new THREE.BufferGeometry();
    for (const name of Object.keys(first.attributes)) {
        const ref = first.attributes[name];
        const size = ref.itemSize;
        const dst = new ref.array.constructor(vertexCount * size);
        let o = 0;
        for (const mesh of meshes) {
            const src = mesh.geometry.attributes[name];
            const arr = src.array;
            const stride = src.isInterleavedBufferAttribute ? src.data.stride : size;
            const base = src.isInterleavedBufferAttribute ? src.offset : 0;
            for (let i = 0; i < src.count; i++) {
                const p = i * stride + base;
                for (let c = 0; c < size; c++) dst[o++] = arr[p + c];
            }
        }
        out.setAttribute(name, new THREE.BufferAttribute(dst, size, ref.normalized));
    }
    const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let vOff = 0;
    let iOff = 0;
    for (const mesh of meshes) {
        const g = mesh.geometry;
        const n = indexCountOf(g);
        if (g.index) {
            for (let j = 0; j < n; j++) index[iOff + j] = g.index.getX(j) + vOff;
        } else {
            for (let j = 0; j < n; j++) index[iOff + j] = vOff + j;
        }
        vOff += g.attributes.position.count;
        iOff += n;
    }
    out.setIndex(new THREE.BufferAttribute(index, 1));
    return out;
}

// SkeletonUtils.clone gives every skinned mesh its own Skeleton over the same bones: treat those as one.
function sameSkeleton(a, b) {
    if (a === b) return true;
    if (a.bones.length !== b.bones.length) return false;
    for (let i = 0; i < a.bones.length; i++) {
        if (a.bones[i] !== b.bones[i] || !a.boneInverses[i].equals(b.boneInverses[i])) return false;
    }
    return true;
}

// Joins skinned meshes that share bones, material, LOD level and vertex layout (the soldier GLBs split
// every LOD into nine such pieces) and binds the results to a single skeleton, so a character updates one
// bone texture per frame. Vertex data is copied as stored, so the result stays quantized.
export function mergeSkinnedModel(root) {
    if (!root || root.userData.gfxSkinMerged) return 0;
    root.userData.gfxSkinMerged = true;
    const groups = new Map();
    root.traverse((o) => {
        if (!o.isSkinnedMesh || !o.skeleton || !o.skeleton.bones.length || !o.parent || !mergeable(o)) return;
        const rig = `${o.skeleton.bones[0].uuid}:${o.skeleton.bones.length}`;
        const key = `${lodOf(o)}|${o.material.uuid}|${rig}|${o.parent.uuid}|${rawSignature(o.geometry)}`;
        let list = groups.get(key);
        if (!list) groups.set(key, list = []);
        list.push(o);
    });
    const skeletons = new Map();
    let gain = 0;
    for (const list of groups.values()) {
        if (list.length < 2) continue;
        const src = list[0];
        src.updateMatrix();
        let uniform = true;
        for (let i = 1; i < list.length && uniform; i++) {
            list[i].updateMatrix();
            uniform = list[i].matrix.equals(src.matrix) && list[i].bindMatrix.equals(src.bindMatrix)
                && list[i].bindMode === src.bindMode && sameSkeleton(list[i].skeleton, src.skeleton);
        }
        if (!uniform) continue;

        const rig = `${src.skeleton.bones[0].uuid}:${src.skeleton.bones.length}`;
        let skeleton = skeletons.get(rig);
        if (!skeleton || !sameSkeleton(skeleton, src.skeleton)) {
            skeleton = src.skeleton;
            skeletons.set(rig, skeleton);
        }
        const id = list.map((m) => m.geometry.uuid).join('+');
        let geometry = skinnedCache.get(id);
        if (!geometry) {
            geometry = rawMerge(list);
            skinnedCache.set(id, geometry);
        }
        const merged = new THREE.SkinnedMesh(geometry, src.material);
        merged.name = `merged_${src.material.name || 'skin'}`;
        merged.position.copy(src.position);
        merged.quaternion.copy(src.quaternion);
        merged.scale.copy(src.scale);
        merged.castShadow = src.castShadow;
        merged.receiveShadow = src.receiveShadow;
        merged.frustumCulled = src.frustumCulled;
        merged.visible = src.visible;
        merged.bindMode = src.bindMode;
        if (lodOf(src) >= 0) merged.userData.lod = lodOf(src);
        src.parent.add(merged);
        merged.bind(skeleton, src.bindMatrix);
        for (const mesh of list) mesh.removeFromParent();
        gain += list.length - 1;
    }
    return gain;
}

// Single-draw silhouette of a weapon (lowest baked LOD, one flat material) for distant carried rifles.
export function createFarWeaponMesh(root, cacheKey) {
    if (!root) return null;
    let geometry = farCache.get(cacheKey);
    if (geometry === undefined) {
        let best = -1;
        root.traverse((o) => {
            if (o.isMesh && !o.isSkinnedMesh && lodOf(o) > best) best = lodOf(o);
        });
        const meshes = [];
        if (best >= 1) {
            root.traverse((o) => {
                if (o.isMesh && !o.isSkinnedMesh && lodOf(o) === best && o.geometry.attributes.normal) meshes.push(o);
            });
        }
        geometry = meshes.length ? bakeGeometry(meshes, root, ['position', 'normal']) : null;
        farCache.set(cacheKey, geometry);
    }
    if (!geometry) return null;
    if (!farMaterial) farMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1e1f, roughness: 0.62, metalness: 0.25, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, farMaterial);
    mesh.name = 'weapon_far';
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.userData.lodFar = true;
    root.add(mesh);
    return mesh;
}

function hideInstance(slot) {
    slot.matrix.decompose(_pos, _quat, _scale);
    _rel.compose(_pos, _quat, _zero);
    slot.mesh.setMatrixAt(slot.index, _rel);
    slot.mesh.instanceMatrix.needsUpdate = true;
}

// Registry of instanced static props. Sources stay in the scene graph (hidden), colliders are untouched.
export function createPropBatcher(scene) {
    const slots = new Map();        // source object -> [{ mesh, index, matrix, source }]
    const batches = [];

    function addSlot(owner, slot) {
        let list = slots.get(owner);
        if (!list) slots.set(owner, list = []);
        list.push(slot);
    }

    function build(items, geometry, material, name) {
        const batch = new THREE.InstancedMesh(geometry, material, items.length);
        batch.name = `batch_${name}`;
        batch.castShadow = items[0].source.castShadow;
        batch.receiveShadow = items[0].source.receiveShadow;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            batch.setMatrixAt(i, item.matrix);
            item.source.visible = false;
            addSlot(item.owner, { mesh: batch, index: i, matrix: item.matrix, source: item.source });
        }
        batch.instanceMatrix.needsUpdate = true;
        batch.computeBoundingSphere();
        batch.computeBoundingBox();
        scene.add(batch);
        batches.push(batch);
        return batch;
    }

    return {
        batches,

        // Model wrappers of one asset (dragon's teeth, HESCO): one instanced draw per (geometry, material).
        addWrappers(wrappers, name) {
            const buckets = new Map();
            for (const wrapper of wrappers) {
                if (slots.has(wrapper)) continue;
                wrapper.updateWorldMatrix(true, true);
                wrapper.traverse((o) => {
                    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || !o.visible || Array.isArray(o.material)) return;
                    const key = `${o.geometry.uuid}|${o.material.uuid}`;
                    let list = buckets.get(key);
                    if (!list) buckets.set(key, list = []);
                    list.push({ owner: wrapper, source: o, matrix: o.matrixWorld.clone() });
                });
            }
            const made = [];
            for (const list of buckets.values()) {
                if (list.length < 2) continue;
                made.push(build(list, list[0].source.geometry, list[0].source.material, name));
            }
            return made;
        },

        // Plain box meshes sharing a material (pedestals, racks): one unit box scaled per instance.
        addBoxes(meshes, name) {
            const buckets = new Map();
            for (const mesh of meshes) {
                const params = mesh.geometry?.parameters;
                if (slots.has(mesh) || !mesh.isMesh || mesh.geometry.type !== 'BoxGeometry' || !params || Array.isArray(mesh.material)) continue;
                mesh.updateWorldMatrix(true, false);
                _rel.makeScale(params.width, params.height, params.depth);
                const key = `${mesh.material.uuid}|${mesh.castShadow}|${mesh.receiveShadow}`;
                let list = buckets.get(key);
                if (!list) buckets.set(key, list = []);
                list.push({ owner: mesh, source: mesh, matrix: mesh.matrixWorld.clone().multiply(_rel) });
            }
            if (!unitBox) unitBox = new THREE.BoxGeometry(1, 1, 1);
            const made = [];
            for (const list of buckets.values()) {
                if (list.length < 2) continue;
                made.push(build(list, unitBox, list[0].source.material, name));
            }
            return made;
        },

        has(source) {
            return slots.has(source);
        },

        // Hide or show one prop inside its batch (destructibles). Returns false when the prop is not batched.
        setVisible(source, visible) {
            const list = slots.get(source);
            if (!list) return false;
            for (const slot of list) {
                if (visible) {
                    slot.mesh.setMatrixAt(slot.index, slot.matrix);
                    slot.mesh.instanceMatrix.needsUpdate = true;
                } else {
                    hideInstance(slot);
                }
            }
            return true;
        },

        // Take a prop out of its batch for good and render the original object again.
        release(source) {
            const list = slots.get(source);
            if (!list) return false;
            for (const slot of list) {
                hideInstance(slot);
                slot.source.visible = true;
            }
            slots.delete(source);
            return true;
        }
    };
}
