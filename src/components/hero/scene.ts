import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { REVEAL_END, ZOOM_END, createComposite, zoom } from './intro'

const FOV = 35
// Camera poses. `need` is the scene width (m) that must stay in frame on narrow screens.
const WIDE = { pos: new THREE.Vector3(0, 1.1, 6.6), tgt: new THREE.Vector3(0, 1.5, 0), need: 2.9 }
const CLOSE = { pos: new THREE.Vector3(0, 1.3, 4.0), tgt: new THREE.Vector3(0, 1.22, 0), need: 2.1 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
// Deterministic PRNG so the meadow looks the same on every load.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Ground height. Flat under the table, crest behind it, falling away to the horizon. */
function hill(x: number, z: number) {
  const f = smooth(0.8, 3, Math.hypot(x, z))
  return (
    f * (0.05 * x + 0.07 * Math.sin(0.8 * x + 0.5) * Math.sin(0.6 * z + 1)) +
    0.3 * Math.exp(-(((z + 5.5) / 3) ** 2)) -
    0.0104 -
    (z < 0 ? 0.012 : 0.006) * z * z
  )
}

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}`

// Painted meadow colour by world position (p = xz); shared by the ground and every blade.
const GROUND = /* glsl */ `
uniform vec3 uDeep, uMid, uSun, uFore, uGlow, uTip;
${NOISE}
vec3 groundColor(vec2 p) {
  float n = vnoise(p * 0.35) * 0.65 + vnoise(p * 1.3 + 7.0) * 0.35;
  vec3 c = mix(uDeep, uMid, smoothstep(0.25, 0.55, n));
  c = mix(c, uSun, smoothstep(0.5, 0.8, n) * (1.0 - smoothstep(0.5, 5.0, p.y)));
  c = mix(c, uFore, smoothstep(1.5, 6.5, p.y) * 0.85);
  vec2 q = (p - vec2(0.45, 0.1)) / vec2(1.5, 0.75);             // desk shadow
  c *= mix(0.58, 1.0, smoothstep(0.45, 1.0, length(q)));
  vec2 g = p - vec2(0.0, 0.9);                                   // CRT glow (night only)
  return c + uGlow * exp(-dot(g, g) * 0.9);
}`

const WIND = /* glsl */ `
uniform float uTime, uShake;
uniform vec3 uPointer;
// xz sway for a point rooted at 'root'; rnd in 0..1
vec2 sway(vec3 root, float rnd) {
  float ph = root.x * 0.55 + root.z * 0.35;
  float w = sin(uTime * 1.3 + ph + rnd * 2.0) * 0.6 + sin(uTime * 2.7 + ph * 2.3 + rnd * 6.0) * 0.25 + 0.5;
  float k = uShake * (1.0 - smoothstep(0.0, 1.3, distance(root.xz, uPointer.xz)));
  vec2 shake = vec2(sin(uTime * 16.0 + rnd * 40.0), cos(uTime * 19.0 + rnd * 23.0)) * k * 0.3;
  return vec2(w * 0.22, 0.0) + shake;
}`

function faceTexture() {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 96
  const g = c.getContext('2d')!
  g.fillStyle = '#17231c'
  g.fillRect(0, 0, 128, 96)
  g.strokeStyle = g.fillStyle = '#5dff86'
  g.lineWidth = 3
  g.lineCap = 'round'
  for (const cx of [43, 85]) {
    g.beginPath()
    for (let a = 0; a < Math.PI * 5; a += 0.2) {
      const r = 1 + a * 0.85
      g.lineTo(cx + Math.cos(a) * r, 42 + Math.sin(a) * r)
    }
    g.stroke()
  }
  g.fillRect(62, 58, 4, 3)
  for (const s of [-1, 1]) {
    for (const [y0, y1] of [[54, 49], [61, 61], [68, 73]]) {
      g.beginPath()
      g.moveTo(64 + s * 34, y0)
      g.lineTo(64 + s * 54, y1)
      g.stroke()
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.14)'
  for (let y = 0; y < 96; y += 2) g.fillRect(0, y, 128, 1)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false // glTF UV convention
  tex.magFilter = THREE.NearestFilter
  return tex
}

export async function createHero(canvas: HTMLCanvasElement, onReady: () => void) {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const darkQuery = matchMedia('(prefers-color-scheme: dark)')
  const root = document.documentElement

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)
  const rand = mulberry32(7)

  // ---- day/night colours: every themed uniform lerps between its two values ----
  const themed: Array<{ d: THREE.Color; n: THREE.Color; value: THREE.Color }> = []
  const tc = (day: string, night: string) => {
    const u = { d: new THREE.Color(day), n: new THREE.Color(night), value: new THREE.Color(day) }
    themed.push(u)
    return u
  }
  const uTime = { value: 0 }
  const uNight = { value: 0 }
  const uShake = { value: 0 }
  const uPointer = { value: new THREE.Vector3(0, -100, 0) }
  const uRes = { value: new THREE.Vector2(1, 1) }
  const uBg = tc('#fafafa', '#0a0a0a')
  const uLine = tc('#171717', '#ededed')
  const ground = {
    uDeep: tc('#467f35', '#0f3038'),
    uMid: tc('#84ac45', '#17454a'),
    uSun: tc('#cfd06a', '#2a6a5c'),
    uFore: tc('#2f6a45', '#081d28'),
    uTip: tc('#f0e392', '#3f8f7c'),
    uGlow: tc('#000000', '#1f7a3c'),
  }
  const wind = { uTime, uShake, uPointer }

  // ---- lights (toon materials only) ----
  const sunColor = tc('#ffe0ad', '#8fa8ff')
  const ambColor = tc('#e6e4ee', '#5568c8')
  const sun = new THREE.DirectionalLight()
  sun.position.set(-5, 2.8, 3.4)
  const amb = new THREE.AmbientLight()
  const glow = new THREE.PointLight(0x4dff80, 0, 3, 2)
  glow.position.set(0, 1.1, 0.45)
  scene.add(sun, amb, glow)

  // Everything that is not part of the wireframe pass.
  const notInWire: Array<THREE.Object3D> = []

  // ---- sky ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTop: tc('#3d76c8', '#060a1c'),
        uMid: tc('#6ea6e2', '#0f1a40'),
        uLow: tc('#c3daee', '#2b2857'),
        uHorizon: tc('#fbd2b6', '#6a4372'),
        uWisp: tc('#ffe3d6', '#3a3f78'),
        uSunGlow: tc('#ffd58a', '#000000'),
        uNight,
        uTime,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uMid, uLow, uHorizon, uWisp, uSunGlow;
        uniform float uNight, uTime;
        varying vec3 vDir;
        ${NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float e = d.y, az = atan(d.x, -d.z);
          vec3 c = mix(uHorizon, uLow, smoothstep(-0.12, 0.02, e));
          c = mix(c, uMid, smoothstep(0.0, 0.2, e));
          c = mix(c, uTop, smoothstep(0.15, 0.55, e));
          float sg = max(dot(d, normalize(vec3(-0.92, 0.04, -0.4))), 0.0);
          c += uSunGlow * (pow(sg, 3.0) * 0.6 + pow(sg, 40.0) * 0.6);

          vec2 wp = vec2(az * 2.2 - uTime * 0.006, e * 14.0);
          float w = vnoise(wp * vec2(1.0, 2.2)) * 0.6 + vnoise(wp * vec2(2.3, 5.0) + 3.1) * 0.4;
          w = smoothstep(0.62, 0.9, w) * smoothstep(0.05, 0.2, e) * (1.0 - smoothstep(0.35, 0.6, e));
          c = mix(c, uWisp, w * 0.55);

          vec2 sp = vec2(az, e) * 90.0, cell = floor(sp);
          float h = hash(cell);
          vec2 o = (vec2(hash(cell + 1.7), hash(cell + 9.2)) - 0.5) * 0.6;
          float star = step(0.93, h) * smoothstep(0.12, 0.0, length(fract(sp) - 0.5 - o));
          star *= 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
          c += star * uNight * smoothstep(-0.02, 0.15, e) * vec3(0.9, 0.95, 1.0);

          float m = distance(d, normalize(vec3(0.46, 0.27, -1.0)));
          c += uNight * (smoothstep(0.03, 0.026, m) * vec3(1.0, 0.96, 0.85) + exp(-m * 9.0) * 0.18 * vec3(0.6, 0.7, 1.0));

          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  )
  sky.frustumCulled = false
  sky.renderOrder = -1
  scene.add(sky)
  notInWire.push(sky)

  // ---- assets ----
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const textures = new THREE.TextureLoader()
  const [gltf, cloudMain, cloudSmall] = await Promise.all([
    loader.loadAsync('/hero/scene.glb'),
    textures.loadAsync('/hero/cloud-main.webp'),
    textures.loadAsync('/hero/cloud-small.webp'),
  ])

  // ---- clouds: sprites at different depths, drifting left to right ----
  const cloudUniforms = { uTint: tc('#ffffff', '#4a4f94'), uHaze: tc('#f8c9b4', '#3a2f5e') }
  const clouds: Array<{ mesh: THREE.Mesh; speed: number; range: number }> = []
  const addCloud = (tex: THREE.Texture<HTMLImageElement>, x: number, bottom: number, z: number, width: number, speed: number, range: number) => {
    tex.colorSpace = THREE.SRGBColorSpace
    const height = (width * tex.image.height) / tex.image.width
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { map: { value: tex }, ...cloudUniforms },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map;
          uniform vec3 uTint, uHaze;
          varying vec2 vUv;
          void main() {
            vec4 c = texture2D(map, vUv);
            c.rgb = mix(c.rgb * uTint, uHaze, (1.0 - smoothstep(0.08, 0.5, vUv.y)) * 0.55);
            gl_FragColor = vec4(c.rgb, c.a * smoothstep(0.02, 0.24, vUv.y));
            #include <colorspace_fragment>
          }`,
      }),
    )
    mesh.position.set(x, bottom + height / 2, z)
    scene.add(mesh)
    notInWire.push(mesh)
    clouds.push({ mesh, speed, range })
  }
  addCloud(cloudMain, -3, -11, -70, 56, 0.18, 110)
  addCloud(cloudMain, -113, -12, -74, 50, 0.18, 110)
  addCloud(cloudSmall, -40, -9, -88, 32, 0.12, 130)
  addCloud(cloudSmall, 38, -10, -96, 38, 0.1, 140)
  addCloud(cloudSmall, 62, -5.5, -60, 18, 0.26, 100)
  addCloud(cloudSmall, -72, -6, -64, 21, 0.24, 105)

  // ---- PC + table: toon materials and inverted-hull outlines ----
  const ramp = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    const x = i / 31 // 0 = facing away from the sun, 1 = facing it
    ramp[i] = 255 * (0.65 * smooth(0.42, 0.95, x) + 0.35 * smooth(0.52, 0.6, x))
  }
  const gradient = new THREE.DataTexture(ramp, 32, 1, THREE.RedFormat)
  gradient.minFilter = gradient.magFilter = THREE.LinearFilter
  gradient.needsUpdate = true
  const uOutlinePx = { value: 1.4 }
  const outlineMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uColor: tc('#5f4a3d', '#04050c'), uRes, uPx: uOutlinePx },
    vertexShader: /* glsl */ `
      uniform vec2 uRes;
      uniform float uPx;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 dir = normalize((projectionMatrix * vec4(normalMatrix * normal, 0.0)).xy * uRes + 1e-6);
        clip.xy += dir * (2.0 * uPx / uRes) * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); \n#include <colorspace_fragment>\n }`,
  })
  const toon = new Map<string, THREE.Material>()
  const meshes: Array<THREE.Mesh> = []
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  for (const mesh of meshes) {
    const src = mesh.material as THREE.MeshStandardMaterial
    if (src.name === 'glass') {
      mesh.material = new THREE.MeshBasicMaterial({ map: faceTexture() })
    } else if (src.name === 'led') {
      mesh.material = new THREE.MeshBasicMaterial({ color: 0x7dff8a })
    } else {
      if (!toon.has(src.name)) {
        toon.set(src.name, new THREE.MeshToonMaterial({ color: src.color, gradientMap: gradient }))
      }
      mesh.material = toon.get(src.name)!
      // small parts read better without a line around each one, and the black desk needs none
      if (!/^(key|bay|label|metal|coffee|cable|glassOff|desk)/.test(src.name)) {
        const outline = new THREE.Mesh(mesh.geometry, outlineMat)
        mesh.add(outline)
        notInWire.push(outline)
      }
    }
    src.dispose()
  }
  scene.add(gltf.scene)

  // ---- ground ----
  const groundGeo = new THREE.PlaneGeometry(40, 24, 80, 48).rotateX(-Math.PI / 2).translate(0, 0, -4)
  const gp = groundGeo.attributes.position
  for (let i = 0; i < gp.count; i++) gp.setY(i, hill(gp.getX(i), gp.getZ(i)))
  scene.add(
    new THREE.Mesh(
      groundGeo,
      new THREE.ShaderMaterial({
        uniforms: ground,
        vertexShader: `varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `${GROUND} varying vec2 vP; void main() { gl_FragColor = vec4(groundColor(vP) * 0.82, 1.0); \n#include <colorspace_fragment>\n }`,
      }),
    ),
  )

  // ---- grass and flowers: one instanced draw call each ----
  // Points are scattered in the wedge the cameras can see, denser towards the front.
  // Portrait screens pull the camera back, so the meadow has to start closer to it.
  const front = canvas.clientWidth < canvas.clientHeight ? 5.6 : 3.4
  const spot = () => {
    const z = front - (front + 9) * rand() ** 1.6
    const half = 1.5 + (6.3 - z) * 0.75
    const x = (rand() * 2 - 1) * half
    return [x, hill(x, z), z] as const
  }
  const instanced = (base: THREE.BufferGeometry, count: number, fill: (i: number, a: Float32Array, b: Float32Array, c: Float32Array) => void) => {
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = base.index
    geo.setAttribute('position', base.attributes.position)
    const a = new Float32Array(count * 3)
    const b = new Float32Array(count * 4)
    const c = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) fill(i, a, b, c)
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(a, 3))
    geo.setAttribute('aData', new THREE.InstancedBufferAttribute(b, 4))
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(c, 3))
    geo.instanceCount = count
    return geo
  }

  const blade = new THREE.BufferGeometry()
  blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.32, 0.5, 0, 0.32, 0.5, 0, 0, 1, 0], 3))
  blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4])
  const grass = new THREE.Mesh(
    instanced(blade, desktop ? 90000 : 24000, (i, a, b) => {
      const [x, y, z] = spot()
      a.set([x, y, z], i * 3)
      // height (taller in the foreground), yaw, random, width
      b.set([0.13 + rand() * 0.3 + smooth(1.5, 3.4, z) * 0.12, rand() * Math.PI, rand(), 0.009 + rand() * 0.012], i * 4)
    }),
    new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { ...ground, ...wind },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset;
        attribute vec4 aData;
        varying vec3 vColor;
        ${GROUND}
        ${WIND}
        void main() {
          float h = position.y, c = cos(aData.y), s = sin(aData.y);
          vec3 p = vec3(position.x * aData.w, h * aData.x, h * h * aData.x * 0.25 * (aData.z - 0.3));
          p = vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
          float bend = h * h * aData.x;
          vec2 sw = sway(aOffset, aData.z) * bend;
          p.xz += sw;
          p.y -= length(sw) * 0.25;
          vColor = mix(groundColor(aOffset.xz) * mix(0.66, 1.0, h), uTip, h * h * 0.4) * (0.88 + 0.24 * aData.z);
          gl_Position = projectionMatrix * viewMatrix * vec4(aOffset + p, 1.0);
        }`,
      fragmentShader: `varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); \n#include <colorspace_fragment>\n }`,
    }),
  )

  const kinds = [
    { color: new THREE.Color('#fffaf0'), petals: 12 }, // daisy
    { color: new THREE.Color('#f29ac0'), petals: 8 },
    { color: new THREE.Color('#d665a5'), petals: 8 },
    { color: new THREE.Color('#b99be6'), petals: 5 },
  ]
  const flowers = new THREE.Mesh(
    instanced(new THREE.PlaneGeometry(1, 1), desktop ? 4500 : 1500, (i, a, b, c) => {
      const [x, y, z] = spot()
      const kind = kinds[rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 3)]
      a.set([x, y, z], i * 3)
      b.set([0.03 + rand() * 0.035, rand(), kind.petals, 0.18 + rand() * 0.2], i * 4) // size, random, petals, stem height
      kind.color.toArray(c, i * 3)
    }),
    new THREE.ShaderMaterial({
      uniforms: { ...wind, uFlowerTint: tc('#ffffff', '#7f8fd0'), uCenter: { value: new THREE.Color('#f2b632') } },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset, aColor;
        attribute vec4 aData;
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec2 vShape;
        ${WIND}
        void main() {
          vec3 base = aOffset + vec3(0.0, aData.w, 0.0);
          base.xz += sway(aOffset, aData.y) * aData.w;
          vec4 mv = viewMatrix * vec4(base, 1.0);
          // billboard, squashed vertically so the bloom reads as tilted up towards the sky
          mv.xy += position.xy * aData.x * vec2(1.0, 0.5 + 0.35 * aData.y);
          vUv = position.xy * 2.0;
          vColor = aColor;
          vShape = vec2(aData.z, aData.y);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFlowerTint, uCenter;
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec2 vShape;
        void main() {
          float r = length(vUv);
          float petal = pow(abs(cos(atan(vUv.y, vUv.x) * vShape.x * 0.5 + vShape.y * 6.28)), 0.7);
          if (r > mix(0.4, 1.0, petal)) discard;
          vec3 c = r < 0.26
            ? uCenter * mix(1.0, 0.72, smoothstep(0.1, 0.26, r))
            : vColor * mix(0.78, 1.0, smoothstep(0.26, 0.9, r)) * mix(0.9, 1.0, petal);
          gl_FragColor = vec4(c * uFlowerTint, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  )
  for (const m of [grass, flowers]) {
    m.frustumCulled = false
    scene.add(m)
    notInWire.push(m)
  }

  // ---- theme ----
  const wantNight = () => {
    const t = root.dataset.theme
    return t === 'dark' || (t !== 'light' && darkQuery.matches) ? 1 : 0
  }
  let night = wantNight()
  const applyTheme = () => {
    for (const u of themed) u.value.lerpColors(u.d, u.n, night)
    uNight.value = night
    sun.color.copy(sunColor.value)
    amb.color.copy(ambColor.value)
    sun.intensity = Math.PI * lerp(0.6, 0.2, night)
    amb.intensity = Math.PI * lerp(0.56, 0.22, night)
    glow.intensity = 0.1 * night
    renderer.setClearColor(uBg.value)
  }
  applyTheme()

  // ---- state ----
  let t = still ? ZOOM_END : 0 // intro clock
  let dirty = true // reduced motion renders on demand only
  let visible = true
  let comp: ReturnType<typeof createComposite> | null = still
    ? null
    : createComposite(renderer, scene, camera, notInWire, uBg, uLine)

  const size = new THREE.Vector2()
  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    renderer.setPixelRatio(Math.min(devicePixelRatio, desktop ? 2 : 1.5))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.getDrawingBufferSize(size)
    uRes.value.copy(size)
    comp?.setSize(size.x, size.y)
    dirty = true
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()
  const viewObserver = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
  viewObserver.observe(canvas)

  const themeObserver = new MutationObserver(() => (dirty = true))
  themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  const onScheme = () => (dirty = true)
  darkQuery.addEventListener('change', onScheme)

  // ---- pointer (desktop only): parallax + grass shake under the cursor ----
  const pointer = new THREE.Vector2()
  const parallax = new THREE.Vector2()
  let hovering = false
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2)
    hovering = true
  }
  const onLeave = () => (hovering = false)
  if (desktop && !still) {
    window.addEventListener('pointermove', onMove)
    root.addEventListener('pointerleave', onLeave)
  }

  const pos = new THREE.Vector3()
  const tgt = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const ray = new THREE.Vector3()
  /** Camera position for a pose, pulled back on narrow screens so `need` metres fit. */
  const fit = (p: typeof WIDE, out: THREE.Vector3) => {
    out.subVectors(p.pos, p.tgt)
    const dist = Math.max(out.length(), p.need / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * camera.aspect))
    return out.setLength(dist).add(p.tgt)
  }

  let raf = 0
  let last = performance.now()
  let ready = false
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!visible) return

    const target = wantNight()
    if (Math.abs(target - night) > 0.001) {
      night = still ? target : lerp(night, target, 1 - Math.exp(-dt * 5))
      applyTheme()
      dirty = true
    }
    if (still && !dirty) return
    dirty = false

    if (!still) {
      t += dt
      uTime.value += dt
      for (const c of clouds) {
        c.mesh.position.x += c.speed * dt
        if (c.mesh.position.x > c.range) c.mesh.position.x -= c.range * 2
      }
    }

    // camera: intro zoom, then pointer parallax around the target
    const k = zoom(t)
    pos.lerpVectors(fit(WIDE, a), fit(CLOSE, b), k)
    tgt.lerpVectors(WIDE.tgt, CLOSE.tgt, k)
    const active = hovering && t > ZOOM_END
    parallax.lerp(active ? pointer : pointer.set(0, 0), 1 - Math.exp(-dt * 4))
    camera.position.copy(pos)
    camera.lookAt(tgt)
    camera.translateX(parallax.x * lerp(0.5, 0.2, k))
    camera.translateY(parallax.y * lerp(0.25, 0.1, k))
    camera.lookAt(tgt)
    uOutlinePx.value = lerp(0.8, 1.2, k) * renderer.getPixelRatio()

    // where the cursor ray meets the hill
    let hit = false
    if (active) {
      camera.updateMatrixWorld()
      ray.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(camera.position).normalize()
      if (ray.y < -0.01) {
        let y = 0
        for (let i = 0; i < 3; i++) {
          const s = (y - camera.position.y) / ray.y
          uPointer.value.set(camera.position.x + ray.x * s, y, camera.position.z + ray.z * s)
          y = hill(uPointer.value.x, uPointer.value.z)
        }
        hit = true
      }
    }
    uShake.value = lerp(uShake.value, hit ? 1 : 0, 1 - Math.exp(-dt * 6))

    if (comp && t >= REVEAL_END) {
      comp.dispose()
      comp = null
    }
    if (comp) comp.render(t)
    else renderer.render(scene, camera)

    if (!ready) {
      ready = true
      onReady()
    }
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    resizeObserver.disconnect()
    viewObserver.disconnect()
    themeObserver.disconnect()
    darkQuery.removeEventListener('change', onScheme)
    window.removeEventListener('pointermove', onMove)
    root.removeEventListener('pointerleave', onLeave)
    comp?.dispose()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose()
        for (const u of Object.values((mat as THREE.ShaderMaterial).uniforms ?? {})) {
          if (u.value instanceof THREE.Texture) u.value.dispose()
        }
        mat.dispose()
      }
    })
    gradient.dispose()
    renderer.dispose()
  }
}
