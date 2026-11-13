import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const playerControllerMethods = {
    selectFactionAndStart(faction) {
        this.playerFaction = faction;
        this.currentWeaponIdx = faction === 'RU' ? 0 : 1;
        this.switchWeapon(this.currentWeaponIdx);

        this.playerCollider.start.set(-4.0, 0.36, 20.5);
        this.playerCollider.end.set(-4.0, 1.44, 20.5);
        this.yaw = 0.0;
        this.pitch = -0.05;
        this.playerHp = STATS.PLAYER.maxHp;

        this.sound.init();
        const startPanel = document.getElementById('start-panel');
        if (startPanel) startPanel.style.display = 'none';
        this.isStarted = true;
        this.requestPointerLock();
        this.updateWeaponHUD();
        this.runModules('onStart', faction);
        this.events.emit('game:started', { faction });
    },

    bindEvents() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.runModules('onResize');
        });

        const btnRu = document.getElementById('btn-faction-ru');
        const btnUa = document.getElementById('btn-faction-ua');
        if (btnRu) btnRu.addEventListener('click', () => this.selectFactionAndStart('RU'));
        if (btnUa) btnUa.addEventListener('click', () => this.selectFactionAndStart('UA'));

        document.addEventListener('pointerlockchange', () => {
            this.isPointerLocked = (document.pointerLockElement === this.renderer.domElement);
        });

        this.renderer.domElement.addEventListener('mousedown', (e) => {
            if (!this.isStarted || this.isPaused) return;
            this.sound.init();
            if (!this.isPointerLocked) {
                this.requestPointerLock();
                return;
            }
            this.handlePointerDown(e.button);
        });
        window.addEventListener('mouseup', (e) => this.handlePointerUp(e.button));
        window.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('mousemove', (e) => {
            if (!this.isPointerLocked) return;
            this.applyLookDelta(e.movementX || 0, e.movementY || 0);
        });
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    },

    requestPointerLock() {
        // Touch devices and headless runs have no pointer lock; the promise form may reject.
        const el = this.renderer.domElement;
        try {
            const p = el.requestPointerLock && el.requestPointerLock();
            if (p && p.catch) p.catch(() => {});
        } catch {
            // unsupported
        }
    },

    // Mouse buttons go through the input registry as MouseLeft / MouseRight / MouseMiddle.
    handlePointerDown(button) {
        const code = button === 0 ? 'MouseLeft' : (button === 2 ? 'MouseRight' : 'MouseMiddle');
        this.keys[code] = true;
        if (this.input.dispatchDown({ code })) return;
        if (button === 0) this.setFiring(true);
        else if (button === 2) this.setAiming(true);
    },

    handlePointerUp(button) {
        const code = button === 0 ? 'MouseLeft' : (button === 2 ? 'MouseRight' : 'MouseMiddle');
        this.keys[code] = false;
        this.input.dispatchUp({ code });
        if (button === 0) this.setFiring(false);
        else if (button === 2) this.setAiming(false);
    },

    // Primary trigger, shared by mouse, touch and tests.
    setFiring(down) {
        if (!down) {
            this.isFiring = false;
            return;
        }
        if (this.fpvMode.active) {
            this.detonatePlayerFpvDrone();
        } else if (this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DRIVER') {
            this.isFiring = true;
            this.tryFireVehicleWeapon(this.playerVehicleState.vehicle);
        } else {
            this.isFiring = true;
            this.tryFireCurrentWeapon();
        }
    },

    // Where the player's weapon points (the camera by default; free-aim overrides this).
    getAimRay(outOrigin, outDir) {
        this.camera.getWorldPosition(outOrigin);
        outDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    },

    setAiming(down) {
        this.isAiming = Boolean(down);
    },

    // Look input in mouse-pixel units, shared by mouse, touch and gyro.
    applyLookDelta(dx, dy) {
        if (this.lookOverride && this.lookOverride(dx, dy) === true) return;
        const settings = this.settings;
        if (settings.get('invertY')) dy = -dy;

        if (this.fpvMode.active) {
            const fs = settings.get('fpvSensitivity');
            this.fpvMode.yaw -= dx * 0.0024 * fs;
            this.fpvMode.pitch = Math.max(-1.35, Math.min(1.15, this.fpvMode.pitch - dy * 0.0022 * fs));
            this.fpvMode.roll = THREE.MathUtils.lerp(this.fpvMode.roll, -dx * 0.012, 0.35);
            return;
        }

        const sens = (this.isAiming ? 0.0013 * settings.get('adsSensitivity') : 0.0021) * settings.get('mouseSensitivity');
        this.yaw -= dx * sens;
        this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * sens));
        this.smoothYawVel += dx * 0.00025;
        this.smoothPitchVel += dy * 0.00025;

        if (this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DRIVER') {
            this.playerVehicleState.vehicle.turretYaw = this.yaw;
            this.playerVehicleState.vehicle.turretPitch = Math.max(-0.18, Math.min(0.48, this.pitch));
        }
    },

    handleKeyDown(e) {
        this.keys[e.code] = true;
        if (this.input.dispatchDown(e)) return;
        if (!this.isStarted || this.isPaused) return;

        if (e.code === 'Digit1') this.switchWeapon(0);
        else if (e.code === 'Digit2') this.switchWeapon(1);
        else if (e.code === 'Digit3') this.switchWeapon(2);
        else if (e.code === 'Digit4') this.switchWeapon(3);
        else if (e.code === 'KeyR' && !this.fpvMode.active && this.playerVehicleState.role !== 'DRIVER') {
            this.triggerTacticalReload();
        } else if (e.code === 'KeyF') {
            if (this.playerVehicleState.vehicle) {
                this.exitCurrentVehicle();
            } else if (this.nearestInteractVehicle) {
                this.enterVehicleAsDriver(this.nearestInteractVehicle);
            }
        } else if (e.code === 'KeyB') {
            if (this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DESANT') {
                this.exitCurrentVehicle();
            } else {
                const targetV = this.playerVehicleState.vehicle || this.nearestInteractVehicle;
                if (targetV) this.enterVehicleAsArmorDesant(targetV);
            }
        } else if (e.code === 'KeyH') {
            this.toggleSquadTransportOnNearestVehicle();
        } else if (e.code === 'KeyT') {
            this.toggleVehicleAutopilot();
        } else if (e.code === 'KeyK' && this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DRIVER') {
            this.playerVehicleState.thirdPersonCamera = !this.playerVehicleState.thirdPersonCamera;
        } else if (e.code === 'KeyC' && !this.fpvMode.active && !this.playerVehicleState.vehicle) {
            this.isCrouching = !this.isCrouching;
        } else if (e.code === 'KeyV') {
            this.togglePlayerFpvDrone('KAMIKAZE');
        } else if (e.code === 'KeyN') {
            this.togglePlayerFpvDrone('LANCET');
        } else if (e.code === 'KeyG') {
            this.issueSquadAssaultOrder();
        } else if (e.code === 'KeyQ') {
            this.targetLean = -1;
        } else if (e.code === 'KeyE') {
            this.targetLean = 1;
        } else if (e.code === 'Space' && this.playerOnFloor && !this.fpvMode.active && !this.playerVehicleState.vehicle) {
            this.playerVelocity.y = STATS.PLAYER.jumpImpulse;
            this.playerOnFloor = false;
        }
    },

    handleKeyUp(e) {
        this.keys[e.code] = false;
        this.input.dispatchUp(e);
        if (e.code === 'KeyQ' && this.targetLean < 0) this.targetLean = 0;
        if (e.code === 'KeyE' && this.targetLean > 0) this.targetLean = 0;
    },

    updatePlayerController(dt) {
        if (this.controlOverride && this.controlOverride(dt) === true) return;
        this.updateNearestVehiclePrompt();

        if (this.fpvMode.active) {
            this.updatePlayerFpvFlight(dt);
            return;
        }

        if (this.playerVehicleState.vehicle) {
            this.updatePlayerInVehicle(dt);
            return;
        }

        const pStat = STATS.PLAYER;
        this.isSprinting = Boolean(this.keys['ShiftLeft'] && this.keys['KeyW'] && !this.isCrouching && !this.isAiming) && this.modifier('canSprint') > 0;
        const speed = (this.isCrouching ? pStat.crouchSpeed : (this.isSprinting ? pStat.sprintSpeed : pStat.walkSpeed)) * this.modifier('playerSpeed');

        const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

        this.playerDirection.set(0, 0, 0);
        if (this.keys['KeyW']) this.playerDirection.add(forward);
        if (this.keys['KeyS']) this.playerDirection.sub(forward);
        if (this.keys['KeyD']) this.playerDirection.add(right);
        if (this.keys['KeyA']) this.playerDirection.sub(right);
        this.playerDirection.addScaledVector(forward, this.input.axes.moveY);
        this.playerDirection.addScaledVector(right, this.input.axes.moveX);
        if (this.playerDirection.lengthSq() > 1) this.playerDirection.normalize();

        const accel = this.playerOnFloor ? speed : speed * 0.32;
        this.playerVelocity.x += this.playerDirection.x * accel * dt;
        this.playerVelocity.z += this.playerDirection.z * accel * dt;

        let damping = Math.exp(-pStat.damping * dt) - 1;
        if (!this.playerOnFloor) {
            this.playerVelocity.y -= pStat.gravity * dt;
            damping *= 0.12;
        }
        this.playerVelocity.addScaledVector(this.playerVelocity, damping);

        const subSteps = 3;
        const subDt = dt / subSteps;
        for (let s = 0; s < subSteps; s++) {
            this.playerCollider.translate(this.playerVelocity.clone().multiplyScalar(subDt));
            const result = this.octree.capsuleIntersect(this.playerCollider);
            this.playerOnFloor = false;
            if (result) {
                this.playerOnFloor = result.normal.y > 0.25;
                if (!this.playerOnFloor) {
                    this.playerVelocity.addScaledVector(result.normal, -result.normal.dot(this.playerVelocity));
                } else if (this.playerVelocity.y < 0) {
                    this.playerVelocity.y = 0;
                }
                this.playerCollider.translate(result.normal.multiplyScalar(result.depth));
            }
        }

        for (const veh of this.ragdollPhysics.vehicles) {
            const localPos = this.playerCollider.start.clone().sub(veh.chassisPos);
            const invQ = veh.chassisQuat.clone().invert();
            localPos.applyQuaternion(invQ);
            const hx = veh.spec.halfExtents[0];
            const hy = veh.spec.halfExtents[1];
            const hz = veh.spec.halfExtents[2];

            if (Math.abs(localPos.x) < hx * 1.05 && Math.abs(localPos.z) < hz * 1.05) {
                const roofY = veh.chassisPos.y + hy * 1.85;
                if (this.playerCollider.start.y >= roofY - 0.55 && this.playerCollider.start.y <= roofY + 0.85) {
                    const lift = roofY - this.playerCollider.start.y;
                    this.playerCollider.translate(new THREE.Vector3(
                        veh.frameDeltaPos.x,
                        Math.max(0, lift) + veh.frameDeltaPos.y,
                        veh.frameDeltaPos.z
                    ));
                    this.playerVelocity.y = Math.max(0, this.playerVelocity.y);
                    this.playerOnFloor = true;
                }
            }
        }

        const desiredHeight = this.isCrouching ? pStat.crouchHeight : pStat.standHeight;
        const currentSpan = this.playerCollider.end.y - this.playerCollider.start.y;
        const nextSpan = THREE.MathUtils.lerp(currentSpan, desiredHeight - pStat.capsuleRadius, Math.min(1.0, dt * 10.0));
        this.playerCollider.end.y = this.playerCollider.start.y + nextSpan;

        const horizSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
        if (horizSpeed > 0.45 && this.playerOnFloor) {
            const bobFreq = this.isSprinting ? 13.5 : 8.8;
            this.bobTimer += dt * bobFreq;
        } else {
            this.bobTimer += dt * 1.6;
        }

        const bobAmp = this.playerOnFloor ? Math.min(1.0, horizSpeed / 8.0) : 0.1;
        const bobX = Math.cos(this.bobTimer * 0.5) * 0.026 * bobAmp;
        const bobY = Math.abs(Math.sin(this.bobTimer)) * 0.038 * bobAmp;
        const bobRoll = Math.sin(this.bobTimer * 0.5) * 0.016 * bobAmp;

        this.currentLean = THREE.MathUtils.lerp(this.currentLean, this.targetLean, Math.min(1.0, dt * 9.5));
        this.smoothYawVel = THREE.MathUtils.lerp(this.smoothYawVel, 0, Math.min(1.0, dt * 12.0));
        this.smoothPitchVel = THREE.MathUtils.lerp(this.smoothPitchVel, 0, Math.min(1.0, dt * 12.0));

        this.cameraMount.position.copy(this.playerCollider.end);
        const leanWorld = right.clone().multiplyScalar(this.currentLean * pStat.leanOffset);
        this.cameraMount.position.add(leanWorld);
        this.cameraMount.position.y += bobY;

        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 0, 1),
            -this.currentLean * pStat.maxTiltAngle + bobRoll - this.smoothYawVel * 0.45
        );
        this.camera.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll);

        this.updateViewmodelTransform(dt, bobX, bobY);

        const activeKey = this.loadoutKeys[this.currentWeaponIdx];
        const wStat = STATS.WEAPONS[activeKey];
        if (this.isFiring && !wStat.isExplosive) {
            this.tryFireCurrentWeapon();
        }
    },
};
