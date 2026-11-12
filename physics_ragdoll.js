import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { STATS } from './stats.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _vUp = new THREE.Vector3();
const _vFwd = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class RagdollPhysicsEngine {
    constructor(scene) {
        this.scene = scene;
        this.world = null;
        this.ready = false;
        this.ragdolls = [];
        this.debrisBodies = [];
        this.hitboxMeshes = [];
        this.vehicles = [];
    }

    async init() {
        await RAPIER.init();
        this.world = new RAPIER.World({ x: 0.0, y: -19.62, z: 0.0 });
        const groundDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1.0, 0);
        const groundBody = this.world.createRigidBody(groundDesc);
        this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(320, 1.0, 320)
                .setFriction(0.9)
                .setRestitution(0.05)
                .setCollisionGroups(0x0001ffff),
            groundBody
        );
        this.ready = true;
    }

    addStaticBoxCollider(pos, halfExtents, quat = null) {
        if (!this.ready) return null;
        const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
        if (quat) {
            bodyDesc.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
        }
        const body = this.world.createRigidBody(bodyDesc);
        const colDesc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
            .setFriction(0.85)
            .setRestitution(0.1)
            .setCollisionGroups(0x0001ffff);
        return this.world.createCollider(colDesc, body);
    }

    createPhysicalVehicle(spec, meshGroup, spawnPos, spawnYaw = 0) {
        if (!this.ready) return null;
        const hx = spec.halfExtents[0];
        const hy = spec.halfExtents[1];
        const hz = spec.halfExtents[2];

        const initY = spawnPos.y + spec.suspRestLength + hy * 0.65;
        const initQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawnYaw);

        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(spawnPos.x, initY, spawnPos.z)
            .setRotation({ x: initQuat.x, y: initQuat.y, z: initQuat.z, w: initQuat.w })
            .setLinearDamping(0.45)
            .setAngularDamping(2.4)
            .setCcdEnabled(true);

        const body = this.world.createRigidBody(rbDesc);

        const hullColDesc = RAPIER.ColliderDesc.cuboid(hx * 0.92, hy * 0.68, hz * 0.92)
            .setTranslation(0, hy * 0.18, 0)
            .setMass(spec.mass)
            .setFriction(0.4)
            .setRestitution(0.08)
            .setCollisionGroups(0x0004ffff);
        const collider = this.world.createCollider(hullColDesc, body);

        const suspPoints = [];
        const axleCount = spec.driveType === 'WHEELED_4X4' ? 2 : 4;
        for (let i = 0; i < axleCount; i++) {
            const zFrac = axleCount === 2
                ? (i === 0 ? -0.78 : 0.78)
                : (-0.82 + (i / (axleCount - 1)) * 1.64);
            const zOff = zFrac * hz;
            const yOff = -hy * 0.35;
            const xOff = hx * 0.88;
            suspPoints.push({ local: new THREE.Vector3(-xOff, yOff, zOff), compression: 0, grounded: false });
            suspPoints.push({ local: new THREE.Vector3(xOff, yOff, zOff), compression: 0, grounded: false });
        }

        const hitProxyGeo = new THREE.BoxGeometry(hx * 2.0, hy * 2.1, hz * 2.0);
        const hitProxyMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitProxyMesh = new THREE.Mesh(hitProxyGeo, hitProxyMat);
        hitProxyMesh.position.set(0, hy, 0);
        meshGroup.add(hitProxyMesh);

        const vehicleObj = {
            id: `${spec.key}_${Math.floor(Math.random() * 99999)}`,
            spec,
            name: spec.name,
            faction: spec.faction,
            mesh: meshGroup,
            hitProxyMesh,
            body,
            collider,
            suspPoints,
            hp: spec.maxHp,
            maxHp: spec.maxHp,
            destroyed: false,
            controls: {
                throttle: 0,
                steer: 0,
                brake: false,
                aiAutopilot: false,
                aiTargetZ: -25
            },
            turretYaw: spawnYaw,
            turretPitch: 0,
            fireTimer: 0,
            speedKmh: 0,
            chassisPos: new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z),
            chassisQuat: initQuat.clone(),
            prevChassisPos: new THREE.Vector3(spawnPos.x, spawnPos.y, spawnPos.z),
            frameDeltaPos: new THREE.Vector3(),
            desantUnits: new Array(spec.desantSlots.length).fill(null),
            playerSeatedMode: null,
            playerDesantSlot: -1
        };

        hitProxyMesh.userData = {
            isVehicleHitbox: true,
            vehicle: vehicleObj
        };

        this.vehicles.push(vehicleObj);
        return vehicleObj;
    }

    pointVelocityOnBody(body, worldPoint) {
        const com = body.translation();
        const lv = body.linvel();
        const av = body.angvel();
        const rx = worldPoint.x - com.x;
        const ry = worldPoint.y - com.y;
        const rz = worldPoint.z - com.z;
        return new THREE.Vector3(
            lv.x + (av.y * rz - av.z * ry),
            lv.y + (av.z * rx - av.x * rz),
            lv.z + (av.x * ry - av.y * rx)
        );
    }

    applyCannonRecoil(vehicle, muzzleDirWorld) {
        if (!vehicle || !vehicle.body || vehicle.destroyed) return;
        vehicle.body.wakeUp();
        const com = vehicle.body.translation();
        const recoilPoint = {
            x: com.x,
            y: com.y + vehicle.spec.halfExtents[1] * 0.95,
            z: com.z
        };
        const imp = vehicle.spec.recoilImpulse;
        vehicle.body.applyImpulseAtPoint(
            {
                x: -muzzleDirWorld.x * imp,
                y: Math.abs(imp) * 0.15,
                z: -muzzleDirWorld.z * imp
            },
            recoilPoint,
            true
        );
    }

    spawnBlownTurretDebris(vehicle) {
        if (!this.ready) return;
        const pos = vehicle.chassisPos;
        const turretGeo = new THREE.CylinderGeometry(1.25, 1.45, 0.72, 10);
        const turretMat = new THREE.MeshStandardMaterial({
            color: 0x1e1d1b,
            roughness: 0.9,
            metalness: 0.35
        });
        const barrelGeo = new THREE.CylinderGeometry(0.08, 0.09, 3.6, 8);
        barrelGeo.rotateX(Math.PI * 0.5);
        const barrelMesh = new THREE.Mesh(barrelGeo, turretMat);
        barrelMesh.position.set(0, 0.05, -2.2);

        const group = new THREE.Group();
        const dome = new THREE.Mesh(turretGeo, turretMat);
        dome.castShadow = true;
        barrelMesh.castShadow = true;
        group.add(dome);
        group.add(barrelMesh);
        group.position.set(pos.x, pos.y + 2.3, pos.z);
        this.scene.add(group);

        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(pos.x, pos.y + 2.3, pos.z)
            .setLinearDamping(0.25)
            .setAngularDamping(0.35);
        const body = this.world.createRigidBody(rbDesc);
        this.world.createCollider(
            RAPIER.ColliderDesc.ball(1.15).setMass(950).setFriction(0.8).setRestitution(0.15),
            body
        );

        body.applyImpulse({
            x: (Math.random() - 0.5) * 4200,
            y: 14500 + Math.random() * 4500,
            z: (Math.random() - 0.5) * 4200
        }, true);
        body.applyTorqueImpulse({
            x: (Math.random() - 0.5) * 3200,
            y: (Math.random() - 0.5) * 2800,
            z: (Math.random() - 0.5) * 3200
        }, true);

        this.debrisBodies.push({ mesh: group, body, ttl: 24.0 });
    }

    stepVehicles(dt, allUnits, onRoadkillCallback) {
        if (!this.ready) return;
        const stepDt = Math.min(dt, 0.033);

        for (const veh of this.vehicles) {
            const body = veh.body;
            if (!body) continue;

            if (veh.controls.aiAutopilot && !veh.destroyed) {
                const curPos = body.translation();
                const dz = veh.controls.aiTargetZ - curPos.z;
                if (Math.abs(dz) > 4.0) {
                    veh.controls.throttle = dz < 0 ? 0.72 : -0.55;
                    veh.controls.brake = false;
                } else {
                    veh.controls.aiTargetZ = veh.controls.aiTargetZ < 0 ? 14.0 : -28.0;
                }
            }

            const hasActiveInput = Math.abs(veh.controls.throttle) > 0.01 || Math.abs(veh.controls.steer) > 0.01 || veh.controls.brake;
            if (hasActiveInput) {
                body.wakeUp();
            }

            const t = body.translation();
            const r = body.rotation();
            _q1.set(r.x, r.y, r.z, r.w);

            _vRight.set(1, 0, 0).applyQuaternion(_q1);
            _vUp.set(0, 1, 0).applyQuaternion(_q1);
            _vFwd.set(0, 0, -1).applyQuaternion(_q1);

            if (_vUp.y < 0.25) {
                body.applyTorqueImpulse({
                    x: _vUp.z * veh.spec.mass * 8.0 * stepDt,
                    y: 0,
                    z: -_vUp.x * veh.spec.mass * 8.0 * stepDt
                }, true);
            }

            const rayDir = { x: -_vUp.x, y: -_vUp.y, z: -_vUp.z };
            const maxRayLen = veh.spec.suspRestLength + 0.42;
            let groundedWheels = 0;
            let minGroundClearance = veh.spec.suspRestLength;

            for (const sp of veh.suspPoints) {
                _v1.copy(sp.local).applyQuaternion(_q1);
                const wp = { x: t.x + _v1.x, y: t.y + _v1.y, z: t.z + _v1.z };
                const ray = new RAPIER.Ray(wp, rayDir);

                const hit = this.world.castRay(
                    ray,
                    maxRayLen,
                    true,
                    undefined,
                    0x0001ffff,
                    veh.collider,
                    body
                );

                if (hit && hit.toi < maxRayLen) {
                    sp.grounded = true;
                    groundedWheels++;
                    const dist = hit.toi;
                    if (dist < minGroundClearance) minGroundClearance = dist;

                    const compression = veh.spec.suspRestLength - dist;
                    sp.compression = compression;

                    const ptVel = this.pointVelocityOnBody(body, wp);
                    const velAlongSpring = ptVel.dot(_vUp);

                    let springForce = compression * veh.spec.suspStiffness - velAlongSpring * veh.spec.suspDamping;
                    springForce = Math.max(0, Math.min(springForce, veh.spec.mass * 65.0));

                    const suspImpulse = _vUp.clone().multiplyScalar(springForce * stepDt);

                    const lateralVel = ptVel.dot(_vRight);
                    const sideGripForce = -lateralVel * veh.spec.sideFriction * (veh.spec.mass / veh.suspPoints.length);
                    const sideImpulse = _vRight.clone().multiplyScalar(sideGripForce * stepDt);

                    const forwardVel = ptVel.dot(_vFwd);
                    let driveForce = 0;
                    if (!veh.destroyed) {
                        if (veh.controls.brake) {
                            driveForce = - forwardVel * (veh.spec.brakeForce / veh.suspPoints.length) * 0.25;
                        } else if (Math.abs(veh.controls.throttle) > 0.01) {
                            const maxSpd = veh.spec.driveType === 'TRACKED' ? 19.5 : 26.5;
                            if (Math.abs(forwardVel) < maxSpd) {
                                driveForce = (veh.controls.throttle * veh.spec.engineForce) / veh.suspPoints.length;
                            }
                        } else {
                            driveForce = -forwardVel * (veh.spec.mass * 1.4 / veh.suspPoints.length);
                        }
                    } else {
                        driveForce = -forwardVel * (veh.spec.mass * 3.5 / veh.suspPoints.length);
                    }

                    const driveImpulse = _vFwd.clone().multiplyScalar(driveForce * stepDt);
                    const totalImpulse = suspImpulse.add(sideImpulse).add(driveImpulse);

                    body.applyImpulseAtPoint(
                        { x: totalImpulse.x, y: totalImpulse.y, z: totalImpulse.z },
                        wp,
                        true
                    );
                } else {
                    sp.grounded = false;
                    sp.compression = 0;
                }
            }

            const lv = body.linvel();
            const forwardSpeed = lv.x * _vFwd.x + lv.y * _vFwd.y + lv.z * _vFwd.z;
            veh.speedKmh = Math.round(Math.hypot(lv.x, lv.z) * 3.6);

            if (!veh.destroyed && groundedWheels >= 2 && Math.abs(veh.controls.steer) > 0.01) {
                let steerFactor = 1.0;
                if (veh.spec.driveType !== 'TRACKED') {
                    steerFactor = Math.min(1.0, Math.max(0.28, Math.abs(forwardSpeed) / 4.5));
                    if (forwardSpeed < -0.5) steerFactor *= -1;
                }
                const yawTorque = veh.controls.steer * veh.spec.turnTorque * steerFactor * stepDt;
                body.applyTorqueImpulse({
                    x: _vUp.x * yawTorque,
                    y: _vUp.y * yawTorque,
                    z: _vUp.z * yawTorque
                }, true);
            }

            veh.prevChassisPos.copy(veh.chassisPos);
            const visualDrop = veh.spec.suspRestLength + veh.spec.halfExtents[1] * 0.42;
            veh.chassisPos.set(t.x, Math.max(0.0, t.y - visualDrop), t.z);
            veh.chassisQuat.copy(_q1);
            veh.frameDeltaPos.subVectors(veh.chassisPos, veh.prevChassisPos);

            veh.mesh.position.copy(veh.chassisPos);
            veh.mesh.quaternion.copy(veh.chassisQuat);

            for (let sIdx = 0; sIdx < veh.desantUnits.length; sIdx++) {
                const rider = veh.desantUnits[sIdx];
                if (!rider) continue;
                if (rider.isDead) {
                    veh.desantUnits[sIdx] = null;
                    rider.mountedVehicle = null;
                    continue;
                }
                const slot = veh.spec.desantSlots[sIdx];
                _v2.set(slot[0], slot[1], slot[2]).applyQuaternion(veh.chassisQuat).add(veh.chassisPos);
                rider.root.position.copy(_v2);
                const sideOutwardYaw = slot[0] < 0 ? 0.35 : -0.35;
                _q2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + sideOutwardYaw);
                rider.root.quaternion.copy(veh.chassisQuat).multiply(_q2);
            }

            if (veh.speedKmh > 12 && allUnits && onRoadkillCallback) {
                for (const u of allUnits) {
                    if (u.isDead || u.mountedVehicle === veh) continue;
                    const d = u.root.position.distanceTo(veh.chassisPos);
                    if (d < veh.spec.halfExtents[0] + 0.85) {
                        onRoadkillCallback(veh, u, _vFwd.clone().multiplyScalar(Math.max(12, Math.abs(forwardSpeed) * 2.2)));
                    }
                }
            }
        }
    }

    extractSoldierBones(root) {
        const bones = {
            hips: null,
            spine: null,
            chest: null,
            head: null,
            upperArmL: null,
            lowerArmL: null,
            handL: null,
            upperArmR: null,
            lowerArmR: null,
            handR: null,
            upperLegL: null,
            lowerLegL: null,
            footL: null,
            upperLegR: null,
            lowerLegR: null,
            footR: null
        };

        root.traverse((obj) => {
            if (!obj.isBone) return;
            const n = obj.name;
            if (n.includes('Hips') && !bones.hips) bones.hips = obj;
            else if (n.includes('Spine2') && !bones.chest) bones.chest = obj;
            else if (n.includes('Spine1') && !bones.spine) bones.spine = obj;
            else if (n.includes('Spine') && !bones.spine) bones.spine = obj;
            else if (n.includes('Head') && !n.includes('Top') && !bones.head) bones.head = obj;
            else if (n.includes('LeftArm') && !bones.upperArmL) bones.upperArmL = obj;
            else if (n.includes('LeftForeArm') && !bones.lowerArmL) bones.lowerArmL = obj;
            else if (n.includes('LeftHand') && !n.includes('Index') && !n.includes('Thumb') && !n.includes('Middle') && !n.includes('Ring') && !n.includes('Pinky') && !bones.handL) bones.handL = obj;
            else if (n.includes('RightArm') && !bones.upperArmR) bones.upperArmR = obj;
            else if (n.includes('RightForeArm') && !bones.lowerArmR) bones.lowerArmR = obj;
            else if (n.includes('RightHand') && !n.includes('Index') && !n.includes('Thumb') && !n.includes('Middle') && !n.includes('Ring') && !n.includes('Pinky') && !bones.handR) bones.handR = obj;
            else if (n.includes('LeftUpLeg') && !bones.upperLegL) bones.upperLegL = obj;
            else if (n.includes('LeftLeg') && !bones.lowerLegL) bones.lowerLegL = obj;
            else if (n.includes('LeftFoot') && !bones.footL) bones.footL = obj;
            else if (n.includes('RightUpLeg') && !bones.upperLegR) bones.upperLegR = obj;
            else if (n.includes('RightLeg') && !bones.lowerLegR) bones.lowerLegR = obj;
            else if (n.includes('RightFoot') && !bones.footR) bones.footR = obj;
        });

        if (!bones.chest && bones.spine) bones.chest = bones.spine;
        return bones;
    }

    attachAnatomicalHitboxes(unit) {
        const hitMat = new THREE.MeshBasicMaterial({ visible: false });
        const defs = [
            { part: 'head', bone: unit.bones.head, zone: 'HEAD', r: 0.16, h: 0.24, offsetY: 0.08 },
            { part: 'torso', bone: unit.bones.chest, zone: 'TORSO', r: 0.23, h: 0.44, offsetY: 0.02 },
            { part: 'pelvis', bone: unit.bones.hips, zone: 'TORSO', r: 0.21, h: 0.26, offsetY: 0.0 },
            { part: 'upperArmL', bone: unit.bones.upperArmL, zone: 'ARM', r: 0.09, h: 0.28, offsetY: 0.1 },
            { part: 'lowerArmL', bone: unit.bones.lowerArmL, zone: 'ARM', r: 0.08, h: 0.26, offsetY: 0.1 },
            { part: 'upperArmR', bone: unit.bones.upperArmR, zone: 'ARM', r: 0.09, h: 0.28, offsetY: 0.1 },
            { part: 'lowerArmR', bone: unit.bones.lowerArmR, zone: 'ARM', r: 0.08, h: 0.26, offsetY: 0.1 },
            { part: 'upperLegL', bone: unit.bones.upperLegL, zone: 'LEG', r: 0.12, h: 0.4, offsetY: 0.16 },
            { part: 'lowerLegL', bone: unit.bones.lowerLegL, zone: 'LEG', r: 0.1, h: 0.38, offsetY: 0.16 },
            { part: 'upperLegR', bone: unit.bones.upperLegR, zone: 'LEG', r: 0.12, h: 0.4, offsetY: 0.16 },
            { part: 'lowerLegR', bone: unit.bones.lowerLegR, zone: 'LEG', r: 0.1, h: 0.38, offsetY: 0.16 }
        ];

        unit.hitboxes = [];
        for (const d of defs) {
            const geo = new THREE.CylinderGeometry(d.r, d.r, d.h, 8);
            const mesh = new THREE.Mesh(geo, hitMat);
            mesh.userData = {
                isSoldierHitbox: true,
                unit: unit,
                zone: d.zone,
                partName: d.part,
                bone: d.bone,
                offsetY: d.offsetY
            };
            this.scene.add(mesh);
            unit.hitboxes.push(mesh);
            this.hitboxMeshes.push(mesh);
        }
    }

    syncSoldierHitboxes(unit) {
        if (!unit.hitboxes || unit.isDead) return;
        for (const hb of unit.hitboxes) {
            const bone = hb.userData.bone;
            if (bone) {
                bone.getWorldPosition(_v1);
                bone.getWorldQuaternion(_q1);
                hb.position.copy(_v1);
                hb.quaternion.copy(_q1);
            } else {
                hb.position.copy(unit.root.position);
                hb.position.y += 1.0;
            }
        }
    }

    removeUnitHitboxes(unit) {
        if (!unit.hitboxes) return;
        for (const hb of unit.hitboxes) {
            this.scene.remove(hb);
            hb.geometry.dispose();
            const idx = this.hitboxMeshes.indexOf(hb);
            if (idx !== -1) this.hitboxMeshes.splice(idx, 1);
        }
        unit.hitboxes.length = 0;
    }

    spawnFlyingHelmet(headWorldPos, impulseVec, faction) {
        if (!this.ready) return;
        const helmGeo = new THREE.SphereGeometry(0.145, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62);
        const helmMat = new THREE.MeshStandardMaterial({
            color: faction === 'RU' ? 0x2f3b28 : 0x434936,
            roughness: 0.65,
            metalness: 0.25,
            side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(helmGeo, helmMat);
        mesh.castShadow = true;
        mesh.position.copy(headWorldPos).add(new THREE.Vector3(0, 0.12, 0));
        this.scene.add(mesh);

        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
            .setLinearDamping(0.35)
            .setAngularDamping(0.25);
        const body = this.world.createRigidBody(rbDesc);
        this.world.createCollider(
            RAPIER.ColliderDesc.ball(0.14).setMass(1.4).setRestitution(0.35).setFriction(0.6),
            body
        );

        body.applyImpulse({
            x: impulseVec.x * 0.35 + (Math.random() - 0.5) * 3.0,
            y: Math.max(4.5, Math.abs(impulseVec.y) * 0.4 + 5.2),
            z: impulseVec.z * 0.35 + (Math.random() - 0.5) * 3.0
        }, true);
        body.applyTorqueImpulse({
            x: (Math.random() - 0.5) * 1.4,
            y: (Math.random() - 0.5) * 1.4,
            z: (Math.random() - 0.5) * 1.4
        }, true);

        this.debrisBodies.push({ mesh, body, ttl: 14.0 });
    }

    // Generic short-lived dynamic prop. `mesh` (already positioned) is added to the scene and follows the body.
    // shape: { type: 'ball', r } | { type: 'box', half: [x, y, z] } | { type: 'capsule', halfHeight, r }
    spawnDebris(mesh, { shape = { type: 'ball', r: 0.1 }, mass = 1, linvel = null, angvel = null, ttl = 12, friction = 0.6, restitution = 0.3 } = {}) {
        if (!this.ready) return null;
        const p = mesh.position;
        const q = mesh.quaternion;
        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(p.x, p.y, p.z)
            .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
            .setLinearDamping(0.3)
            .setAngularDamping(0.3);
        if (linvel) rbDesc.setLinvel(linvel.x, linvel.y, linvel.z);
        if (angvel) rbDesc.setAngvel({ x: angvel.x, y: angvel.y, z: angvel.z });
        const body = this.world.createRigidBody(rbDesc);
        let colDesc;
        if (shape.type === 'box') colDesc = RAPIER.ColliderDesc.cuboid(shape.half[0], shape.half[1], shape.half[2]);
        else if (shape.type === 'capsule') colDesc = RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.r);
        else colDesc = RAPIER.ColliderDesc.ball(shape.r || 0.1);
        this.world.createCollider(colDesc.setMass(mass).setFriction(friction).setRestitution(restitution), body);
        this.scene.add(mesh);
        const entry = { mesh, body, ttl };
        this.debrisBodies.push(entry);
        return entry;
    }

    triggerArticulatedRagdoll(unit, hitPartName, impulseVec, hitPointWorld) {
        this.removeUnitHitboxes(unit);
        if (!this.ready) return;

        let inheritedVel = { x: 0, y: 0, z: 0 };
        if (unit.mountedVehicle && unit.mountedVehicle.body) {
            inheritedVel = unit.mountedVehicle.body.linvel();
            const sIdx = unit.mountedVehicle.desantUnits.indexOf(unit);
            if (sIdx !== -1) unit.mountedVehicle.desantUnits[sIdx] = null;
            unit.mountedVehicle = null;
        }

        const b = unit.bones;
        const pos = unit.root.position;
        const yaw = unit.root.rotation.y;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);

        const getBoneOrOffset = (bone, lx, ly, lz) => {
            if (bone) {
                bone.getWorldPosition(_v1);
                return { x: _v1.x, y: Math.max(0.25, _v1.y), z: _v1.z };
            }
            return {
                x: pos.x + lx * cosY + lz * sinY,
                y: Math.max(0.25, pos.y + ly),
                z: pos.z - lx * sinY + lz * cosY
            };
        };

        const partDefs = {
            pelvis:    { bone: b.hips,      pos: getBoneOrOffset(b.hips, 0, 0.94, 0),          r: 0.14, h: 0.10, mass: 14.0, linDamp: 0.7, angDamp: 1.4 },
            torso:     { bone: b.chest,     pos: getBoneOrOffset(b.chest, 0, 1.30, 0),         r: 0.15, h: 0.18, mass: 22.0, linDamp: 0.65, angDamp: 1.3 },
            head:      { bone: b.head,      pos: getBoneOrOffset(b.head, 0, 1.66, 0),          r: 0.11, h: 0.06, mass: 5.0,  linDamp: 0.5, angDamp: 1.1 },
            upperArmL: { bone: b.upperArmL, pos: getBoneOrOffset(b.upperArmL, -0.24, 1.38, 0), r: 0.06, h: 0.12, mass: 3.2,  linDamp: 0.55, angDamp: 1.0 },
            lowerArmL: { bone: b.lowerArmL, pos: getBoneOrOffset(b.lowerArmL, -0.34, 1.12, 0), r: 0.05, h: 0.11, mass: 2.1,  linDamp: 0.5, angDamp: 0.9 },
            upperArmR: { bone: b.upperArmR, pos: getBoneOrOffset(b.upperArmR, 0.24, 1.38, 0),  r: 0.06, h: 0.12, mass: 3.2,  linDamp: 0.55, angDamp: 1.0 },
            lowerArmR: { bone: b.lowerArmR, pos: getBoneOrOffset(b.lowerArmR, 0.34, 1.12, 0),  r: 0.05, h: 0.11, mass: 2.1,  linDamp: 0.5, angDamp: 0.9 },
            upperLegL: { bone: b.upperLegL, pos: getBoneOrOffset(b.upperLegL, -0.13, 0.64, 0), r: 0.08, h: 0.16, mass: 8.5,  linDamp: 0.65, angDamp: 1.2 },
            lowerLegL: { bone: b.lowerLegL, pos: getBoneOrOffset(b.lowerLegL, -0.13, 0.28, 0), r: 0.065, h: 0.16, mass: 5.0, linDamp: 0.6, angDamp: 1.1 },
            upperLegR: { bone: b.upperLegR, pos: getBoneOrOffset(b.upperLegR, 0.13, 0.64, 0),  r: 0.08, h: 0.16, mass: 8.5,  linDamp: 0.65, angDamp: 1.2 },
            lowerLegR: { bone: b.lowerLegR, pos: getBoneOrOffset(b.lowerLegR, 0.13, 0.28, 0),  r: 0.065, h: 0.16, mass: 5.0, linDamp: 0.6, angDamp: 1.1 }
        };

        const bodies = {};
        const bindOffsets = {};

        for (const [key, def] of Object.entries(partDefs)) {
            const rbDesc = RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(def.pos.x, def.pos.y, def.pos.z)
                .setLinvel(inheritedVel.x, inheritedVel.y, inheritedVel.z)
                .setLinearDamping(def.linDamp)
                .setAngularDamping(def.angDamp)
                .setCcdEnabled(true);

            let initQuat = new THREE.Quaternion();
            if (def.bone) {
                def.bone.getWorldQuaternion(initQuat);
            } else {
                initQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
            }
            rbDesc.setRotation({ x: initQuat.x, y: initQuat.y, z: initQuat.z, w: initQuat.w });

            const body = this.world.createRigidBody(rbDesc);
            const colDesc = RAPIER.ColliderDesc.capsule(def.h, def.r)
                .setMass(def.mass)
                .setFriction(0.82)
                .setRestitution(0.08)
                .setCollisionGroups(0x00020005);

            this.world.createCollider(colDesc, body);
            bodies[key] = body;
            bindOffsets[key] = initQuat.clone();
        }

        const linkSpherical = (parentKey, childKey, a1, a2) => {
            const jd = RAPIER.JointData.spherical(a1, a2);
            this.world.createImpulseJoint(jd, bodies[parentKey], bodies[childKey], true);
        };

        const linkRevolute = (parentKey, childKey, a1, a2, axis, minAng, maxAng) => {
            const jd = RAPIER.JointData.revolute(a1, a2, axis);
            jd.limitsEnabled = true;
            jd.limits = [minAng, maxAng];
            this.world.createImpulseJoint(jd, bodies[parentKey], bodies[childKey], true);
        };

        linkSpherical('pelvis', 'torso', { x: 0, y: 0.14, z: 0 }, { x: 0, y: -0.20, z: 0 });
        linkSpherical('torso', 'head', { x: 0, y: 0.24, z: 0 }, { x: 0, y: -0.12, z: 0 });
        linkSpherical('torso', 'upperArmL', { x: -0.20, y: 0.16, z: 0 }, { x: 0, y: 0.14, z: 0 });
        linkSpherical('torso', 'upperArmR', { x: 0.20, y: 0.16, z: 0 }, { x: 0, y: 0.14, z: 0 });
        linkRevolute('upperArmL', 'lowerArmL', { x: 0, y: -0.14, z: 0 }, { x: 0, y: 0.13, z: 0 }, { x: 1, y: 0, z: 0 }, -2.1, 0.05);
        linkRevolute('upperArmR', 'lowerArmR', { x: 0, y: -0.14, z: 0 }, { x: 0, y: 0.13, z: 0 }, { x: 1, y: 0, z: 0 }, -2.1, 0.05);
        linkSpherical('pelvis', 'upperLegL', { x: -0.12, y: -0.10, z: 0 }, { x: 0, y: 0.18, z: 0 });
        linkSpherical('pelvis', 'upperLegR', { x: 0.12, y: -0.10, z: 0 }, { x: 0, y: 0.18, z: 0 });
        linkRevolute('upperLegL', 'lowerLegL', { x: 0, y: -0.18, z: 0 }, { x: 0, y: 0.18, z: 0 }, { x: 1, y: 0, z: 0 }, 0.0, 2.25);
        linkRevolute('upperLegR', 'lowerLegR', { x: 0, y: -0.18, z: 0 }, { x: 0, y: 0.18, z: 0 }, { x: 1, y: 0, z: 0 }, 0.0, 2.25);

        const targetBody = bodies[hitPartName] || bodies.torso;
        if (targetBody && impulseVec) {
            if (hitPointWorld) {
                targetBody.applyImpulseAtPoint(
                    { x: impulseVec.x, y: impulseVec.y, z: impulseVec.z },
                    { x: hitPointWorld.x, y: hitPointWorld.y, z: hitPointWorld.z },
                    true
                );
            } else {
                targetBody.applyImpulse({ x: impulseVec.x, y: impulseVec.y, z: impulseVec.z }, true);
            }
            bodies.torso.applyImpulse({
                x: impulseVec.x * 0.45,
                y: Math.max(15.0, impulseVec.y * 0.45 + 18.0),
                z: impulseVec.z * 0.45
            }, true);
            bodies.pelvis.applyTorqueImpulse({
                x: (Math.random() - 0.5) * 14.0,
                y: (Math.random() - 0.5) * 18.0,
                z: (Math.random() - 0.5) * 14.0
            }, true);
        }

        const ragdollEntry = {
            unit,
            bodies,
            partDefs,
            bindOffsets,
            age: 0,
            settled: false
        };

        this.ragdolls.push(ragdollEntry);
        return ragdollEntry;
    }

    applyExplosionBlastToRagdolls(epicenter, radius, peakForce) {
        if (!this.ready) return;
        for (const rag of this.ragdolls) {
            for (const body of Object.values(rag.bodies)) {
                const p = body.translation();
                const dx = p.x - epicenter.x;
                const dy = p.y - epicenter.y;
                const dz = p.z - epicenter.z;
                const dist = Math.hypot(dx, dy, dz);
                if (dist < radius && dist > 0.01) {
                    const falloff = Math.pow(1.0 - dist / radius, 1.5);
                    const mag = peakForce * falloff * 0.48;
                    body.wakeUp();
                    body.applyImpulse({
                        x: (dx / dist) * mag,
                        y: ((dy / dist) + 0.72) * mag,
                        z: (dz / dist) * mag
                    }, true);
                }
            }
        }

        for (const veh of this.vehicles) {
            if (!veh.body) continue;
            const p = veh.body.translation();
            const dx = p.x - epicenter.x;
            const dy = p.y - epicenter.y;
            const dz = p.z - epicenter.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist < radius * 1.4 && dist > 0.01) {
                const falloff = Math.pow(1.0 - dist / (radius * 1.4), 1.4);
                const vImp = peakForce * falloff * 380.0;
                veh.body.wakeUp();
                veh.body.applyImpulseAtPoint(
                    { x: (dx / dist) * vImp, y: Math.abs(vImp) * 0.65, z: (dz / dist) * vImp },
                    { x: epicenter.x, y: epicenter.y, z: epicenter.z },
                    true
                );
            }
        }
    }

    applyVehicleImpulse(vehicle, impulse, worldPoint = null) {
        if (!vehicle || !vehicle.body) return;
        vehicle.body.wakeUp();
        if (worldPoint) {
            vehicle.body.applyImpulseAtPoint(
                { x: impulse.x, y: impulse.y, z: impulse.z },
                { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z },
                true
            );
        } else {
            vehicle.body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
        }
    }

    removeRagdoll(unit) {
        const idx = this.ragdolls.findIndex((r) => r.unit === unit);
        if (idx === -1) return;
        for (const body of Object.values(this.ragdolls[idx].bodies)) {
            this.world.removeRigidBody(body);
        }
        this.ragdolls.splice(idx, 1);
    }

    step(dt, allUnits, onRoadkillCallback) {
        if (!this.ready) return;
        this.stepVehicles(dt, allUnits, onRoadkillCallback);
        this.world.timestep = Math.min(dt, 0.033);
        this.world.step();

        for (let i = this.debrisBodies.length - 1; i >= 0; i--) {
            const item = this.debrisBodies[i];
            item.ttl -= dt;
            if (item.ttl <= 0) {
                this.scene.remove(item.mesh);
                this.world.removeRigidBody(item.body);
                this.debrisBodies.splice(i, 1);
                continue;
            }
            const t = item.body.translation();
            const r = item.body.rotation();
            item.mesh.position.set(t.x, t.y, t.z);
            item.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        }

        for (const rag of this.ragdolls) {
            rag.age += dt;
            if (rag.age > 9.0 && !rag.settled) {
                rag.settled = true;
                for (const body of Object.values(rag.bodies)) {
                    body.sleep();
                }
            }
            if (rag.settled && rag.bodies.pelvis.isSleeping()) continue;

            const pelvisPos = rag.bodies.pelvis.translation();
            const torsoRot = rag.bodies.torso.rotation();
            rag.unit.root.position.set(
                pelvisPos.x,
                Math.max(0.05, pelvisPos.y - 0.18),
                pelvisPos.z
            );

            _q1.set(torsoRot.x, torsoRot.y, torsoRot.z, torsoRot.w);
            const collapseFactor = Math.min(1.0, rag.age * 4.2);
            _q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI * 0.48 * collapseFactor);
            rag.unit.root.quaternion.slerpQuaternions(rag.unit.root.quaternion, _q1.multiply(_q2), Math.min(1.0, dt * 10.0));
            rag.unit.root.updateMatrixWorld(true);

            const syncOrder = ['pelvis', 'torso', 'head', 'upperArmL', 'lowerArmL', 'upperArmR', 'lowerArmR', 'upperLegL', 'lowerLegL', 'upperLegR', 'lowerLegR'];
            for (const key of syncOrder) {
                const def = rag.partDefs[key];
                const bone = def.bone;
                const body = rag.bodies[key];
                if (!bone || !bone.parent || !body) continue;

                const r = body.rotation();
                _q1.set(r.x, r.y, r.z, r.w);
                bone.parent.getWorldQuaternion(_q2);
                _q2.invert();
                bone.quaternion.copy(_q2.multiply(_q1));
            }
        }
    }
}
