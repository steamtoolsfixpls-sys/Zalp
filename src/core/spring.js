import * as THREE from 'three';

export class Spring3D {
    constructor(stiffness = 165, damping = 14.5) {
        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.target = new THREE.Vector3();
        this.stiffness = stiffness;
        this.damping = damping;
    }
    applyImpulse(x, y, z) {
        this.velocity.x += x;
        this.velocity.y += y;
        this.velocity.z += z;
    }
    update(dt) {
        const step = Math.min(dt, 0.033);
        const fx = (this.target.x - this.position.x) * this.stiffness - this.velocity.x * this.damping;
        const fy = (this.target.y - this.position.y) * this.stiffness - this.velocity.y * this.damping;
        const fz = (this.target.z - this.position.z) * this.stiffness - this.velocity.z * this.damping;
        this.velocity.x += fx * step;
        this.velocity.y += fy * step;
        this.velocity.z += fz * step;
        this.position.x += this.velocity.x * step;
        this.position.y += this.velocity.y * step;
        this.position.z += this.velocity.z * step;
    }
}
