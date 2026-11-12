import * as THREE from 'three';

// "postfx" feature module: bodycam look for presets with `postfx.composer` (medium and above):
// scene -> subtle bloom -> one final pass (tone mapping, output transform, vignette, sensor grain).
// The low preset renders straight to the canvas and gets its vignette from a CSS overlay.

const BLOOM = { strength: 0.3, radius: 0.55, threshold: 0.88 };
const VIGNETTE = 0.42;
const GRAIN = 0.05;
const SATURATION = 0.9;

const BodycamShader = {
    name: 'BodycamShader',
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uVignette: { value: VIGNETTE },
        uGrain: { value: GRAIN },
        uSaturation: { value: SATURATION }
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uSaturation;
        varying vec2 vUv;

        float hash( vec2 p ) {
            vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
            p3 += dot( p3, p3.yzx + 33.33 );
            return fract( ( p3.x + p3.y ) * p3.z );
        }

        void main() {
            gl_FragColor = vec4( texture2D( tDiffuse, vUv ).rgb, 1.0 );
            // This pass draws to the canvas, so the renderer's tone mapping and output space apply here.
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            vec3 c = gl_FragColor.rgb;
            float luma = dot( c, vec3( 0.299, 0.587, 0.114 ) );
            c = mix( vec3( luma ), c, uSaturation );
            vec2 p = vUv - 0.5;
            c *= 1.0 - uVignette * smoothstep( 0.22, 1.0, dot( p, p ) * 2.0 );
            // Small-sensor noise: strongest in the shadows.
            float n = hash( gl_FragCoord.xy + fract( uTime ) * 311.0 ) - 0.5;
            c += n * uGrain * ( 1.0 - 0.6 * luma );
            gl_FragColor = vec4( c, 1.0 );
        }`
};

const _size = new THREE.Vector2();

export function createPostFx(engine) {
    const renderer = engine.renderer;
    let lib = null;             // lazily imported three/addons post-processing classes
    let libFailed = false;
    let composer = null;
    let renderPass = null;
    let bloomPass = null;
    let finalPass = null;
    let samples = -1;
    let bloomScale = 1;
    let width = 0;
    let height = 0;
    let pixelRatio = 0;
    let vignetteEl = null;

    async function loadLib() {
        if (lib || libFailed) return lib;
        try {
            const [composerMod, renderMod, shaderMod, bloomMod] = await Promise.all([
                import('three/addons/postprocessing/EffectComposer.js'),
                import('three/addons/postprocessing/RenderPass.js'),
                import('three/addons/postprocessing/ShaderPass.js'),
                import('three/addons/postprocessing/UnrealBloomPass.js')
            ]);
            lib = {
                EffectComposer: composerMod.EffectComposer,
                RenderPass: renderMod.RenderPass,
                ShaderPass: shaderMod.ShaderPass,
                UnrealBloomPass: bloomMod.UnrealBloomPass
            };
        } catch (err) {
            libFailed = true;
            console.warn('[postfx] post-processing unavailable:', err.message);
        }
        return lib;
    }

    function disposeComposer() {
        if (!composer) return;
        bloomPass.dispose();
        finalPass.dispose();
        composer.dispose();
        composer = null;
        renderPass = null;
        bloomPass = null;
        finalPass = null;
    }

    function resize(force) {
        renderer.getSize(_size);
        const ratio = renderer.getPixelRatio();
        if (!force && _size.x === width && _size.y === height && ratio === pixelRatio) return;
        width = _size.x;
        height = _size.y;
        pixelRatio = ratio;
        composer.setPixelRatio(ratio);
        composer.setSize(width, height);
        // Bloom is a wide blur: the medium preset computes it at half resolution.
        if (bloomScale !== 1) bloomPass.setSize(width * ratio * bloomScale, height * ratio * bloomScale);
    }

    function buildComposer(wantSamples) {
        disposeComposer();
        const gl = renderer.getContext();
        const floatTarget = Boolean(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
        const target = new THREE.WebGLRenderTarget(1, 1, {
            type: floatTarget ? THREE.HalfFloatType : THREE.UnsignedByteType,
            samples: wantSamples
        });
        composer = new lib.EffectComposer(renderer, target);
        renderPass = new lib.RenderPass(engine.scene, engine.camera);
        bloomPass = new lib.UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
        finalPass = new lib.ShaderPass(BodycamShader);
        composer.addPass(renderPass);
        composer.addPass(bloomPass);
        composer.addPass(finalPass);
        samples = wantSamples;
        resize(true);
    }

    function renderHook(r, scene, camera, dt) {
        if (!composer) {
            r.render(scene, camera);
            return;
        }
        resize(false);
        renderPass.scene = scene;
        renderPass.camera = camera;
        const uTime = finalPass.uniforms.uTime;
        uTime.value = (uTime.value + dt) % 64;
        // Several passes draw per frame: count them as one frame in renderer.info.
        r.info.reset();
        composer.render(dt);
    }

    function setHook(active) {
        if (active) {
            renderer.info.autoReset = false;
            window.BATTLE_ENGINE.setCustomRenderHook(renderHook);
        } else if (engine.customRenderHook === renderHook) {
            renderer.info.autoReset = true;
            window.BATTLE_ENGINE.setCustomRenderHook(null);
        }
    }

    async function applyQuality() {
        const profile = engine.quality.profile;
        const fx = profile.postfx;
        const wanted = Boolean(fx.composer) && Boolean(await loadLib());
        if (engine.quality.profile !== profile) return;     // preset changed again while loading

        if (wanted) {
            const wantSamples = profile.msaa ? (fx.samples || 0) : 0;
            if (!composer || samples !== wantSamples) buildComposer(wantSamples);
            bloomPass.enabled = Boolean(fx.bloom);
            const scale = fx.bloomScale > 0 ? fx.bloomScale : 1;
            if (scale !== bloomScale) {
                bloomScale = scale;
                resize(true);
            }
            finalPass.uniforms.uVignette.value = fx.vignette ? VIGNETTE : 0;
            finalPass.uniforms.uGrain.value = fx.grain ? GRAIN : 0;
        } else {
            disposeComposer();
        }
        setHook(wanted);
        if (vignetteEl) vignetteEl.style.display = !wanted && fx.vignette ? 'block' : 'none';
    }

    function createVignetteOverlay() {
        const layer = engine.hudLayer;
        if (!layer) return;
        const style = document.createElement('style');
        style.textContent = '.gfx-vignette{position:absolute;inset:0;pointer-events:none;display:none;'
            + 'background:radial-gradient(ellipse at center,rgba(0,0,0,0) 52%,rgba(0,0,0,0.4) 100%);}';
        document.head.appendChild(style);
        vignetteEl = document.createElement('div');
        vignetteEl.className = 'gfx-vignette';
        layer.insertBefore(vignetteEl, layer.firstChild);
    }

    return {
        name: 'postfx',
        get active() {
            return composer !== null;
        },

        async install() {
            createVignetteOverlay();
            await applyQuality();
            engine.events.on('quality:changed', () => { applyQuality(); });
        },

        onResize() {
            if (composer) resize(false);
        }
    };
}
