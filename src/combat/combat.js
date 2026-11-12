import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const combatMethods = {
    performBallisticRaycast(wStat) {
        const origin = new THREE.Vector3();
        const dir = new THREE.Vector3(0, 0, -1);
        this.getAimRay(origin, dir);

        const spread = this.isAiming ? 0.002 : 0.01;
        dir.x += (Math.random() - 0.5) * spread;
        dir.y += (Math.random() - 0.5) * spread;
        dir.z += (Math.random() - 0.5) * spread;
        dir.normalize();

        const tracerEnd = origin.clone().addScaledVector(dir, 160.0);
        this.raycaster.set(origin, dir);
        this.raycaster.far = 160.0;

        for (const u of this.units) {
            this.ragdollPhysics.syncSoldierHitboxes(u);
        }

        const targets = [...this.ragdollPhysics.hitboxMeshes, ...this.staticShootableMeshes];
        const hits = this.raycaster.intersectObjects(targets, false);

        if (hits.length > 0) {
            const hit = hits[0];
            tracerEnd.copy(hit.point);

            if (hit.object.userData && hit.object.userData.isSoldierHitbox) {
                const unit = hit.object.userData.unit;
                const zoneKey = hit.object.userData.zone;
                const partName = hit.object.userData.partName;
                this.applyBulletHitToSoldier(unit, zoneKey, partName, hit.point, dir, wStat);
            } else if (hit.object.userData && hit.object.userData.isVehicleHitbox) {
                const veh = hit.object.userData.vehicle;
                this.spawnImpactParticles(hit.point, dir.clone().negate(), 0xffaa33, 8);
                if (veh) this.ragdollPhysics.applyVehicleImpulse(veh, dir.clone().multiplyScalar(180), hit.point);
                this.events.emit('impact', { pos: hit.point, normal: hit.face ? hit.face.normal : null, dir, surface: 'metal', vehicle: veh, weapon: wStat });
            } else {
                this.spawnImpactParticles(hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0), 0x8a7962, 9);
                this.events.emit('impact', { pos: hit.point, normal: hit.face ? hit.face.normal : null, dir, surface: 'dirt', object: hit.object, weapon: wStat });
            }
        }

        this.spawnTracerBeam(
            origin.clone().addScaledVector(dir, 0.65).add(new THREE.Vector3(0, -0.06, 0)),
            tracerEnd,
            this.playerFaction === 'RU' ? 0x44ff55 : 0xff4433
        );
    },

    applyBulletHitToSoldier(unit, zoneKey, partName, hitPoint, bulletDir, wStat, attackerName = 'ВЫ') {
        if (unit.isDead) return;
        const zoneSpec = STATS.HITBOX[zoneKey] || STATS.HITBOX.TORSO;
        const finalDmg = Math.round(wStat.damage * zoneSpec.mult);
        unit.hp -= finalDmg;
        unit.flinchAmount = 1.0;
        this.events.emit('unit:hit', { unit, zone: zoneKey, part: partName, pos: hitPoint, dir: bulletDir, damage: finalDmg, attacker: attackerName, weapon: wStat });

        this.spawnImpactParticles(hitPoint, bulletDir.clone().negate(), 0x9e0b0b, zoneKey === 'HEAD' ? 22 : 13);

        if (attackerName === 'ВЫ') {
            this.sound.playHitMarker(zoneKey === 'HEAD');
            this.flashCrosshairHit(zoneKey === 'HEAD');
        }

        if (unit.hp <= 0) {
            this.killSoldierWithRagdoll(unit, zoneKey, partName, hitPoint, bulletDir, wStat, attackerName);
        }
    },

    killSoldierWithRagdoll(unit, zoneKey, partName, hitPoint, impactDir, wStat, attackerName = 'ВЫ') {
        if (unit.isDead) return;
        unit.isDead = true;
        unit.respawnCountdown = 10.0;
        this.events.emit('unit:killed', { unit, zone: zoneKey, part: partName, pos: hitPoint, dir: impactDir, attacker: attackerName, weapon: wStat });

        const momentumMag = wStat.bulletMass * wStat.muzzleVelocity * (zoneKey === 'HEAD' ? 1.55 : 1.15);
        const impulseVec = impactDir.clone().normalize().multiplyScalar(momentumMag);
        impulseVec.y += 14.0;

        if (zoneKey === 'HEAD' && unit.bones.head) {
            const headPos = new THREE.Vector3();
            unit.bones.head.getWorldPosition(headPos);
            this.ragdollPhysics.spawnFlyingHelmet(headPos, impulseVec, unit.faction);
        }

        // The animator may play a short pre-death stagger first; it then calls startRagdoll itself.
        const startRagdoll = () => this.ragdollPhysics.triggerArticulatedRagdoll(unit, partName, impulseVec, hitPoint);
        const deferred = unit.animator && typeof unit.animator.beginDeath === 'function'
            && unit.animator.beginDeath({ zone: zoneKey, part: partName, dir: impactDir, impulse: impulseVec, hitPoint }, startRagdoll) === true;
        if (!deferred) startRagdoll();

        const dist = Math.round(this.cameraMount.position.distanceTo(unit.root.position));
        if (attackerName === 'ВЫ') {
            this.killsCount++;
            if (zoneKey === 'HEAD') this.headshotsCount++;
            this.updateScoreHUD();
        }
        this.pushKillFeed(attackerName, unit.name, STATS.HITBOX[zoneKey]?.label || 'ТОРC', dist, wStat.name);
    },

    launchRpgRocket(wStat) {
        const origin = new THREE.Vector3();
        const dir = new THREE.Vector3(0, 0, -1);
        this.getAimRay(origin, dir);

        const rocketGroup = new THREE.Group();
        const bodyMesh = new THREE.Mesh(
            new THREE.ConeGeometry(0.06, 0.42, 8),
            new THREE.MeshStandardMaterial({ color: 0x3d482e, roughness: 0.5 })
        );
        bodyMesh.rotation.x = Math.PI * 0.5;
        rocketGroup.add(bodyMesh);

        const tailLight = new THREE.PointLight(0xff7722, 4.5, 9.0);
        tailLight.position.set(0, 0, 0.25);
        rocketGroup.add(tailLight);

        rocketGroup.position.copy(origin).addScaledVector(dir, 0.8);
        rocketGroup.lookAt(rocketGroup.position.clone().add(dir));
        this.scene.add(rocketGroup);

        this.projectiles.push({
            mesh: rocketGroup,
            vel: dir.multiplyScalar(wStat.muzzleVelocity),
            radius: wStat.blastRadius,
            force: wStat.blastForce,
            damage: wStat.damage,
            weaponName: wStat.name,
            sourceVehicle: null,
            ttl: 4.5
        });
    },

    triggerHighExplosiveBlast(epicenter, radius, force, maxDamage, sourceLabel = 'ОФС 125мм') {
        this.sound.playExplosion(this.cameraMount.position.distanceTo(epicenter));
        this.events.emit('explosion', { pos: epicenter, radius, force, damage: maxDamage, label: sourceLabel, kind: 'he' });

        const flashLight = new THREE.PointLight(0xff8822, 26.0, radius * 2.5);
        flashLight.position.copy(epicenter).add(new THREE.Vector3(0, 1.2, 0));
        this.scene.add(flashLight);
        this.dynamicLights.push({ light: flashLight, ttl: 0.34, maxTtl: 0.34 });

        this.spawnImpactParticles(epicenter, new THREE.Vector3(0, 1, 0), 0xff6611, 34);
        this.spawnImpactParticles(epicenter, new THREE.Vector3(0, 1, 0), 0x2a241e, 38);

        const camDist = this.cameraMount.position.distanceTo(epicenter);
        if (camDist < radius * 2.2) {
            const shake = Math.pow(1.0 - camDist / (radius * 2.2), 1.5) * 3.8;
            this.posSpring.applyImpulse((Math.random() - 0.5) * shake, shake * 0.8, shake);
            this.rotSpring.applyImpulse((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
        }

        for (const unit of this.units) {
            if (unit.isDead) continue;
            const d = unit.root.position.distanceTo(epicenter);
            if (d < radius) {
                const falloff = Math.pow(1.0 - d / radius, 1.35);
                const dmg = Math.round(maxDamage * falloff);
                unit.hp -= dmg;
                if (unit.hp <= 0) {
                    const blastDir = unit.root.position.clone().sub(epicenter).normalize();
                    blastDir.y += 0.75;
                    blastDir.normalize();
                    this.killSoldierWithRagdoll(
                        unit,
                        d < radius * 0.35 ? 'HEAD' : 'TORSO',
                        'torso',
                        unit.root.position.clone().add(new THREE.Vector3(0, 1.0, 0)),
                        blastDir,
                        { bulletMass: 1.8, muzzleVelocity: force * falloff, name: sourceLabel },
                        'ВЫ'
                    );
                }
            }
        }

        this.ragdollPhysics.applyExplosionBlastToRagdolls(epicenter, radius, force);

        for (const veh of this.ragdollPhysics.vehicles) {
            if (veh.destroyed) continue;
            const d = veh.chassisPos.distanceTo(epicenter);
            if (d < radius) {
                const dmg = Math.round(maxDamage * (1.0 - d / radius));
                this.damageVehicle(veh, { amount: dmg, pos: epicenter, kind: 'blast', attacker: 'ВЫ', label: sourceLabel });
            }
        }
    },

    // Single entry for damage to the player; the health module takes over when present.
    damagePlayer(hit) {
        if (this.health && typeof this.health.applyDamage === 'function') {
            this.health.applyDamage(hit);
            return;
        }
        this.playerHp = Math.max(0, this.playerHp - (hit.amount || 0));
        this.events.emit('player:hit', hit);
    },

    // Single entry for damage to a vehicle: hull hp here, module effects in vehicleSystems.
    damageVehicle(vehicle, hit) {
        if (!vehicle || vehicle.destroyed) return;
        vehicle.hp = Math.max(0, vehicle.hp - (hit.amount || 0));
        if (this.vehicleSystems && typeof this.vehicleSystems.applyHit === 'function') this.vehicleSystems.applyHit(vehicle, hit);
        if (vehicle.hp > 0 || vehicle.destroyed) return;
        if (this.vehicleSystems && typeof this.vehicleSystems.beginCookOff === 'function' && this.vehicleSystems.beginCookOff(vehicle, hit) === true) return;
        this.destroyVehicle(vehicle, hit);
    },

    destroyVehicle(vehicle, { attacker = 'ВЫ', label = '' } = {}) {
        if (!vehicle || vehicle.destroyed) return;
        vehicle.destroyed = true;
        vehicle.hp = 0;
        this.events.emit('vehicle:destroyed', { vehicle, attacker, label });
        this.dismountSquadFromVehicle(vehicle);
        this.ragdollPhysics.spawnBlownTurretDebris(vehicle);
        const dist = Math.round(this.cameraMount.position.distanceTo(vehicle.chassisPos));
        this.pushKillFeed(attacker, vehicle.name, 'ДЕТОНАЦИЯ БК / СРЫВ БАШНИ', dist, label);
        this.spawnImpactParticles(vehicle.chassisPos.clone().add(new THREE.Vector3(0, 1.8, 0)), new THREE.Vector3(0, 1, 0), 0xff4400, 48);
    },

    updateProjectiles(dt) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.ttl -= dt;
            p.vel.y -= 4.2 * dt;
            const nextPos = p.mesh.position.clone().addScaledVector(p.vel, dt);

            this.spawnImpactParticles(p.mesh.position, new THREE.Vector3(0, 1, 0), 0x888888, 1);

            let detonated = false;
            if (nextPos.y <= 0.15 || p.ttl <= 0) {
                detonated = true;
            } else {
                for (const u of this.units) {
                    if (!u.isDead && u.root.position.distanceTo(nextPos) < 1.6) {
                        detonated = true;
                        break;
                    }
                }
                for (const v of this.ragdollPhysics.vehicles) {
                    if (v === p.sourceVehicle) continue;
                    if (v.chassisPos.distanceTo(nextPos) < 3.4) {
                        detonated = true;
                        break;
                    }
                }
            }

            if (detonated) {
                this.triggerHighExplosiveBlast(nextPos, p.radius, p.force, p.damage, p.weaponName);
                this.scene.remove(p.mesh);
                this.projectiles.splice(i, 1);
            } else {
                p.mesh.position.copy(nextPos);
            }
        }
    },
};
