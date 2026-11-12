import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const droneMethods = {
    spawnAutonomousDrones() {
        const droneConfigs = [
            { key: 'drone_fpv',    type: 'KAMIKAZE', faction: 'RU', span: 0.62, y: 15, radius: 26, speed: 14.0 },
            { key: 'drone_lancet', type: 'LANCET',   faction: 'RU', span: 1.45, y: 24, radius: 34, speed: 18.5 },
            { key: 'drone_mavic',  type: 'RECON',    faction: 'UA', span: 0.50, y: 19, radius: 20, speed: 7.5 }
        ];

        for (let i = 0; i < droneConfigs.length; i++) {
            const cfg = droneConfigs[i];
            const mesh = this.instantiateStaticModel(cfg.key, cfg.span);
            const angle = (i / droneConfigs.length) * Math.PI * 2;
            mesh.position.set(Math.cos(angle) * cfg.radius, cfg.y, Math.sin(angle) * cfg.radius);
            this.scene.add(mesh);

            const navLight = new THREE.PointLight(cfg.faction === 'RU' ? 0xff2222 : 0x2277ff, 1.4, 8.0);
            navLight.position.set(0, -0.1, 0);
            mesh.add(navLight);

            this.drones.push({
                mesh,
                config: cfg,
                angle,
                diveTarget: null,
                diveTimer: 14.0 + Math.random() * 12.0,
                isDiving: false
            });
        }
    },

    togglePlayerFpvDrone(type = 'KAMIKAZE') {
        if (this.fpvMode.active) {
            this.exitPlayerFpvDrone();
            return;
        }
        if (this.playerVehicleState.vehicle) {
            this.exitCurrentVehicle();
        }
        this.fpvMode.active = true;
        this.fpvMode.droneType = type;
        this.viewmodelRoot.visible = false;
        this.fpvMode.position.copy(this.cameraMount.position).add(new THREE.Vector3(0, 2.5, -1.5));
        this.fpvMode.velocity.set(0, 5.5, -12.0);
        this.fpvMode.yaw = this.yaw;
        this.fpvMode.pitch = -0.08;
        this.fpvMode.roll = 0;
        this.fpvMode.battery = 100;

        if (this.fpvMode.droneMesh) {
            this.scene.remove(this.fpvMode.droneMesh);
        }
        const modelKey = type === 'LANCET' ? 'drone_lancet' : 'drone_fpv';
        const span = type === 'LANCET' ? 1.35 : 0.58;
        this.fpvMode.droneMesh = this.instantiateStaticModel(modelKey, span);
        this.scene.add(this.fpvMode.droneMesh);

        if (!this.fpvMode.motorAudio) {
            this.fpvMode.motorAudio = this.sound.createDroneMotorNode();
        }
        if (this.fpvMode.motorAudio) {
            this.fpvMode.motorAudio.gain.gain.value = 0.09;
        }

        const fpvHud = document.getElementById('fpv-osd');
        if (fpvHud) fpvHud.style.display = 'block';
    },

    exitPlayerFpvDrone() {
        this.fpvMode.active = false;
        this.viewmodelRoot.visible = (this.playerVehicleState.role !== 'DRIVER');
        if (this.fpvMode.droneMesh) this.fpvMode.droneMesh.visible = false;
        if (this.fpvMode.motorAudio) this.fpvMode.motorAudio.gain.gain.value = 0.0;
        const fpvHud = document.getElementById('fpv-osd');
        if (fpvHud) fpvHud.style.display = 'none';
    },

    detonatePlayerFpvDrone() {
        if (!this.fpvMode.active) return;
        const blastPos = this.fpvMode.position.clone();
        const label = this.fpvMode.droneType === 'LANCET' ? 'БПЛА «ЛАНЦЕТ-3»' : 'FPV-ДРОН ПГ-7ВЛ';
        this.exitPlayerFpvDrone();
        this.triggerHighExplosiveBlast(blastPos, STATS.FPV.blastRadius, STATS.FPV.blastForce, STATS.FPV.damage, label);
    },

    updatePlayerFpvFlight(dt) {
        const fpv = this.fpvMode;
        const forward = new THREE.Vector3(
            -Math.sin(fpv.yaw) * Math.cos(fpv.pitch),
            Math.sin(fpv.pitch),
            -Math.cos(fpv.yaw) * Math.cos(fpv.pitch)
        ).normalize();
        const right = new THREE.Vector3(Math.cos(fpv.yaw), 0, -Math.sin(fpv.yaw));

        let thrust = 18.0;
        if (this.keys['KeyW']) thrust = STATS.FPV.thrustAccel;
        else if (this.keys['KeyS']) thrust = 4.0;

        fpv.velocity.addScaledVector(forward, thrust * dt);
        if (this.keys['KeyD']) fpv.velocity.addScaledVector(right, 18.0 * dt);
        if (this.keys['KeyA']) fpv.velocity.addScaledVector(right, -18.0 * dt);
        if (this.keys['Space']) fpv.velocity.y += 15.0 * dt;
        if (this.keys['KeyC']) fpv.velocity.y -= 15.0 * dt;

        fpv.velocity.y -= 9.8 * dt;
        fpv.velocity.multiplyScalar(Math.exp(-STATS.FPV.drag * dt));
        if (fpv.velocity.length() > STATS.FPV.maxSpeed) {
            fpv.velocity.setLength(STATS.FPV.maxSpeed);
        }

        fpv.position.addScaledVector(fpv.velocity, dt);
        fpv.roll = THREE.MathUtils.lerp(fpv.roll, 0, Math.min(1.0, dt * 4.5));

        if (fpv.droneMesh) {
            fpv.droneMesh.position.copy(fpv.position);
            fpv.droneMesh.rotation.set(fpv.pitch, fpv.yaw, fpv.roll, 'YXZ');
        }

        this.cameraMount.position.copy(fpv.position).addScaledVector(forward, 0.28);
        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), fpv.yaw);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), fpv.pitch);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), fpv.roll);
        this.camera.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll);

        if (fpv.motorAudio) {
            const spdRatio = fpv.velocity.length() / STATS.FPV.maxSpeed;
            fpv.motorAudio.osc.frequency.value = 360 + spdRatio * 520;
        }

        fpv.battery = Math.max(0, fpv.battery - dt * 2.2);
        const batEl = document.getElementById('fpv-battery-val');
        const altEl = document.getElementById('fpv-alt-val');
        const spdEl = document.getElementById('fpv-spd-val');
        if (batEl) batEl.textContent = `${Math.round(fpv.battery)}%`;
        if (altEl) altEl.textContent = `${fpv.position.y.toFixed(1)} М`;
        if (spdEl) spdEl.textContent = `${Math.round(fpv.velocity.length() * 3.6)} КМ/Ч`;

        if (fpv.position.y <= 0.35 || fpv.battery <= 0) {
            this.detonatePlayerFpvDrone();
            return;
        }

        for (const u of this.units) {
            if (!u.isDead && u.root.position.distanceTo(fpv.position) < 1.5) {
                this.detonatePlayerFpvDrone();
                return;
            }
        }
        for (const v of this.ragdollPhysics.vehicles) {
            if (!v.destroyed && v.chassisPos.distanceTo(fpv.position) < 3.5) {
                this.detonatePlayerFpvDrone();
                return;
            }
        }
    },

    updateAutonomousDrones(dt) {
        for (const d of this.drones) {
            if (!d.isDiving) {
                d.angle += (d.config.speed / d.config.radius) * dt;
                d.mesh.position.set(
                    Math.cos(d.angle) * d.config.radius,
                    d.config.y + Math.sin(d.angle * 3.0) * 1.2,
                    Math.sin(d.angle) * d.config.radius
                );
                d.mesh.rotation.y = -d.angle;

                if (d.config.type !== 'RECON') {
                    d.diveTimer -= dt;
                    if (d.diveTimer <= 0) {
                        const enemies = this.units.filter((u) => !u.isDead && u.faction !== d.config.faction);
                        if (enemies.length > 0) {
                            d.diveTarget = enemies[Math.floor(Math.random() * enemies.length)].root.position.clone();
                            d.isDiving = true;
                        } else {
                            d.diveTimer = 10.0;
                        }
                    }
                }
            } else if (d.diveTarget) {
                const dir = d.diveTarget.clone().sub(d.mesh.position);
                const dist = dir.length();
                if (dist < 1.2) {
                    this.triggerHighExplosiveBlast(
                        d.diveTarget,
                        9.0,
                        55.0,
                        220,
                        d.config.type === 'LANCET' ? 'БПЛА «Ланцет-3»' : 'FPV Камикадзе'
                    );
                    d.isDiving = false;
                    d.diveTimer = 15.0 + Math.random() * 10.0;
                } else {
                    dir.normalize();
                    d.mesh.position.addScaledVector(dir, 26.0 * dt);
                    d.mesh.lookAt(d.diveTarget);
                }
            }
        }
    },
};
