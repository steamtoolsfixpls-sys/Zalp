import * as THREE from 'three';
import { STATS } from '../../stats.js';
import { createGroundMaterial, createGroundApronGeometry } from './environment.js';

export const provingGroundMethods = {
    // Overcast daylight: a soft sun and a sky fill. The environment module balances the fill against
    // image-based lighting per preset, the quality manager owns shadow resolution and frustum.
    setupLighting() {
        this.hemiLight = new THREE.HemisphereLight(0xcdd6de, 0x4d483e, 1.0);
        this.hemiLight.position.set(0, 70, 0);
        this.scene.add(this.hemiLight);

        this.sunLight = new THREE.DirectionalLight(0xfff1dd, 1.9);
        this.sunLight.position.set(65, 95, 55);
        this.sunLight.castShadow = true;
        const shadow = this.sunLight.shadow;
        shadow.mapSize.set(2048, 2048);
        shadow.camera.near = 1.0;
        shadow.camera.far = 280;
        const d = 105;
        shadow.camera.left = -d;
        shadow.camera.right = d;
        shadow.camera.top = d;
        shadow.camera.bottom = -d;
        shadow.bias = -0.0004;
        this.scene.add(this.sunLight);
    },

    buildCleanPolygonFloorAndRamps() {
        // Collision floor: flat at y=0, 600 m square. Only the material is procedural.
        const groundMat = createGroundMaterial(this);
        this.groundMaterial = groundMat;
        const floorGeo = new THREE.PlaneGeometry(600, 600);
        floorGeo.rotateX(-Math.PI / 2);
        const floorMesh = new THREE.Mesh(floorGeo, groundMat);
        floorMesh.receiveShadow = true;
        floorMesh.userData.surface = 'dirt';
        this.provingGroundGroup.add(floorMesh);
        this.octree.fromGraphNode(floorMesh);
        this.staticShootableMeshes.push(floorMesh);

        // Visual-only continuation of the ground out to the fogged horizon.
        const apron = new THREE.Mesh(createGroundApronGeometry(), groundMat);
        apron.receiveShadow = true;
        this.provingGroundGroup.add(apron);

        // Debug grid: hidden in play, faint when switched on (engine.environment.setGridVisible).
        const gridHelper = new THREE.GridHelper(240, 120, 0x626b5c, 0x494f44);
        gridHelper.position.y = 0.01;
        gridHelper.material.transparent = true;
        gridHelper.material.opacity = 0.22;
        gridHelper.material.depthWrite = false;
        gridHelper.visible = false;
        this.debugGrid = gridHelper;
        this.provingGroundGroup.add(gridHelper);

        const bumpPositions = [
            { x: -18, z: -2, w: 6.0, h: 0.38, d: 2.2 },
            { x: -9,  z: -2, w: 6.0, h: 0.35, d: 2.0 },
            { x: 0,   z: -2, w: 6.0, h: 0.35, d: 2.0 },
            { x: 9,   z: -2, w: 6.0, h: 0.38, d: 2.2 },
            { x: -9,  z: -8, w: 6.0, h: 0.42, d: 2.4 },
            { x: 0,   z: -8, w: 6.0, h: 0.42, d: 2.4 }
        ];
        // One instanced draw for all bumps; the per-bump meshes below only serve collision and bullets.
        const rampMat = new THREE.MeshStandardMaterial({ color: 0x6a6c64, roughness: 0.86 });
        const rampVisual = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), rampMat, bumpPositions.length);
        rampVisual.castShadow = true;
        rampVisual.receiveShadow = true;
        const colliderMat = new THREE.MeshBasicMaterial({ visible: false });
        const matrix = new THREE.Matrix4();
        bumpPositions.forEach((bp, i) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(bp.w, bp.h, bp.d), colliderMat);
            mesh.position.set(bp.x, bp.h * 0.5, bp.z);
            mesh.userData.surface = 'concrete';
            this.provingGroundGroup.add(mesh);
            this.octree.fromGraphNode(mesh);
            this.staticShootableMeshes.push(mesh);
            this.ragdollPhysics.addStaticBoxCollider(
                mesh.position,
                { x: bp.w * 0.5, y: bp.h * 0.5, z: bp.d * 0.5 }
            );
            rampVisual.setMatrixAt(i, matrix.makeScale(bp.w, bp.h, bp.d).setPosition(mesh.position));
        });
        rampVisual.computeBoundingSphere();
        this.provingGroundGroup.add(rampVisual);
    },

    addStaticObstacleCollider(obj3d, shrink = 0.85) {
        obj3d.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj3d);
        if (box.isEmpty()) return;
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        if (size.x < 0.2 || size.y < 0.2 || size.z < 0.2) return;

        const colMesh = new THREE.Mesh(
            new THREE.BoxGeometry(size.x * shrink, size.y * shrink, size.z * shrink),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        colMesh.position.copy(center);
        this.scene.add(colMesh);
        this.octree.fromGraphNode(colMesh);
        this.staticShootableMeshes.push(colMesh);

        this.ragdollPhysics.addStaticBoxCollider(
            center,
            { x: size.x * shrink * 0.5, y: size.y * shrink * 0.5, z: size.z * shrink * 0.5 }
        );
    },

    populateMilitaryLineupRows() {
        const armorRowKeys = [
            { key: 't90m_ru',    x: -27, z: 12, yaw: 0 },
            { key: 't72b3_ru',   x: -18, z: 12, yaw: 0 },
            { key: 'btr80_ru',   x: -9,  z: 12, yaw: 0 },
            { key: 'bmp2_ua',    x: 0,   z: 12, yaw: 0 },
            { key: 'bradley_ua', x: 9,   z: 12, yaw: 0 },
            { key: 'humvee_ua',  x: 18,  z: 12, yaw: 0 },
            { key: 'uaz452',     x: 27,  z: 12, yaw: 0 }
        ];

        for (const item of armorRowKeys) {
            const spec = STATS.VEHICLE_SPECS[item.key];
            const vMesh = this.instantiateStaticModel(spec.key, spec.span);
            this.scene.add(vMesh);
            const vObj = this.ragdollPhysics.createPhysicalVehicle(
                spec,
                vMesh,
                new THREE.Vector3(item.x, 0.0, item.z),
                item.yaw
            );
            if (vObj && vObj.hitProxyMesh) {
                this.staticShootableMeshes.push(vObj.hitProxyMesh);
            }
        }

        const standMat = new THREE.MeshStandardMaterial({ color: 0x2c343b, roughness: 0.7, metalness: 0.3 });
        const droneStandRow = [
            { key: 'drone_fpv',    span: 0.65, x: -10.0, z: 22.0 },
            { key: 'drone_fpv',    span: 0.65, x: -6.0,  z: 22.0 },
            { key: 'drone_lancet', span: 1.45, x: -2.0,  z: 22.0 },
            { key: 'drone_lancet', span: 1.45, x: 2.0,   z: 22.0 },
            { key: 'drone_mavic',  span: 0.52, x: 6.0,   z: 22.0 },
            { key: 'drone_mavic',  span: 0.52, x: 10.0,  z: 22.0 }
        ];
        for (const ds of droneStandRow) {
            const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.2), standMat);
            pedestal.position.set(ds.x, 0.45, ds.z);
            pedestal.castShadow = true;
            pedestal.receiveShadow = true;
            pedestal.userData.batchable = true;     // instanced by engine.lod
            this.scene.add(pedestal);
            this.addStaticObstacleCollider(pedestal, 0.95);

            const dMesh = this.instantiateStaticModel(ds.key, ds.span);
            dMesh.position.set(ds.x, 0.92, ds.z);
            this.scene.add(dMesh);
        }

        const weaponStandRow = [
            { key: 'weapon_ak12',  span: 0.95, x: -8.0, z: 25.5 },
            { key: 'weapon_m4a1',  span: 0.92, x: -4.0, z: 25.5 },
            { key: 'weapon_ak74m', span: 0.95, x: 0.0,  z: 25.5 },
            { key: 'weapon_rpg7',  span: 1.15, x: 4.0,  z: 25.5 },
            { key: 'unit_javelin', span: 1.72, x: 8.0,  z: 25.5 }
        ];
        for (const ws of weaponStandRow) {
            if (ws.key === 'unit_javelin') {
                const jav = this.instantiateStaticModel(ws.key, ws.span);
                jav.position.set(ws.x, 0, ws.z);
                jav.rotation.y = Math.PI;
                this.scene.add(jav);
            } else {
                const rack = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.85, 0.7), standMat);
                rack.position.set(ws.x, 0.425, ws.z);
                rack.castShadow = true;
                rack.userData.batchable = true;
                this.scene.add(rack);
                const wMesh = this.instantiateStaticModel(ws.key, ws.span);
                wMesh.position.set(ws.x, 0.95, ws.z);
                wMesh.rotation.y = Math.PI * 0.5;
                this.scene.add(wMesh);
            }
        }

        for (let i = 0; i < 8; i++) {
            const xPos = -10.5 + i * 3.0;
            this.spawnSoldierUnit('RU', i, new THREE.Vector3(xPos, 0, 17.5), Math.PI, true);
        }

        const btrVehicle = this.ragdollPhysics.vehicles.find((v) => v.spec.key === 'btr80_ru');
        if (btrVehicle) {
            this.mountSquadOnVehicle(btrVehicle, 4);
        }

        const fortRowZ = -24.0;
        for (let i = -20; i <= 20; i += 5.0) {
            const dtMesh = this.instantiateStaticModel('dragons_teeth', 3.4);
            dtMesh.position.set(i, 0, fortRowZ);
            this.scene.add(dtMesh);
            this.addStaticObstacleCollider(dtMesh, 0.82);
        }

        const hescoRowCoords = [-18, -12, -6, 6, 12, 18];
        for (const hx of hescoRowCoords) {
            const hesco = this.instantiateStaticModel('hesco_bastion', 4.3);
            hesco.position.set(hx, 0, -29.0);
            this.scene.add(hesco);
            this.addStaticObstacleCollider(hesco, 0.88);
        }

        const trenchTarget = this.instantiateStaticModel('trench_system', 24.0);
        trenchTarget.position.set(0, -0.25, -36.0);
        this.scene.add(trenchTarget);

        for (let i = 0; i < 12; i++) {
            const xPos = -22.0 + i * 4.0;
            this.spawnSoldierUnit('UA', i, new THREE.Vector3(xPos, 0, -31.5 - (i % 2) * 3.0), 0, false);
        }

        const enemyTargetVehicles = [
            { key: 'bmp2_ua',    x: -14, z: -42, yaw: 0 },
            { key: 'bradley_ua', x: 0,   z: -42, yaw: 0 },
            { key: 'humvee_ua',  x: 14,  z: -42, yaw: 0 }
        ];
        for (const ev of enemyTargetVehicles) {
            const spec = STATS.VEHICLE_SPECS[ev.key];
            const vMesh = this.instantiateStaticModel(spec.key, spec.span);
            this.scene.add(vMesh);
            const vObj = this.ragdollPhysics.createPhysicalVehicle(
                spec,
                vMesh,
                new THREE.Vector3(ev.x, 0.0, ev.z),
                ev.yaw
            );
            if (vObj && vObj.hitProxyMesh) {
                this.staticShootableMeshes.push(vObj.hitProxyMesh);
            }
        }

        this.spawnAutonomousDrones();
    },
};
