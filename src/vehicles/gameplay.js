import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const vehicleGameplayMethods = {
    mountSquadOnVehicle(vehicle, maxToMount = 6) {
        if (!vehicle || vehicle.destroyed) return 0;
        let mountedCount = 0;
        const availableAllies = this.units.filter((u) => !u.isDead && u.isAlliedDesant && !u.mountedVehicle);

        for (let sIdx = 0; sIdx < vehicle.desantUnits.length; sIdx++) {
            if (vehicle.desantUnits[sIdx] !== null) continue;
            if (vehicle.playerSeatedMode === 'DESANT' && vehicle.playerDesantSlot === sIdx) continue;
            const soldier = availableAllies.shift();
            if (!soldier) break;

            vehicle.desantUnits[sIdx] = soldier;
            soldier.mountedVehicle = vehicle;
            if (soldier.bones.upperLegL && soldier.bones.upperLegR) {
                soldier.bones.upperLegL.rotation.x = -0.65;
                soldier.bones.upperLegR.rotation.x = -0.65;
            }
            mountedCount++;
            if (mountedCount >= maxToMount) break;
        }
        return mountedCount;
    },

    dismountSquadFromVehicle(vehicle) {
        if (!vehicle) return 0;
        let count = 0;
        for (let sIdx = 0; sIdx < vehicle.desantUnits.length; sIdx++) {
            const soldier = vehicle.desantUnits[sIdx];
            if (!soldier) continue;
            vehicle.desantUnits[sIdx] = null;
            soldier.mountedVehicle = null;

            const sideSign = (sIdx % 2 === 0) ? -1 : 1;
            const dropOffset = new THREE.Vector3(
                sideSign * (vehicle.spec.halfExtents[0] + 1.4),
                0,
                (sIdx - 2) * 1.1
            ).applyQuaternion(vehicle.chassisQuat);

            soldier.root.position.copy(vehicle.chassisPos).add(dropOffset);
            soldier.root.position.y = 0.0;
            soldier.moveTarget.copy(soldier.root.position).add(new THREE.Vector3(0, 0, -6.0));
            if (soldier.bones.upperLegL && soldier.bones.upperLegR) {
                soldier.bones.upperLegL.rotation.x = 0;
                soldier.bones.upperLegR.rotation.x = 0;
            }
            count++;
        }
        return count;
    },

    toggleSquadTransportOnNearestVehicle() {
        const targetVeh = this.playerVehicleState.vehicle || this.nearestInteractVehicle;
        if (!targetVeh) return;

        const currentlyMounted = targetVeh.desantUnits.filter((u) => u !== null).length;
        const banner = document.getElementById('squad-order-banner');
        this.sound.playReloadClick(780);

        if (currentlyMounted > 0) {
            const dismounted = this.dismountSquadFromVehicle(targetVeh);
            if (banner) {
                banner.textContent = `ДЕСАНТ СПЕШЕН С БРОНИ [${targetVeh.name}]: ${dismounted} БОЙЦОВ ВСТУПИЛИ В БОЙ`;
                banner.classList.add('active-assault');
            }
        } else {
            const mounted = this.mountSquadOnVehicle(targetVeh, targetVeh.spec.desantSlots.length);
            if (banner) {
                banner.textContent = `ДЕСАНТ ПОСАЖЕН НА БРОНЮ [${targetVeh.name}]: ${mounted} БОЙЦОВ НА БРОНЕ`;
                banner.classList.remove('active-assault');
            }
        }
    },

    enterVehicleAsDriver(vehicle) {
        if (!vehicle || vehicle.destroyed) return;
        if (this.playerVehicleState.vehicle) {
            this.exitCurrentVehicle();
        }
        this.playerVehicleState.vehicle = vehicle;
        this.playerVehicleState.role = 'DRIVER';
        this.playerVehicleState.desantSlotIndex = -1;
        this.playerVehicleState.thirdPersonCamera = true;
        vehicle.playerSeatedMode = 'DRIVER';
        vehicle.turretYaw = this.yaw;
        vehicle.turretPitch = 0;

        this.viewmodelRoot.visible = false;
        this.sound.playReloadClick(520);
        this.updateWeaponHUD();
    },

    enterVehicleAsArmorDesant(vehicle) {
        if (!vehicle || vehicle.destroyed) return;
        if (this.playerVehicleState.vehicle) {
            this.exitCurrentVehicle();
        }

        let freeSlot = -1;
        for (let i = 0; i < vehicle.desantSlots?.length || vehicle.spec.desantSlots.length; i++) {
            if (vehicle.desantUnits[i] === null) {
                freeSlot = i;
                break;
            }
        }
        if (freeSlot === -1) freeSlot = 0;

        this.playerVehicleState.vehicle = vehicle;
        this.playerVehicleState.role = 'DESANT';
        this.playerVehicleState.desantSlotIndex = freeSlot;
        this.playerVehicleState.thirdPersonCamera = false;
        vehicle.playerSeatedMode = 'DESANT';
        vehicle.playerDesantSlot = freeSlot;

        this.viewmodelRoot.visible = true;
        this.sound.playReloadClick(640);
        this.updateWeaponHUD();
    },

    exitCurrentVehicle() {
        const veh = this.playerVehicleState.vehicle;
        if (!veh) return;

        veh.controls.throttle = 0;
        veh.controls.steer = 0;
        veh.controls.brake = true;
        veh.playerSeatedMode = null;
        veh.playerDesantSlot = -1;

        const exitOffset = new THREE.Vector3(-(veh.spec.halfExtents[0] + 1.65), 0, 0).applyQuaternion(veh.chassisQuat);
        const exitPos = veh.chassisPos.clone().add(exitOffset);
        exitPos.y = Math.max(0.36, exitPos.y + 0.36);

        this.playerCollider.start.set(exitPos.x, exitPos.y, exitPos.z);
        this.playerCollider.end.set(exitPos.x, exitPos.y + 1.08, exitPos.z);
        this.playerVelocity.set(0, 0, 0);

        this.playerVehicleState.vehicle = null;
        this.playerVehicleState.role = null;
        this.playerVehicleState.desantSlotIndex = -1;

        this.viewmodelRoot.visible = !this.fpvMode.active;
        this.sound.updateVehicleEngineSound(false, 0, 0);
        this.sound.playReloadClick(420);
        this.updateWeaponHUD();
    },

    toggleVehicleAutopilot() {
        const veh = this.playerVehicleState.vehicle || this.nearestInteractVehicle;
        if (!veh || veh.destroyed) return;
        veh.controls.aiAutopilot = !veh.controls.aiAutopilot;
        if (!veh.controls.aiAutopilot) {
            veh.controls.throttle = 0;
            veh.controls.brake = true;
        }
        this.sound.playReloadClick(910);
        const banner = document.getElementById('squad-order-banner');
        if (banner) {
            banner.textContent = veh.controls.aiAutopilot
                ? `АВТОПИЛОТ МЕХВОДА [${veh.name}]: ВКЛЮЧЕН (ДВИЖЕНИЕ С ДЕСАНТОМ НА БРОНЕ)`
                : `АВТОПИЛОТ МЕХВОДА [${veh.name}]: ОСТАНОВЛЕН`;
        }
    },

    // World muzzle position and bore direction: the visual rig answers when present, else the spec offset.
    getVehicleMuzzle(vehicle, outPos, outDir) {
        if (this.vehicleParts && typeof this.vehicleParts.getMuzzle === 'function'
            && this.vehicleParts.getMuzzle(vehicle, outPos, outDir) === true) return;
        const m = vehicle.spec.muzzleOffset;
        outPos.set(m[0], m[1], m[2]).applyQuaternion(vehicle.chassisQuat).add(vehicle.chassisPos);
        const yaw = vehicle.turretYaw;
        const pitch = vehicle.turretPitch;
        outDir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
    },

    tryFireVehicleWeapon(vehicle) {
        if (!vehicle || vehicle.destroyed) return;
        const now = performance.now() * 0.001;
        if (now - vehicle.fireTimer < vehicle.spec.fireCooldown) return;
        vehicle.fireTimer = now;

        const muzzleWorld = new THREE.Vector3();
        const aimDir = new THREE.Vector3();
        this.getVehicleMuzzle(vehicle, muzzleWorld, aimDir);

        this.sound.playGunshot(0, vehicle.spec.isHeavyCannon);
        this.events.emit('vehicle:fired', { vehicle, pos: muzzleWorld, dir: aimDir, heavy: vehicle.spec.isHeavyCannon, isPlayer: true });
        this.ragdollPhysics.applyCannonRecoil(vehicle, aimDir);

        const flashLight = new THREE.PointLight(0xffaa33, vehicle.spec.isHeavyCannon ? 28.0 : 12.0, 18.0);
        flashLight.position.copy(muzzleWorld);
        this.scene.add(flashLight);
        this.dynamicLights.push({ light: flashLight, ttl: 0.14, maxTtl: 0.14 });

        if (vehicle.spec.isHeavyCannon) {
            const shellGroup = new THREE.Group();
            const shellMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8),
                new THREE.MeshBasicMaterial({ color: 0xffbb44 })
            );
            shellMesh.rotation.x = Math.PI * 0.5;
            shellGroup.add(shellMesh);
            shellGroup.position.copy(muzzleWorld);
            shellGroup.lookAt(muzzleWorld.clone().add(aimDir));
            this.scene.add(shellGroup);

            this.projectiles.push({
                mesh: shellGroup,
                vel: aimDir.clone().multiplyScalar(vehicle.spec.shellVelocity),
                radius: vehicle.spec.blastRadius,
                force: vehicle.spec.blastForce,
                damage: vehicle.spec.damage,
                weaponName: `${vehicle.name} (${vehicle.spec.weaponName})`,
                sourceVehicle: vehicle,
                ttl: 4.5
            });
        } else {
            const endPoint = muzzleWorld.clone().addScaledVector(aimDir, 180.0);
            this.raycaster.set(muzzleWorld, aimDir);
            this.raycaster.far = 180.0;

            for (const u of this.units) {
                this.ragdollPhysics.syncSoldierHitboxes(u);
            }
            const targets = [...this.ragdollPhysics.hitboxMeshes, ...this.staticShootableMeshes];
            const hits = this.raycaster.intersectObjects(targets, false);

            for (const hit of hits) {
                if (hit.object === vehicle.hitProxyMesh) continue;
                endPoint.copy(hit.point);
                if (hit.object.userData && hit.object.userData.isSoldierHitbox) {
                    const unit = hit.object.userData.unit;
                    const zoneKey = hit.object.userData.zone;
                    const partName = hit.object.userData.partName;
                    this.applyBulletHitToSoldier(
                        unit,
                        zoneKey,
                        partName,
                        hit.point,
                        aimDir,
                        {
                            damage: vehicle.spec.damage,
                            bulletMass: 0.18,
                            muzzleVelocity: 940,
                            name: `${vehicle.name} (${vehicle.spec.weaponName})`
                        },
                        'ВЫ'
                    );
                } else {
                    this.triggerHighExplosiveBlast(
                        hit.point,
                        vehicle.spec.blastRadius,
                        vehicle.spec.blastForce,
                        vehicle.spec.damage,
                        `${vehicle.name} (${vehicle.spec.weaponName})`
                    );
                }
                break;
            }
            this.spawnTracerBeam(muzzleWorld, endPoint, 0xffaa22);
        }
    },

    updateNearestVehiclePrompt() {
        const promptEl = document.getElementById('vehicle-interact-prompt');
        if (!promptEl) return;

        if (this.fpvMode.active) {
            promptEl.style.display = 'none';
            return;
        }

        if (this.playerVehicleState.vehicle) {
            const v = this.playerVehicleState.vehicle;
            const desantCount = v.desantUnits.filter((u) => u !== null).length;
            const roleStr = this.playerVehicleState.role === 'DRIVER' ? 'МЕХВОД + НАВОДЧИК' : 'ДЕСАНТ НА БРОНЕ (СТРЕЛЬБА С ХОДУ)';
            promptEl.style.display = 'block';
            promptEl.innerHTML = `
                <b>${v.name}</b> [${roleStr}] | СКОРОСТЬ: <b>${v.speedKmh} КМ/Ч</b> | БРОНЯ: <b>${v.hp}/${v.maxHp}</b> | ДЕСАНТ НА БРОНЕ: <b>${desantCount}/${v.spec.desantSlots.length}</b><br>
                <b>[F]</b> Спешиться &nbsp; <b>[B]</b> Пересесть на броню/внутрь &nbsp; <b>[H]</b> Посадить/Спешить отряд десанта &nbsp; <b>[T]</b> Автопилот мехвода &nbsp; <b>[K]</b> Камера 1-е/3-е лицо
            `;
            return;
        }

        let bestVeh = null;
        let bestDist = 7.2;
        const playerPos = this.playerCollider.start;

        for (const veh of this.ragdollPhysics.vehicles) {
            if (veh.destroyed) continue;
            const d = veh.chassisPos.distanceTo(playerPos);
            if (d < bestDist) {
                bestDist = d;
                bestVeh = veh;
            }
        }

        this.nearestInteractVehicle = bestVeh;
        if (bestVeh) {
            const desantCount = bestVeh.desantUnits.filter((u) => u !== null).length;
            promptEl.style.display = 'block';
            promptEl.innerHTML = `
                РЯДОМ: <b>${bestVeh.name}</b> — ${bestVeh.spec.role} (Десант на броне: <b>${desantCount}/${bestVeh.spec.desantSlots.length}</b>)<br>
                <b>[F]</b> Управлять (${bestVeh.spec.weaponName}) &nbsp; <b>[B]</b> Сесть десантом НА БРОНЮ &nbsp; <b>[H]</b> Посадить/Спешить пехоту на броню
            `;
        } else {
            promptEl.style.display = 'none';
        }
    },

    updatePlayerInVehicle(dt) {
        const veh = this.playerVehicleState.vehicle;
        if (!veh || veh.destroyed) {
            this.exitCurrentVehicle();
            return;
        }

        if (this.playerVehicleState.role === 'DRIVER') {
            let throttle = 0;
            let steer = 0;
            if (this.keys['KeyW']) throttle += 1.0;
            if (this.keys['KeyS']) throttle -= 0.85;
            if (this.keys['KeyA']) steer += 1.0;
            if (this.keys['KeyD']) steer -= 1.0;
            throttle = Math.max(-0.85, Math.min(1.0, throttle + this.input.axes.moveY));
            steer = Math.max(-1.0, Math.min(1.0, steer - this.input.axes.moveX));

            veh.controls.throttle = throttle;
            veh.controls.steer = steer;
            veh.controls.brake = Boolean(this.keys['Space']);

            this.sound.updateVehicleEngineSound(true, veh.speedKmh, throttle);

            const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
            const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch);
            const lookQuat = qYaw.multiply(qPitch);

            if (this.playerVehicleState.thirdPersonCamera) {
                const pivot = veh.chassisPos.clone().add(new THREE.Vector3(0, veh.spec.chaseCamOffset[1] * 0.62, 0));
                const backVec = new THREE.Vector3(0, 1.4, veh.spec.chaseCamOffset[2]).applyQuaternion(lookQuat);
                this.cameraMount.position.copy(pivot).add(backVec);
                if (this.cameraMount.position.y < 0.6) this.cameraMount.position.y = 0.6;
                this.camera.quaternion.copy(lookQuat);
            } else {
                const camLocal = new THREE.Vector3(
                    veh.spec.driverCamOffset[0],
                    veh.spec.driverCamOffset[1],
                    veh.spec.driverCamOffset[2]
                ).applyQuaternion(veh.chassisQuat);
                this.cameraMount.position.copy(veh.chassisPos).add(camLocal);
                this.camera.quaternion.copy(lookQuat);
            }

            if (this.isFiring) {
                this.tryFireVehicleWeapon(veh);
            }
        } else if (this.playerVehicleState.role === 'DESANT') {
            const slotIdx = Math.max(0, Math.min(this.playerVehicleState.desantSlotIndex, veh.spec.desantSlots.length - 1));
            const slot = veh.spec.desantSlots[slotIdx];
            const seatWorld = new THREE.Vector3(slot[0], slot[1] + 0.95, slot[2])
                .applyQuaternion(veh.chassisQuat)
                .add(veh.chassisPos);

            this.cameraMount.position.copy(seatWorld);
            this.playerCollider.start.copy(seatWorld).add(new THREE.Vector3(0, -0.9, 0));
            this.playerCollider.end.copy(seatWorld);

            this.sound.updateVehicleEngineSound(true, veh.speedKmh, veh.controls.throttle);

            const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
            const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch);
            this.camera.quaternion.copy(qYaw).multiply(qPitch);

            this.updateViewmodelTransform(dt, 0, 0);
            const activeKey = this.loadoutKeys[this.currentWeaponIdx];
            const wStat = STATS.WEAPONS[activeKey];
            if (this.isFiring && !wStat.isExplosive) {
                this.tryFireCurrentWeapon();
            }
        }
    },
};
