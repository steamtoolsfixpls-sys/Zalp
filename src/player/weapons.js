import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const playerWeaponMethods = {
    setupViewmodelMeshes() {
        for (const key of this.loadoutKeys) {
            const wStat = STATS.WEAPONS[key];
            const wState = this.weaponStates[key];
            const group = new THREE.Group();
            const model = this.instantiateStaticModel(wStat.modelKey, wStat.scale);
            model.rotation.set(wStat.rotOffset[0], wStat.rotOffset[1], wStat.rotOffset[2]);
            group.add(model);
            group.visible = (key === this.loadoutKeys[this.currentWeaponIdx]);
            this.viewmodelRoot.add(group);
            wState.meshGroup = group;
        }
    },

    switchWeapon(index) {
        if (index < 0 || index >= this.loadoutKeys.length) return;
        this.currentWeaponIdx = index;
        const activeKey = this.loadoutKeys[this.currentWeaponIdx];
        for (const k of this.loadoutKeys) {
            const st = this.weaponStates[k];
            if (st.meshGroup) st.meshGroup.visible = (k === activeKey);
        }
        this.posSpring.applyImpulse(0, -1.2, 0.6);
        this.rotSpring.applyImpulse(-1.8, 0, 0.8);
        this.sound.playReloadClick(520);
        this.updateWeaponHUD();
    },

    triggerTacticalReload() {
        const key = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[key];
        const wState = this.weaponStates[key];
        if (wState.reloading || wState.reserve <= 0) return;

        const maxPossible = wState.chambered ? wStat.magCapacity + 1 : wStat.magCapacity;
        if (wState.mag >= maxPossible) return;

        wState.reloading = true;
        if (wState.mag > 0) {
            wState.reloadState = 'TACTICAL_RELOAD';
            wState.reloadTotal = wStat.tacticalReloadTime;
            wState.chambered = true;
            wState.mag -= 1;
        } else {
            wState.reloadState = 'DRY_RELOAD';
            wState.reloadTotal = wStat.dryReloadTime;
            wState.chambered = false;
        }
        wState.reloadTimer = wState.reloadTotal;
        this.sound.playReloadClick(440);
        this.posSpring.applyImpulse(0, -1.6, 0.4);
        this.rotSpring.applyImpulse(-2.4, 0.6, 1.4);
        this.updateWeaponHUD();
    },

    updateReloadStateMachine(dt) {
        const key = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[key];
        const wState = this.weaponStates[key];
        if (!wState.reloading) return;

        wState.reloadTimer -= dt;
        if (wState.reloadTimer <= 0) {
            const needed = wStat.magCapacity - wState.mag;
            const take = Math.min(needed, wState.reserve);
            wState.mag += take;
            wState.reserve -= take;

            if (wState.chambered && wState.reserve > 0) {
                wState.mag += 1;
                wState.reserve -= 1;
            } else if (!wState.chambered && wState.mag > 0) {
                wState.chambered = true;
            }

            wState.reloading = false;
            wState.reloadState = 'READY';
            this.sound.playReloadClick(760);
            this.posSpring.applyImpulse(0, 0.9, -0.5);
            this.rotSpring.applyImpulse(1.5, -0.3, -0.9);
            this.updateWeaponHUD();
        }
    },

    tryFireCurrentWeapon() {
        if (this.fpvMode.active || this.playerVehicleState.role === 'DRIVER') return;
        const key = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[key];
        const wState = this.weaponStates[key];
        if (wState.reloading) return;

        const now = performance.now() * 0.001;
        const interval = 60.0 / wStat.rpm;
        if (now - wState.lastFireTime < interval) return;

        if (wState.mag <= 0) {
            wState.chambered = false;
            this.sound.playReloadClick(310);
            this.triggerTacticalReload();
            return;
        }

        wState.lastFireTime = now;
        wState.mag -= 1;
        if (wState.mag === 0) wState.chambered = false;
        this.updateWeaponHUD();

        this.sound.playGunshot(0, wStat.isExplosive);
        this.events.emit('shot', {
            pos: this.camera.getWorldPosition(new THREE.Vector3()),
            dir: new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion),
            weapon: wStat,
            shooter: null,
            isPlayer: true,
            faction: this.playerFaction
        });
        this.muzzleLight.intensity = wStat.isExplosive ? 12.0 : 6.5;

        const adsMult = this.isAiming ? 0.58 : 1.0;
        this.posSpring.applyImpulse(
            (Math.random() - 0.5) * 0.45 * adsMult,
            wStat.recoilRise * 28.0 * adsMult,
            wStat.recoilKickBack * 42.0 * adsMult
        );
        this.rotSpring.applyImpulse(
            wStat.recoilPitch * 32.0 * adsMult,
            (Math.random() - 0.5) * wStat.recoilYaw * 48.0 * adsMult,
            (Math.random() - 0.5) * wStat.recoilRoll * 40.0 * adsMult
        );

        this.pitch = Math.min(1.35, this.pitch + wStat.recoilPitch * 0.19 * adsMult);
        this.yaw += (Math.random() - 0.5) * wStat.recoilYaw * 0.25 * adsMult;

        if (!wStat.isExplosive) {
            this.spawnBrassCasing();
            this.performBallisticRaycast(wStat);
        } else {
            this.launchRpgRocket(wStat);
        }
    },

    updateViewmodelTransform(dt, bobX = 0, bobY = 0) {
        this.posSpring.update(dt);
        this.rotSpring.update(dt);

        const activeKey = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[activeKey];
        const basePos = this.isAiming ? wStat.adsPos : wStat.hipPos;

        this.viewmodelRoot.position.set(
            basePos[0] + bobX * 0.45 + this.posSpring.position.x - this.smoothYawVel * 0.12,
            basePos[1] + bobY * 0.45 + this.posSpring.position.y + this.smoothPitchVel * 0.12,
            basePos[2] + this.posSpring.position.z
        );
        this.viewmodelRoot.rotation.set(
            this.rotSpring.position.x,
            this.rotSpring.position.y,
            this.rotSpring.position.z - this.currentLean * 0.15
        );
    },
};
