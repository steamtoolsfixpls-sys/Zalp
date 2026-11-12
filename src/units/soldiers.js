import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const soldierMethods = {
    instantiateSkinnedSoldier(faction) {
        const key = faction === 'RU' ? 'soldier_ru' : 'soldier_ua';
        const root = new THREE.Group();
        const built = this.assets.instantiateSkinned(key, 1.82);

        if (!built) {
            const fallback = new THREE.Mesh(
                new THREE.CapsuleGeometry(0.28, 1.25, 6, 12),
                new THREE.MeshStandardMaterial({ color: faction === 'RU' ? 0x3b4832 : 0x525840 })
            );
            fallback.position.y = 0.9;
            root.add(fallback);
            return { root, bones: {} };
        }

        const clonedScene = built.model;
        root.add(clonedScene);
        const bones = this.ragdollPhysics.extractSoldierBones(clonedScene);

        const bandColor = faction === 'RU' ? 0xd91b1b : 0x155ce6;
        const bandMat = new THREE.MeshStandardMaterial({
            color: bandColor,
            roughness: 0.55,
            metalness: 0.08,
            emissive: bandColor,
            emissiveIntensity: 0.18
        });

        const attachBoneArmband = (armBone) => {
            if (!armBone) return;
            const bandGeo = new THREE.CylinderGeometry(8.5, 8.5, 11.0, 14);
            const bandMesh = new THREE.Mesh(bandGeo, bandMat);
            bandMesh.position.set(0, 12.0, 0);
            armBone.add(bandMesh);
        };
        attachBoneArmband(bones.upperArmL);
        attachBoneArmband(bones.upperArmR);

        const weaponKey = faction === 'RU' ? 'weapon_ak12' : 'weapon_m4a1';
        const rifleMesh = this.instantiateStaticModel(weaponKey, 0.78);
        if (bones.chest) {
            rifleMesh.position.set(0.16, -0.05, 0.34);
            rifleMesh.rotation.set(0, Math.PI, 0);
            root.add(rifleMesh);
            root.userData.rifleMesh = rifleMesh;
        }

        return { root, bones, modelNode: clonedScene };
    },

    spawnSoldierUnit(faction, slotIndex, customPos = null, customYaw = 0, isAlliedDesant = false) {
        const built = this.instantiateSkinnedSoldier(faction);
        const pos = customPos || new THREE.Vector3((slotIndex - 4) * 3.5, 0, faction === 'RU' ? 17.5 : -31.5);
        built.root.position.copy(pos);
        built.root.rotation.y = customYaw;
        this.scene.add(built.root);

        const unit = {
            id: `${faction}_${slotIndex}_${Math.floor(Math.random() * 9999)}`,
            name: faction === 'RU' ? `Десантник ВС РФ #${slotIndex + 1}` : `Боец ВСУ #${slotIndex + 1}`,
            faction,
            role: 'rifleman',
            weaponKey: faction === 'RU' ? 'ak12' : 'm4a1',
            slotIndex,
            isAlliedDesant,
            homePos: pos.clone(),
            homeYaw: customYaw,
            root: built.root,
            bones: built.bones,
            hp: 100,
            maxHp: 100,
            isDead: false,
            mountedVehicle: null,
            animPhase: Math.random() * Math.PI * 2,
            flinchAmount: 0,
            fireTimer: 0.8 + Math.random() * 1.5,
            moveTarget: pos.clone(),
            velocity: new THREE.Vector3(),
            stance: 'stand',
            aimPoint: null,
            suppression: 0,
            isWounded: false,
            respawnCountdown: 0,
            hitboxes: []
        };

        this.ragdollPhysics.attachAnatomicalHitboxes(unit);
        this.units.push(unit);
        return unit;
    },

    respawnDeadSoldier(unit) {
        this.ragdollPhysics.removeRagdoll(unit);

        this.scene.remove(unit.root);
        const built = this.instantiateSkinnedSoldier(unit.faction);
        built.root.position.copy(unit.homePos);
        built.root.rotation.y = unit.homeYaw;
        this.scene.add(built.root);

        unit.root = built.root;
        unit.bones = built.bones;
        unit.hp = unit.maxHp;
        unit.isDead = false;
        unit.mountedVehicle = null;
        this.ragdollPhysics.attachAnatomicalHitboxes(unit);
    },
};
