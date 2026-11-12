import * as THREE from 'three';
import { STATS } from '../../stats.js';

export const legacyFxMethods = {
    spawnBrassCasing() {
        const geo = new THREE.CylinderGeometry(0.007, 0.007, 0.036, 6);
        geo.rotateZ(Math.PI * 0.5);
        const mat = new THREE.MeshStandardMaterial({ color: 0xd8a838, metalness: 0.85, roughness: 0.22 });
        const mesh = new THREE.Mesh(geo, mat);

        const spawnPos = new THREE.Vector3(0.18, -0.09, -0.35);
        spawnPos.applyMatrix4(this.camera.matrixWorld);
        mesh.position.copy(spawnPos);
        this.scene.add(mesh);

        const rightVec = new THREE.Vector3(1, 0.45, 0.1).applyQuaternion(this.camera.quaternion).normalize();
        const vel = rightVec.multiplyScalar(3.4 + Math.random() * 1.4);
        vel.add(this.playerVelocity);

        this.brassCasings.push({
            mesh,
            vel,
            rotVel: new THREE.Vector3(Math.random() * 18, Math.random() * 18, Math.random() * 18),
            ttl: 2.2
        });
    },

    spawnTracerBeam(startPos, endPos, hexColor) {
        const dist = startPos.distanceTo(endPos);
        if (dist < 0.5) return;
        const geo = new THREE.CylinderGeometry(0.016, 0.016, dist, 5);
        geo.rotateX(Math.PI * 0.5);
        const mat = new THREE.MeshBasicMaterial({ color: hexColor, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(startPos).lerp(endPos, 0.5);
        mesh.lookAt(endPos);
        this.scene.add(mesh);
        this.particles.push({ mesh, vel: new THREE.Vector3(), ttl: 0.07, maxTtl: 0.07, isTracer: true });
    },

    spawnImpactParticles(pos, normal, hexColor, count = 12) {
        for (let i = 0; i < count; i++) {
            const size = 0.035 + Math.random() * 0.065;
            const geo = new THREE.BoxGeometry(size, size, size);
            const mat = new THREE.MeshStandardMaterial({
                color: hexColor,
                roughness: 0.6,
                emissive: hexColor === 0xff6611 || hexColor === 0xff4400 ? 0xff4400 : 0x000000,
                emissiveIntensity: hexColor === 0xff6611 || hexColor === 0xff4400 ? 1.6 : 0
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            this.scene.add(mesh);

            const vel = normal.clone().multiplyScalar(2.5 + Math.random() * 6.5);
            vel.x += (Math.random() - 0.5) * 6.0;
            vel.y += Math.random() * 5.5;
            vel.z += (Math.random() - 0.5) * 6.0;

            this.particles.push({
                mesh,
                vel,
                ttl: 0.45 + Math.random() * 0.55,
                maxTtl: 1.0,
                isTracer: false
            });
        }
    },

    updateEffects(dt) {
        if (this.muzzleLight.intensity > 0) {
            this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 95.0);
        }

        for (let i = this.dynamicLights.length - 1; i >= 0; i--) {
            const dl = this.dynamicLights[i];
            dl.ttl -= dt;
            if (dl.ttl <= 0) {
                this.scene.remove(dl.light);
                this.dynamicLights.splice(i, 1);
            } else {
                dl.light.intensity = 24.0 * (dl.ttl / dl.maxTtl);
            }
        }

        for (let i = this.brassCasings.length - 1; i >= 0; i--) {
            const c = this.brassCasings[i];
            c.ttl -= dt;
            if (c.ttl <= 0) {
                this.scene.remove(c.mesh);
                c.mesh.geometry.dispose();
                c.mesh.material.dispose();
                this.brassCasings.splice(i, 1);
                continue;
            }
            c.vel.y -= 18.0 * dt;
            c.mesh.position.addScaledVector(c.vel, dt);
            c.mesh.rotation.x += c.rotVel.x * dt;
            c.mesh.rotation.y += c.rotVel.y * dt;
            if (c.mesh.position.y < 0.04) {
                c.mesh.position.y = 0.04;
                c.vel.y *= -0.35;
                c.vel.x *= 0.7;
                c.vel.z *= 0.7;
            }
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const pt = this.particles[i];
            pt.ttl -= dt;
            if (pt.ttl <= 0) {
                this.scene.remove(pt.mesh);
                pt.mesh.geometry.dispose();
                pt.mesh.material.dispose();
                this.particles.splice(i, 1);
                continue;
            }
            if (!pt.isTracer) {
                pt.vel.y -= 14.0 * dt;
                pt.mesh.position.addScaledVector(pt.vel, dt);
                pt.mesh.scale.multiplyScalar(0.97);
            }
        }
    },
};
