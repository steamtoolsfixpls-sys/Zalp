import * as THREE from 'three';

// "environment" feature module: overcast sky dome aligned with the sun, image-based lighting from a PMREM
// of that sky, horizon fog tied to the draw distance and the procedural ground material.
// Public surface: horizonColor, sunDirection, sky, setGridVisible(on).

const HORIZON = 0xb4bcc1;
const ZENITH = 0x8795a3;
const GROUND_BOUNCE = 0x45433c;
const SUN_GLOW = 0xfff0d8;

const GROUND_SIZE = 600;        // side of the collision floor in metres
const GROUND_TILE = 7;          // metres covered by one repeat of the ground textures
const FOG_REACH = 1.98;         // exp2 fog is ~98 % opaque at the draw distance
const ENV_INTENSITY = 0.7;
const HEMI_WITH_IBL = 0.45;
const HEMI_NO_IBL = 1.5;        // low preset: no environment map, stronger sky fill instead
const LOW_METALNESS = 0.35;     // without reflections pure metals would render black
const EXPOSURE = 1.06;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Tileable value noise: `period` lattice cells across the texture.
function noiseLayer(size, period, rand) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const out = new Float32Array(size * size);
    const k = period / size;
    for (let y = 0; y < size; y++) {
        const fy = y * k;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        const sy = ty * ty * (3 - 2 * ty);
        const r0 = (y0 % period) * period;
        const r1 = ((y0 + 1) % period) * period;
        for (let x = 0; x < size; x++) {
            const fx = x * k;
            const x0 = Math.floor(fx);
            const tx = fx - x0;
            const sx = tx * tx * (3 - 2 * tx);
            const c0 = x0 % period;
            const c1 = (x0 + 1) % period;
            const a = lattice[r0 + c0];
            const b = lattice[r0 + c1];
            const c = lattice[r1 + c0];
            const d = lattice[r1 + c1];
            out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
        }
    }
    return out;
}

function smooth(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

// Packed dirt with gravel and patches of trampled grass: sRGB albedo and a matching tangent-space normal.
function paintGround(size) {
    const rand = mulberry32(90210);
    const layer = (period) => noiseLayer(size, Math.min(period, size >> 1), rand);
    const m1 = layer(3);
    const m2 = layer(7);
    const d1 = layer(16);
    const d2 = layer(37);
    const d3 = layer(80);
    const g1 = layer(128);
    const g2 = layer(256);

    const albedo = new Uint8ClampedArray(size * size * 4);
    const height = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
        const detail = d1[i] * 0.5 + d2[i] * 0.3 + d3[i] * 0.2;
        const grit = g1[i] * 0.55 + g2[i] * 0.45;
        const grass = smooth(0.52, 0.66, m1[i] * 0.45 + m2[i] * 0.35 + d1[i] * 0.2 + (d2[i] - 0.5) * 0.3);
        const pebble = smooth(0.7, 0.8, g1[i]) * (1 - grass);
        const speck = (grit - 0.5) * 20;

        let r = 104 + detail * 40 + speck;
        let g = 93 + detail * 35 + speck;
        let b = 76 + detail * 28 + speck * 0.9;
        r += (76 + detail * 28 + speck * 1.2 - r) * grass;
        g += (84 + detail * 32 + speck * 1.3 - g) * grass;
        b += (56 + detail * 20 + speck * 0.8 - b) * grass;
        const stone = 112 + grit * 26;
        r += (stone - r) * pebble * 0.55;
        g += (stone - 3 - g) * pebble * 0.55;
        b += (stone - 9 - b) * pebble * 0.55;

        const o = i * 4;
        albedo[o] = r;
        albedo[o + 1] = g;
        albedo[o + 2] = b;
        albedo[o + 3] = 255;
        height[i] = detail * 0.55 + grit * 0.25 + pebble * 0.5 + grass * grit * 0.35;
    }

    const normal = new Uint8ClampedArray(size * size * 4);
    const strength = size / 150;
    const mask = size - 1;
    for (let y = 0; y < size; y++) {
        const up = ((y - 1) & mask) * size;
        const down = ((y + 1) & mask) * size;
        for (let x = 0; x < size; x++) {
            const nx = (height[y * size + ((x - 1) & mask)] - height[y * size + ((x + 1) & mask)]) * strength;
            const ny = (height[up + x] - height[down + x]) * strength;
            const inv = 1 / Math.hypot(nx, ny, 1);
            const o = (y * size + x) * 4;
            normal[o] = (nx * inv * 0.5 + 0.5) * 255;
            normal[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
            normal[o + 2] = (inv * 0.5 + 0.5) * 255;
            normal[o + 3] = 255;
        }
    }
    return { albedo, normal };
}

function canvasTexture(size, pixels, srgb) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    image.data.set(pixels);
    ctx.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.flipY = false;
    texture.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE);
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function applyGroundQuality(material, engine) {
    if (!material || !material.userData.groundNormal) return;
    const profile = engine.quality.profile;
    const max = engine.renderer.capabilities.getMaxAnisotropy();
    const anisotropy = Math.min(max, Math.max(2, profile.textures.anisotropy * 2));
    for (const texture of [material.map, material.userData.groundNormal]) {
        if (texture.anisotropy !== anisotropy) {
            texture.anisotropy = anisotropy;
            texture.needsUpdate = true;
        }
    }
    // The normal map costs a tangent frame per ground pixel: the low preset keeps the albedo only.
    const normalMap = profile.lighting.envMap ? material.userData.groundNormal : null;
    if (material.normalMap !== normalMap) {
        material.normalMap = normalMap;
        material.needsUpdate = true;
    }
}

// Tiling ground material generated on a canvas. Built by the floor builder before modules exist.
export function createGroundMaterial(engine) {
    const size = engine.quality.preset === 'low' ? 256 : 512;
    const { albedo, normal } = paintGround(size);
    const material = new THREE.MeshStandardMaterial({
        map: canvasTexture(size, albedo, true),
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.96,
        metalness: 0.0
    });
    material.name = 'ProvingGround';
    material.userData.groundNormal = canvasTexture(size, normal, false);
    // The tile repeats every few metres: blend it with a rotated, coarser sample of itself and tint large
    // areas with a third, so no regular pattern survives when seen from above or at range.
    material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', /* glsl */`
            vec3 groundNear = texture2D( map, vMapUv ).rgb;
            vec3 groundWide = texture2D( map, mat2( 0.8, 0.6, -0.6, 0.8 ) * vMapUv * 0.29 ).rgb;
            float groundMacro = texture2D( map, vMapUv.yx * 0.043 ).r;
            diffuseColor.rgb *= mix( groundNear, groundWide, 0.5 ) * clamp( 0.72 + 1.9 * groundMacro, 0.8, 1.2 );
        `);
    };
    applyGroundQuality(material, engine);
    return material;
}

// Visual-only ring of ground around the collision floor so the terrain reaches the fogged horizon.
// UVs continue the floor's mapping; the ring never overlaps the floor (no z-fighting, no collision).
export function createGroundApronGeometry(outer = 2400) {
    const inner = GROUND_SIZE / 2;
    const stops = [-outer, -inner, inner, outer];
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let iz = 0; iz < 3; iz++) {
        for (let ix = 0; ix < 3; ix++) {
            if (ix === 1 && iz === 1) continue;
            const base = positions.length / 3;
            const corners = [[stops[ix], stops[iz]], [stops[ix], stops[iz + 1]], [stops[ix + 1], stops[iz + 1]], [stops[ix + 1], stops[iz]]];
            for (const [x, z] of corners) {
                positions.push(x, 0, z);
                normals.push(0, 1, 0);
                uvs.push(x / GROUND_SIZE + 0.5, 0.5 - z / GROUND_SIZE);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
}

const SKY_VERTEX = /* glsl */`
varying vec3 vDir;
void main() {
    vDir = position;
    // Rotation only: the dome is always centred on the camera and drawn at the far plane.
    vec4 clip = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
    gl_Position = clip.xyww;
}`;

const SKY_FRAGMENT = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vDir;

float hash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
}

float noise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( hash( i ), hash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( hash( i + vec2( 0.0, 1.0 ) ), hash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}

void main() {
    vec3 d = normalize( vDir );
    float up = max( d.y, 0.0 );
    vec3 col = mix( uHorizon, uZenith, 1.0 - pow( 1.0 - up, 3.0 ) );
    #ifdef SKY_CLOUDS
        // Overcast deck: soft mottling that dissolves into the horizon haze.
        vec2 cp = d.xz / ( up + 0.2 ) * 1.6;
        float cloud = noise( cp ) * 0.55 + noise( cp * 2.3 + 7.1 ) * 0.3 + noise( cp * 5.1 + 3.7 ) * 0.15;
        col *= mix( 1.0, 0.84 + 0.3 * cloud, smoothstep( 0.02, 0.4, d.y ) );
    #endif
    // The sun is only a bright patch behind the cloud layer.
    float sun = max( dot( d, uSunDir ), 0.0 );
    col += uSunColor * ( 0.1 * pow( sun, 4.0 ) + 0.22 * pow( sun, 48.0 ) );
    col = mix( col, uGround, smoothstep( 0.0, -0.22, d.y ) );
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

export function createEnvironment(engine) {
    const { scene, renderer } = engine;
    const horizonColor = new THREE.Color(HORIZON);
    const sunDirection = new THREE.Vector3(0.5, 0.74, 0.43).normalize();
    let sky = null;
    let envTarget = null;
    let envFailed = false;

    function createSky() {
        const sun = engine.sunLight;
        if (sun) sunDirection.copy(sun.position).sub(sun.target.position).normalize();
        const material = new THREE.ShaderMaterial({
            name: 'OvercastSky',
            uniforms: {
                uZenith: { value: new THREE.Color(ZENITH) },
                uHorizon: { value: horizonColor },
                uGround: { value: new THREE.Color(GROUND_BOUNCE) },
                uSunColor: { value: new THREE.Color(SUN_GLOW) },
                uSunDir: { value: sunDirection }
            },
            vertexShader: SKY_VERTEX,
            fragmentShader: SKY_FRAGMENT,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false
        });
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), material);
        dome.name = 'sky';
        dome.frustumCulled = false;
        dome.matrixAutoUpdate = false;
        dome.renderOrder = 1000;    // after the opaque world, so hidden sky pixels are never shaded
        return dome;
    }

    // Prefiltered environment from the sky itself, so reflections and ambient light match what is seen.
    function buildEnvironmentMap() {
        const material = sky.material.clone();
        material.defines = { SKY_CLOUDS: 1 };
        material.depthTest = false;
        const envScene = new THREE.Scene();
        const dome = new THREE.Mesh(sky.geometry, material);
        dome.frustumCulled = false;
        envScene.add(dome);
        const pmrem = new THREE.PMREMGenerator(renderer);
        const target = pmrem.fromScene(envScene, 0.02);
        pmrem.dispose();
        material.dispose();
        return target;
    }

    function applyMetalFallback(template, on) {
        if (!template) return;
        template.scene.traverse((o) => {
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const mat of mats) {
                if (!mat || typeof mat.metalness !== 'number') continue;
                if (mat.userData.baseMetalness === undefined) mat.userData.baseMetalness = mat.metalness;
                mat.metalness = on ? Math.min(mat.userData.baseMetalness, LOW_METALNESS) : mat.userData.baseMetalness;
            }
        });
    }

    function applyQuality() {
        const profile = engine.quality.profile;
        scene.fog.density = FOG_REACH / profile.drawDistance;

        let useEnv = Boolean(profile.lighting.envMap) && !envFailed;
        if (useEnv && !envTarget) {
            try {
                envTarget = buildEnvironmentMap();
            } catch (err) {
                console.warn('[environment] environment map unavailable:', err.message);
                envFailed = true;
                useEnv = false;
            }
        }
        scene.environment = useEnv ? envTarget.texture : null;
        scene.environmentIntensity = ENV_INTENSITY;
        if (engine.hemiLight) engine.hemiLight.intensity = useEnv ? HEMI_WITH_IBL : HEMI_NO_IBL;
        for (const template of engine.assets.templates.values()) applyMetalFallback(template, !useEnv);

        const clouds = useEnv;
        if (Boolean(sky.material.defines.SKY_CLOUDS) !== clouds) {
            if (clouds) sky.material.defines.SKY_CLOUDS = 1;
            else delete sky.material.defines.SKY_CLOUDS;
            sky.material.needsUpdate = true;
        }
        applyGroundQuality(engine.groundMaterial, engine);
    }

    const mod = {
        name: 'environment',
        horizonColor,
        sunDirection,
        sky: null,

        install() {
            sky = createSky();
            mod.sky = sky;
            scene.add(sky);
            if (scene.background && scene.background.isColor) scene.background.copy(horizonColor);
            scene.fog = new THREE.FogExp2(horizonColor.getHex(), FOG_REACH / engine.quality.profile.drawDistance);
            renderer.toneMappingExposure = EXPOSURE;
            applyQuality();
            engine.events.on('quality:changed', applyQuality);
            // Models that stream in later need the same low-preset metal treatment.
            engine.events.on('assets:progress', ({ key }) => {
                applyMetalFallback(engine.assets.getTemplate(key), !scene.environment);
            });
        },

        setGridVisible(on) {
            if (engine.debugGrid) engine.debugGrid.visible = Boolean(on);
        }
    };
    return mod;
}
