import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const squadAiMethods = {
    issueSquadAssaultOrder() {
        this.squadOrderMode = this.squadOrderMode === 'ASSAULT' ? 'HOLD' : 'ASSAULT';
        this.sound.playReloadClick(880);
        this.events.emit('order', { type: this.squadOrderMode });
        const orderBanner = document.getElementById('squad-order-banner');
        if (orderBanner) {
            orderBanner.textContent = this.squadOrderMode === 'ASSAULT'
                ? 'ПРИКАЗ ОТРЯДУ: ШТУРМ РУБЕЖА ПРОТИВНИКА [АКТИВЕН]'
                : 'ПРИКАЗ ОТРЯДУ: ВЕРНУТЬСЯ К БРОНЕТЕХНИКЕ [G — ШТУРМ]';
            orderBanner.classList.toggle('active-assault', this.squadOrderMode === 'ASSAULT');
        }
    },

    updateUnitsAndSquadAI(dt) {
        for (const unit of this.units) {
            if (unit.isDead) {
                unit.respawnCountdown -= dt;
                if (unit.respawnCountdown <= 0) {
                    this.respawnDeadSoldier(unit);
                }
                continue;
            }

            let nearestEnemy = null;
            let bestDist = 110.0;
            for (const other of this.units) {
                if (other.isDead || other.faction === unit.faction) continue;
                const d = unit.root.position.distanceTo(other.root.position);
                if (d < bestDist) {
                    bestDist = d;
                    nearestEnemy = other;
                }
            }

            if (unit.mountedVehicle) {
                unit.flinchAmount = Math.max(0, unit.flinchAmount - dt * 4.5);
                unit.fireTimer -= dt;
                if (unit.fireTimer <= 0 && nearestEnemy && bestDist < 85.0) {
                    unit.fireTimer = 0.9 + Math.random() * 1.4;
                    const muzzlePos = unit.root.position.clone().add(new THREE.Vector3(0, 1.25, 0));
                    const targetPos = nearestEnemy.root.position.clone().add(new THREE.Vector3(
                        (Math.random() - 0.5) * 1.8,
                        0.9 + Math.random() * 0.6,
                        (Math.random() - 0.5) * 1.8
                    ));
                    this.spawnTracerBeam(muzzlePos, targetPos, unit.faction === 'RU' ? 0x44ff55 : 0xff4433);
                    this.events.emit('shot', { pos: muzzlePos, dir: targetPos.clone().sub(muzzlePos).normalize(), weapon: unit.faction === 'RU' ? STATS.WEAPONS.ak12 : STATS.WEAPONS.m4a1, shooter: unit, isPlayer: false, faction: unit.faction });
                    const distToCam = this.cameraMount.position.distanceTo(muzzlePos);
                    if (distToCam < 65.0) {
                        this.sound.playGunshot(distToCam, false);
                    }
                    if (Math.random() < 0.24) {
                        const shotDir = targetPos.clone().sub(muzzlePos).normalize();
                        const wUsed = unit.faction === 'RU' ? STATS.WEAPONS.ak12 : STATS.WEAPONS.m4a1;
                        this.applyBulletHitToSoldier(nearestEnemy, 'TORSO', 'torso', targetPos, shotDir, wUsed, `${unit.name} (С БРОНИ)`);
                    }
                }
                continue;
            }

            if (unit.isAlliedDesant) {
                if (this.squadOrderMode === 'ASSAULT' && nearestEnemy) {
                    unit.moveTarget.copy(nearestEnemy.root.position).add(new THREE.Vector3(0, 0, 12.0));
                } else {
                    unit.moveTarget.copy(unit.homePos);
                }
            }

            const toWaypoint = unit.moveTarget.clone().sub(unit.root.position);
            toWaypoint.y = 0;
            const distToWp = toWaypoint.length();
            let isMoving = false;

            if (distToWp > 0.6) {
                isMoving = true;
                toWaypoint.normalize();
                const moveSpd = this.squadOrderMode === 'ASSAULT' ? 4.8 : 3.4;
                unit.root.position.x += toWaypoint.x * moveSpd * dt;
                unit.root.position.z += toWaypoint.z * moveSpd * dt;
            }

            if (nearestEnemy) {
                const dx = nearestEnemy.root.position.x - unit.root.position.x;
                const dz = nearestEnemy.root.position.z - unit.root.position.z;
                const desiredYaw = Math.atan2(dx, dz);
                unit.root.rotation.y = THREE.MathUtils.lerp(unit.root.rotation.y, desiredYaw, Math.min(1.0, dt * 6.0));
            } else {
                unit.root.rotation.y = THREE.MathUtils.lerp(unit.root.rotation.y, unit.homeYaw, Math.min(1.0, dt * 4.0));
            }

            unit.animPhase += dt * (isMoving ? 9.2 : 2.2);
            unit.flinchAmount = Math.max(0, unit.flinchAmount - dt * 4.5);

            const b = unit.bones;
            if (b.upperLegL && b.upperLegR) {
                if (isMoving) {
                    const swing = Math.sin(unit.animPhase) * 0.42;
                    b.upperLegL.rotation.x = swing;
                    b.upperLegR.rotation.x = -swing;
                } else {
                    b.upperLegL.rotation.x = 0;
                    b.upperLegR.rotation.x = 0;
                }
            }
            if (b.chest) {
                b.chest.rotation.x = Math.sin(unit.animPhase * 0.5) * 0.04 - unit.flinchAmount * 0.38;
            }

            unit.fireTimer -= dt;
            if (unit.fireTimer <= 0 && nearestEnemy && bestDist < 75.0 && this.squadOrderMode === 'ASSAULT') {
                unit.fireTimer = 1.1 + Math.random() * 1.5;
                const muzzlePos = unit.root.position.clone().add(new THREE.Vector3(0, 1.38, 0));
                const targetPos = nearestEnemy.root.position.clone().add(new THREE.Vector3(
                    (Math.random() - 0.5) * 1.6,
                    0.9 + Math.random() * 0.7,
                    (Math.random() - 0.5) * 1.6
                ));

                this.spawnTracerBeam(muzzlePos, targetPos, unit.faction === 'RU' ? 0x44ff55 : 0xff4433);
                this.events.emit('shot', { pos: muzzlePos, dir: targetPos.clone().sub(muzzlePos).normalize(), weapon: unit.faction === 'RU' ? STATS.WEAPONS.ak12 : STATS.WEAPONS.m4a1, shooter: unit, isPlayer: false, faction: unit.faction });
                const distToCam = this.cameraMount.position.distanceTo(muzzlePos);
                if (distToCam < 65.0) {
                    this.sound.playGunshot(distToCam, false);
                }
                if (Math.random() < 0.2) {
                    const shotDir = targetPos.clone().sub(muzzlePos).normalize();
                    const wUsed = unit.faction === 'RU' ? STATS.WEAPONS.ak12 : STATS.WEAPONS.m4a1;
                    this.applyBulletHitToSoldier(nearestEnemy, 'TORSO', 'torso', targetPos, shotDir, wUsed, unit.name);
                }
            }
        }
    },
};
