import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { STATS } from './stats.js';
import { RagdollPhysicsEngine } from './physics_ragdoll.js';
import { EventBus } from './src/core/events.js';
import { Settings } from './src/core/settings.js';
import { QualityManager } from './src/core/quality.js';
import { Input } from './src/core/input.js';
import { AssetManager } from './src/core/assets.js';
import { Spring3D } from './src/core/spring.js';
import { SoundEngine } from './src/audio/audio.js';
import { MIXINS, MODULES } from './src/modules.js';

// Engine kernel: shared state, boot sequence and frame loop.
// Gameplay methods live in mixins (src/**) installed on the prototype; features live in modules
// registered in src/modules.js. See docs/ARCHITECTURE.md.
export class BattleEngine {
    constructor() {
        this.container = document.getElementById('viewport');
        this.events = new EventBus();
        this.settings = new Settings(this.events);
        this.quality = new QualityManager(this);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x98a5b0);

        this.camera = new THREE.PerspectiveCamera(this.settings.get('fov'), window.innerWidth / window.innerHeight, 0.06, 600);
        this.renderer = new THREE.WebGLRenderer({
            antialias: this.quality.profile.msaa,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.06;
        this.container.appendChild(this.renderer.domElement);

        this.customRenderHook = null;
        this.customLocationHook = null;
        this.provingGroundGroup = new THREE.Group();
        this.scene.add(this.provingGroundGroup);

        window.BATTLE_ENGINE = {
            instance: this,
            ready: false,
            renderer: this.renderer,
            scene: this.scene,
            camera: this.camera,
            provingGroundGroup: this.provingGroundGroup,
            setCustomRenderHook: (fn) => { this.customRenderHook = fn; },
            setLocationBuilder: (fn) => {
                this.customLocationHook = fn;
                if (typeof fn === 'function') {
                    fn(this.scene, this.octree, this.ragdollPhysics);
                }
            },
            // Test hook: advance the simulation n fixed steps without waiting for rendered frames.
            step: (n = 1, dt = 1 / 60) => {
                for (let i = 0; i < n; i++) this.tick(dt);
            }
        };

        this.sound = new SoundEngine(this);
        this.ragdollPhysics = new RagdollPhysicsEngine(this.scene);
        this.physics = this.ragdollPhysics;
        this.octree = new Octree();
        this.assets = new AssetManager(this);

        this.playerFaction = 'RU';
        this.isStarted = false;
        this.isPaused = false;
        this.isPointerLocked = false;
        // Unzoomed field of view; sights and optics divide it and must restore it.
        this.baseFov = this.settings.get('fov');
        this.loadout = null;
        this.time = 0;
        this.frame = 0;
        // Ambient wind (m/s) shared by smoke, dust, ballistics and drones.
        this.wind = new THREE.Vector3(1.8, 0, 0.9);

        this.playerCollider = new Capsule(
            new THREE.Vector3(0, 0.36, 28),
            new THREE.Vector3(0, 1.44, 28),
            STATS.PLAYER.capsuleRadius
        );
        this.playerVelocity = new THREE.Vector3();
        this.playerDirection = new THREE.Vector3();
        this.playerOnFloor = false;
        this.playerHp = STATS.PLAYER.maxHp;
        this.killsCount = 0;
        this.headshotsCount = 0;

        this.yaw = 0;
        this.pitch = 0;
        this.targetLean = 0;
        this.currentLean = 0;
        this.isCrouching = false;
        this.isSprinting = false;
        this.isAiming = false;
        this.isFiring = false;
        this.bobTimer = 0;
        this.smoothYawVel = 0;
        this.smoothPitchVel = 0;
        this.lookOverride = null;
        this.controlOverride = null;

        this.cameraMount = new THREE.Group();
        this.scene.add(this.cameraMount);
        this.cameraMount.add(this.camera);

        this.viewmodelRoot = new THREE.Group();
        this.camera.add(this.viewmodelRoot);
        this.posSpring = new Spring3D(175, 15.5);
        this.rotSpring = new Spring3D(150, 13.5);

        this.loadoutKeys = ['ak12', 'm4a1', 'ak74m', 'rpg7'];
        this.currentWeaponIdx = 0;
        this.weaponStates = {};
        for (const k of this.loadoutKeys) {
            const st = STATS.WEAPONS[k];
            this.weaponStates[k] = {
                mag: st.magCapacity,
                chambered: true,
                reserve: st.reserveAmmo,
                reloading: false,
                reloadState: 'READY',
                reloadTimer: 0,
                reloadTotal: 0,
                lastFireTime: 0,
                meshGroup: null
            };
        }

        this.muzzleLight = new THREE.PointLight(0xffaa33, 0, 12.0);
        this.camera.add(this.muzzleLight);
        this.muzzleLight.position.set(0.12, -0.08, -0.78);

        this.keys = {};
        this.input = new Input(this);
        this.units = [];
        this.drones = [];
        this.projectiles = [];
        this.particles = [];
        this.brassCasings = [];
        this.dynamicLights = [];
        this.staticShootableMeshes = [];
        this.modules = [];
        this.hudLayer = document.getElementById('hud-layer');
        this._modifiers = new Map();

        this.playerVehicleState = {
            vehicle: null,
            role: null,
            desantSlotIndex: -1,
            thirdPersonCamera: true
        };
        this.nearestInteractVehicle = null;

        this.fpvMode = {
            active: false,
            droneType: 'KAMIKAZE',
            droneMesh: null,
            position: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            yaw: 0,
            pitch: 0,
            roll: 0,
            battery: 100,
            motorAudio: null
        };

        this.squadOrderMode = 'HOLD';
        this.clock = new THREE.Clock();
        this.raycaster = new THREE.Raycaster();
    }

    async boot() {
        this.setupLighting();
        this.quality.apply();
        await this.ragdollPhysics.init();
        this.buildCleanPolygonFloorAndRamps();
        await this.loadAllModelsWithProgress();
        this.populateMilitaryLineupRows();
        this.setupViewmodelMeshes();
        this.bindEvents();
        await this.installModules();
        this.updateWeaponHUD();

        const loadOverlay = document.getElementById('loading-overlay');
        const startPanel = document.getElementById('start-panel');
        if (loadOverlay) loadOverlay.style.display = 'none';
        if (startPanel) startPanel.style.display = 'flex';

        window.BATTLE_ENGINE.ready = true;
        this.events.emit('engine:ready', {});
        this.animate();
    }

    async loadAllModelsWithProgress() {
        const barFill = document.getElementById('loading-bar-fill');
        const statusTxt = document.getElementById('loading-status-text');
        await this.assets.loadAll((done, total, entry) => {
            if (barFill) barFill.style.width = `${Math.round((done / total) * 100)}%`;
            if (statusTxt) statusTxt.textContent = `ЗАГРУЗКА 3D МОДЕЛЕЙ: ${done} / ${total} (${entry.key.toUpperCase()})`;
        });
    }

    instantiateStaticModel(key, targetSpanOverride = null) {
        return this.assets.instantiate(key, targetSpanOverride);
    }

    // Multiplicative gameplay modifiers (see docs/ARCHITECTURE.md): modules contribute, controllers consume.
    addModifier(name, fn) {
        const list = this._modifiers.get(name) || [];
        list.push(fn);
        this._modifiers.set(name, list);
        return () => this._modifiers.set(name, (this._modifiers.get(name) || []).filter((f) => f !== fn));
    }

    modifier(name) {
        const list = this._modifiers.get(name);
        if (!list) return 1;
        let value = 1;
        for (let i = 0; i < list.length; i++) value *= list[i]();
        return value;
    }

    async installModules() {
        // The sound engine is created in the constructor but shares the module lifecycle.
        try {
            this.sound.name = 'sound';
            if (typeof this.sound.install === 'function') await this.sound.install(this);
            this.modules.push(this.sound);
        } catch (err) {
            console.error('[modules] "sound" failed to install', err);
        }
        for (const [name, factory] of MODULES) {
            try {
                const mod = factory(this) || {};
                mod.name = mod.name || name;
                this[name] = mod;
                if (typeof mod.install === 'function') await mod.install(this);
                this.modules.push(mod);
            } catch (err) {
                console.error(`[modules] "${name}" failed to install`, err);
            }
        }
    }

    // Calls an optional hook on every module. A module that keeps throwing is disabled, not the frame loop.
    runModules(hook, arg) {
        for (let i = 0; i < this.modules.length; i++) {
            const mod = this.modules[i];
            if (mod.disabled || typeof mod[hook] !== 'function') continue;
            try {
                mod[hook](arg);
            } catch (err) {
                mod.failures = (mod.failures || 0) + 1;
                console.error(`[modules] "${mod.name}".${hook} failed`, err);
                if (mod.failures >= 5) {
                    mod.disabled = true;
                    console.error(`[modules] "${mod.name}" disabled after repeated failures`);
                }
            }
        }
    }

    tick(dt) {
        this.frame++;
        if (!this.isStarted || this.isPaused) return;
        this.time += dt;

        this.ragdollPhysics.step(dt, this.units, (veh, victimUnit, impactVel) => {
            this.killSoldierWithRagdoll(
                victimUnit,
                'TORSO',
                'torso',
                victimUnit.root.position.clone().add(new THREE.Vector3(0, 0.9, 0)),
                impactVel.clone().normalize(),
                { bulletMass: 3.5, muzzleVelocity: impactVel.length() * 14.0, name: `${veh.name} (ТАРАН БРОНЕЙ)` },
                'ВЫ'
            );
        });
        this.updateReloadStateMachine(dt);
        this.updatePlayerController(dt);
        this.updateUnitsAndSquadAI(dt);
        this.updateAutonomousDrones(dt);
        this.updateProjectiles(dt);
        this.updateEffects(dt);
        if (this.playerVehicleState.vehicle && this.playerVehicleState.role === 'DRIVER') {
            this.updateWeaponHUD();
        }
        this.runModules('update', dt);
        this.runModules('lateUpdate', dt);
    }

    render(dt) {
        if (typeof this.customRenderHook === 'function') {
            this.customRenderHook(this.renderer, this.scene, this.camera, dt);
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        const dt = Math.min(this.clock.getDelta(), 0.05);
        this.tick(dt);
        this.quality.update(dt);
        this.render(dt);
    }
}

for (const mixin of MIXINS) Object.assign(BattleEngine.prototype, mixin);

const engine = new BattleEngine();
engine.boot();
