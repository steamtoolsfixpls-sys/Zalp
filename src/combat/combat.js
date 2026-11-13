import * as THREE from 'three';
import { STATS } from '../../stats.js';
import { WEAPON_AMMO, AMMO } from './ammo_data.js';
import { armorFor } from './armor_data.js';

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _from = new THREE.Vector3();
const _push = new THREE.Vector3();

export const combatMethods = {
    // Fires one physical round for the player: the swept projectile starts at the aim ray and lives in `ballistics`.
    performBallisticRaycast(wStat) {
        this.getAimRay(_origin, _dir);
        const sway = typeof this.modifier === 'function' ? this.modifier('aimSway') : 1;
        const spread = (this.isAiming ? 0.0012 : 0.006) * sway;
        if (this.ballistics && typeof this.ballistics.fire === 'function') {
            const pv = this.playerVehicleState;
            this.ballistics.fire({
                origin: _origin, dir: _dir, weapon: wStat, ammo: WEAPON_AMMO[wStat.id], isPlayer: true, faction: this.playerFaction,
                spread, vehicle: pv && pv.role === 'DESANT' ? pv.vehicle : null, emitShot: false, attacker: 'ВЫ'
            });
            return;
        }
        this._legacyPlayerRaycast(wStat, spread);
    },

    // Instant hit-scan, only used while the ballistics module is unavailable.
    _legacyPlayerRaycast(wStat, spread) {
        const origin = _origin.clone();
        const dir = _dir.clone();
        dir.x += (Math.random() - 0.5) * spread;
        dir.y += (Math.random() - 0.5) * spread;
        dir.z += (Math.random() - 0.5) * spread;
        dir.normalize();
        const tracerEnd = origin.clone().addScaledVector(dir, 160.0);
        this.raycaster.set(origin, dir);
        this.raycaster.far = 160.0;
        for (const u of this.units) this.ragdollPhysics.syncSoldierHitboxes(u);
        const hits = this.raycaster.intersectObjects([...this.ragdollPhysics.hitboxMeshes, ...this.staticShootableMeshes], false);
        if (hits.length > 0) {
            const hit = hits[0];
            tracerEnd.copy(hit.point);
            const ud = hit.object.userData || {};
            if (ud.isSoldierHitbox) this.applyBulletHitToSoldier(ud.unit, ud.zone, ud.partName, hit.point, dir, wStat);
            else this.spawnImpactParticles(hit.point, hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0), 0x8a7962, 8);
        }
        this.spawnTracerBeam(origin.clone().addScaledVector(dir, 0.65), tracerEnd, this.playerFaction === 'RU' ? 0x44ff55 : 0xff4433);
    },

    applyBulletHitToSoldier(unit, zoneKey, partName, hitPoint, bulletDir, wStat, attackerName = 'ВЫ') {
        if (unit.isDead) return;
        const zoneSpec = STATS.HITBOX[zoneKey] || STATS.HITBOX.TORSO;
        const finalDmg = Math.round(wStat.damage * zoneSpec.mult);
        unit.hp -= finalDmg;
        unit.flinchAmount = 1.0;
        this.events.emit('unit:hit', { unit, zone: zoneKey, part: partName, pos: hitPoint, dir: bulletDir, damage: finalDmg, attacker: attackerName, weapon: wStat });

        if (this.vfx && typeof this.vfx.blood === 'function') {
            this.vfx.blood({ pos: hitPoint, dir: bulletDir, exit: false, amount: zoneKey === 'HEAD' ? 2 : 1 });
        } else {
            this.spawnImpactParticles(hitPoint, bulletDir.clone().negate(), 0x9e0b0b, zoneKey === 'HEAD' ? 16 : 9);
        }
        if (unit.animator && typeof unit.animator.trigger === 'function') unit.animator.trigger('flinch');

        if (attackerName === 'ВЫ') {
            this.sound.playHitMarker(zoneKey === 'HEAD');
            this.flashCrosshairHit(zoneKey === 'HEAD');
        }

        if (unit.hp <= 0) {
            this.killSoldierWithRagdoll(unit, zoneKey, partName, hitPoint, bulletDir, wStat, attackerName);
        } else if (!unit.isWounded && unit.hp < unit.maxHp * 0.4) {
            unit.isWounded = true;
            this.events.emit('unit:wounded', { unit });
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

        const kind = wStat.kind || (typeof wStat.name === 'string' && wStat.name.includes('ТАРАН') ? 'ram' : 'bullet');
        // The animator may play a short pre-death stagger first; it then calls startRagdoll itself.
        const startRagdoll = () => this.ragdollPhysics.triggerArticulatedRagdoll(unit, partName, impulseVec, hitPoint);
        const deferred = unit.animator && typeof unit.animator.beginDeath === 'function'
            && unit.animator.beginDeath({ zone: zoneKey, part: partName, dir: impactDir, impulse: impulseVec, hitPoint, kind }, startRagdoll) === true;
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
        this.getAimRay(_origin, _dir);
        if (this.ballistics && typeof this.ballistics.fireRocket === 'function') {
            _from.copy(_origin).addScaledVector(_dir, 0.8);
            const projectile = this.ballistics.fireRocket({
                origin: _from, dir: _dir, ammo: this.rocketAmmo || 'PG7VL', weapon: wStat, isPlayer: true, faction: this.playerFaction, attacker: 'ВЫ'
            });
            if (this.ordnance && typeof this.ordnance.rpgLaunch === 'function') {
                this.ordnance.rpgLaunch({ origin: _origin, dir: _dir, shooter: null, isPlayer: true, attacker: 'ВЫ', projectile });
            }
            return;
        }
        this._legacyRocket(wStat);
    },

    _legacyRocket(wStat) {
        const origin = _origin.clone();
        const dir = _dir.clone();
        const rocketGroup = new THREE.Group();
        rocketGroup.add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.42, 8), new THREE.MeshStandardMaterial({ color: 0x3d482e })));
        rocketGroup.position.copy(origin).addScaledVector(dir, 0.8);
        rocketGroup.lookAt(rocketGroup.position.clone().add(dir));
        this.scene.add(rocketGroup);
        this.projectiles.push({
            mesh: rocketGroup, vel: dir.multiplyScalar(wStat.muzzleVelocity), radius: wStat.blastRadius, force: wStat.blastForce,
            damage: wStat.damage, weaponName: wStat.name, sourceVehicle: null, ttl: 4.5
        });
    },

    // Blast with cover occlusion, vehicle armour factor and (grenades) shrapnel rays.
    // opts: { kind, attacker, faction, fragments, ammo, directVehicle, noFlash, normal, source }
    triggerHighExplosiveBlast(epicenter, radius, force, maxDamage, sourceLabel = 'ОФС 125мм', opts = {}) {
        const kind = opts.kind || 'he';
        const attacker = opts.attacker === undefined ? 'ВЫ' : opts.attacker;
        const camDist = this.cameraMount.position.distanceTo(epicenter);
        this.sound.playExplosion(camDist);
        this.events.emit('explosion', { pos: epicenter, radius, force, damage: maxDamage, label: sourceLabel, kind, attacker, handledPlayer: true });

        const hasVfx = this.vfx && typeof this.vfx.explosion === 'function';
        if (hasVfx) this.vfx.explosion(epicenter, { kind, radius, normal: opts.normal || null });
        if (!opts.noFlash) {
            const maxLights = (this.quality && this.quality.profile.lighting && this.quality.profile.lighting.maxDynamicLights) || 2;
            if (this.dynamicLights.length < maxLights) {
                const flashLight = new THREE.PointLight(0xff8822, 26.0, radius * 2.5);
                flashLight.position.copy(epicenter).add(_push.set(0, 1.2, 0));
                this.scene.add(flashLight);
                this.dynamicLights.push({ light: flashLight, ttl: 0.34, maxTtl: 0.34 });
            }
        }
        if (!hasVfx) {
            this.spawnImpactParticles(epicenter, _push.set(0, 1, 0), 0xff6611, radius > 5 ? 26 : 10);
            this.spawnImpactParticles(epicenter, _push.set(0, 1, 0), 0x2a241e, radius > 5 ? 28 : 10);
        }

        if (camDist < radius * 2.2) {
            const shake = Math.pow(1.0 - camDist / (radius * 2.2), 1.5) * 3.8;
            this.posSpring.applyImpulse((Math.random() - 0.5) * shake, shake * 0.8, shake);
            this.rotSpring.applyImpulse((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
        }

        const ballistics = this.ballistics;
        const transmit = (x, y, z) => (ballistics && typeof ballistics.transmission === 'function'
            ? ballistics.transmission(epicenter.x, epicenter.y + 0.3, epicenter.z, x, y, z) : 1);

        for (const unit of this.units) {
            if (unit.isDead) continue;
            const p = unit.root.position;
            const d = Math.hypot(p.x - epicenter.x, p.y + 0.9 - epicenter.y, p.z - epicenter.z);
            if (d >= radius) continue;
            const trans = transmit(p.x, p.y + 1.0, p.z);
            const falloff = Math.pow(1.0 - d / radius, 1.35);
            const dmg = Math.round(maxDamage * falloff * trans);
            if (dmg <= 0) continue;
            unit.hp -= dmg;
            unit.flinchAmount = 1.0;
            if (unit.hp <= 0) {
                const blastDir = unit.root.position.clone().sub(epicenter).normalize();
                blastDir.y += 0.75;
                blastDir.normalize();
                this.killSoldierWithRagdoll(
                    unit,
                    d < radius * 0.35 && trans > 0.5 ? 'HEAD' : 'TORSO',
                    'torso',
                    unit.root.position.clone().add(new THREE.Vector3(0, 1.0, 0)),
                    blastDir,
                    { bulletMass: 1.8, muzzleVelocity: force * falloff, name: sourceLabel, kind: 'blast' },
                    attacker
                );
            } else {
                this.events.emit('unit:hit', {
                    unit, zone: 'TORSO', part: 'torso', pos: epicenter, dir: _push.copy(p).sub(epicenter).normalize(), damage: dmg, attacker,
                    weapon: { name: sourceLabel, kind: 'blast' }
                });
                if (!unit.isWounded && unit.hp < unit.maxHp * 0.4) {
                    unit.isWounded = true;
                    this.events.emit('unit:wounded', { unit });
                }
            }
        }

        this.damagePlayerByBlast(epicenter, radius, force, maxDamage, sourceLabel, attacker, transmit);
        this.ragdollPhysics.applyExplosionBlastToRagdolls(epicenter, radius, force);

        for (const veh of this.ragdollPhysics.vehicles) {
            if (veh.destroyed || veh === opts.directVehicle) continue;
            const d = veh.chassisPos.distanceTo(epicenter);
            if (d < radius) {
                const falloff = 1.0 - d / radius;
                const dmg = Math.round(maxDamage * falloff * armorFor(veh.spec.key).blast);
                if (dmg > 0) this.damageVehicle(veh, { amount: dmg, pos: epicenter, kind: 'blast', attacker, label: sourceLabel });
                if (force > 20) {
                    _push.copy(veh.chassisPos).sub(epicenter).normalize();
                    _push.y = Math.abs(_push.y) + 0.3;
                    this.ragdollPhysics.applyVehicleImpulse(veh, _push.multiplyScalar(force * falloff * veh.spec.mass * 0.03), epicenter);
                }
            }
        }

        if (this.destructibles && typeof this.destructibles.damageAt === 'function') this.destructibles.damageAt(epicenter, radius, maxDamage);

        const wantsFrags = opts.fragments === undefined ? kind === 'grenade' : opts.fragments > 0;
        if (wantsFrags && ballistics && typeof ballistics.spawnFragments === 'function') {
            ballistics.spawnFragments(epicenter, AMMO[opts.ammo] || AMMO.F1, { count: opts.fragments, attacker, source: opts.source || null });
        }
    },

    // Blast overpressure on the player; skipped inside a vehicle (its hull takes the damage instead).
    damagePlayerByBlast(epicenter, radius, force, maxDamage, label, attacker, transmit) {
        if (!this.isStarted) return;
        const pv = this.playerVehicleState;
        if (pv && pv.vehicle && pv.role === 'DRIVER') return;
        const c = this.playerCollider;
        const cx = c.start.x, cy = c.start.y + 0.5, cz = c.start.z;
        const d = Math.hypot(cx - epicenter.x, cy - epicenter.y, cz - epicenter.z);
        if (d >= radius) return;
        const trans = transmit(cx, cy, cz);
        const falloff = Math.pow(1.0 - d / radius, 1.35);
        const amount = Math.min(140, maxDamage * falloff * trans * 0.5);
        if (amount < 1) return;
        _push.set(cx - epicenter.x, 0, cz - epicenter.z);
        if (_push.lengthSq() < 1e-6) _push.set(0, 0, 1);
        _push.normalize();
        this.playerVelocity.addScaledVector(_push, force * falloff * 0.12 * trans);
        this.damagePlayer({
            amount, zone: d < radius * 0.25 ? 'TORSO' : (cy - c.start.y < 0.3 ? 'LEG' : 'TORSO'), pos: epicenter.clone(),
            dir: _push.clone(), attacker, source: label, blast: true
        });
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
        this.spawnImpactParticles(vehicle.chassisPos.clone().add(_chest.set(0, 1.8, 0)), _push.set(0, 1, 0), 0xff4400, 32);
    },

    // Legacy projectile list: still serviced for shells pushed by code that predates `ballistics`.
    updateProjectiles(dt) {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.ttl -= dt;
            p.vel.y -= 4.2 * dt;
            const nextPos = p.mesh.position.clone().addScaledVector(p.vel, dt);

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
