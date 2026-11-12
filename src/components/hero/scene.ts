import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { toggleTheme } from '../theme'
import catSvg from './cat.svg?raw' // the favicon artwork; its silhouette is drawn on the PC's screen
import { createCables } from './cables'
import type { Port } from './cables'
import { REVEAL_END, REVEAL_START, TITLE_AT, ZOOM_END, createComposite, zoom } from './intro'

const FOV = 35
// Camera poses, looking down into the valley so the frame is mostly ground.
// `need` is the scene width (m) that must stay in frame on narrow screens.
const WIDE = { pos: new THREE.Vector3(0, 3.7, 12.6), tgt: new THREE.Vector3(0, 1.1, 0), need: 3.4 }
const CLOSE = { pos: new THREE.Vector3(0, 2.6, 6.9), tgt: new THREE.Vector3(0, 1.15, 0), need: 2.9 }
// Scrolling carries the camera from CLOSE, through SKY_MID, to SKY: it lowers a little while tilting
// up to follow the monitors as they float.
const SKY_MID = { pos: new THREE.Vector3(0, 2.4, 7.0), tgt: new THREE.Vector3(0, 1.5, 0), need: 3.4 }
const SKY = { pos: new THREE.Vector3(0, 2.15, 7.0), tgt: new THREE.Vector3(0, 1.9, 0), need: 3.6 }
const TITLE_Z = -34 // the heading hangs here, behind both hills

// Low sun, from the left and a little in front.
const SUN = new THREE.Vector3(-5, 2.8, 3.4).normalize()

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** CSS cubic-bezier(x1, y1, x2, y2) evaluated at time x, by Newton's method. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number) {
  const at = (t: number, a: number, b: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3
  let t = x
  for (let i = 0; i < 6; i++) {
    const dx = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * (1 - t) * t + 3 * (1 - x2) * t * t
    if (Math.abs(dx) < 1e-6) break
    t -= (at(t, x1, x2) - x) / dx
  }
  return at(clamp01(t), y1, y2)
}
// the heading reveal curve, taken from auctervia.tech: cubic-bezier(0.33, 0, 0.2, 1)
const revealEase = (x: number) => cubicBezier(0.33, 0, 0.2, 1, clamp01(x))
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

/** Ground height: a flat meadow, then two separate hills behind it (A left and nearer, B right and farther). */
function hill(x: number, z: number) {
  const pad = smooth(1.8, 5, Math.hypot(x, z))
  const a = 3.6 * Math.exp(-(((x + 9) / 9) ** 2) - ((z + 15) / 6.5) ** 2)
  const b = 3.0 * Math.exp(-(((x - 10) / 10) ** 2) - ((z + 26) / 7) ** 2)
  const roll = 0.1 * Math.sin(0.5 * x + 0.5) * Math.sin(0.4 * z + 1) + 0.04 * Math.sin(1.3 * x + 2) * Math.sin(1.1 * z)
  return pad * (a + b + roll) - (z > 0 ? 0.006 * z * z : 0)
}
/** 0..1: how far the slope at a point faces the sun (flat ground is about 0.7). */
function slopeLit(x: number, z: number) {
  const e = 0.5
  const nx = hill(x - e, z) - hill(x + e, z)
  const nz = hill(x, z - e) - hill(x, z + e)
  return smooth(0.1, 0.6, (nx * SUN.x + 2 * e * SUN.y + nz * SUN.z) / Math.hypot(nx, 2 * e, nz))
}
// Value noise on the CPU, used to grow the meadow in clumps.
const hash2 = (x: number, z: number) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453
  return s - Math.floor(s)
}
function noise2(x: number, z: number) {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const u = smooth(0, 1, x - xi)
  const v = smooth(0, 1, z - zi)
  return lerp(lerp(hash2(xi, zi), hash2(xi + 1, zi), u), lerp(hash2(xi, zi + 1), hash2(xi + 1, zi + 1), u), v)
}

// The GLSL chunks below build on each other: NOISE, then POOL / SHADOW, then GROUND and WIND.
const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}`

// 1 where sunlight reaches the ground, 0 in shade (p = world xz).
const POOL = /* glsl */ `
float pool(vec2 p) {
  vec2 q = (p - vec2(0.9, 0.3)) / vec2(6.5, 3.0);
  q.x += q.y * 0.35;
  float desk = 1.0 - smoothstep(0.45, 1.1, length(q) + (vnoise(p * 0.45) - 0.5) * 0.5);
  float patches = 0.75 * smoothstep(0.56, 0.74, vnoise(p * 0.07 + 3.7)) * smoothstep(8.0, 13.0, length(p)); // on the hills
  return max(desk, patches);
}`

// 1 = open, 0 = in the shadow of the desk and monitors (rendered once from the sun's direction).
const SHADOW = /* glsl */ `
uniform sampler2D uShadow; // r: shadow of everything, g: shadow of the desk and ground monitors only
uniform mat4 uShadowMat;
uniform float uShadowMix;  // 0 everything is on the desk, 1 it has all floated away
float shadowAt(vec3 wp) {
  vec2 uv = (uShadowMat * vec4(wp, 1.0)).xy * 0.5 + 0.5;
  const float r = 0.012;
  vec2 s = (texture2D(uShadow, uv).rg * 2.0
          + texture2D(uShadow, uv + vec2(r, 0.0)).rg + texture2D(uShadow, uv - vec2(r, 0.0)).rg
          + texture2D(uShadow, uv + vec2(0.0, r)).rg + texture2D(uShadow, uv - vec2(0.0, r)).rg) / 6.0;
  return mix(s.r, s.g, uShadowMix);
}`

// Meadow colour at a world position; shared by the ground, every blade and the flowers.
const GROUND = /* glsl */ `
uniform vec3 uDeep, uMid, uSun, uShadeA, uShadeB, uAir, uGlow, uTip, uDry;
// lit: how far the slope faces the sun; pl: pool(); sh: shadowAt()
vec3 groundColor(vec3 wp, float lit, float pl, float sh) {
  vec2 p = wp.xz;
  float n = vnoise(p * 0.35) * 0.65 + vnoise(p * 1.3 + 7.0) * 0.35;
  vec3 sunny = mix(mix(uDeep, uMid, smoothstep(0.25, 0.55, n)), uSun, smoothstep(0.5, 0.8, n));
  vec3 shade = mix(uShadeA, uShadeB, smoothstep(0.3, 0.7, n));
  vec3 c = mix(shade, sunny, pl) * mix(0.7, 1.15, lit) * mix(0.5, 1.0, sh);
  vec2 g = p - vec2(0.0, 0.9);                                   // CRT glow (night only)
  return c + uGlow * exp(-dot(g, g) * 0.9);
}
// distance haze: this is what separates the far hill from the near one
float airAt(vec3 wp) { return smoothstep(8.0, 48.0, -wp.z) * 0.55; }
vec3 air(vec3 c, vec3 wp) { return mix(c, uAir, airAt(wp)); }`

const WIND = /* glsl */ `
uniform float uTime, uShake;
uniform vec3 uPointer;
// xz sway for a point rooted at 'root'; rnd in 0..1
vec2 sway(vec3 root, float rnd) {
  float gust = vnoise(root.xz * 0.16 - vec2(uTime * 0.55, uTime * 0.12)); // bands of wind crossing the meadow
  float flutter = sin(uTime * 3.1 + rnd * 40.0 + root.x * 2.0) * 0.12;
  float k = uShake * (1.0 - smoothstep(0.0, 1.3, distance(root.xz, uPointer.xz)));
  vec2 shake = vec2(sin(uTime * 16.0 + rnd * 40.0), cos(uTime * 19.0 + rnd * 23.0)) * k * 0.3;
  return vec2(0.08 + gust * 0.5 + flutter, gust * 0.12) + shake;
}`

/**
 * One texture for every lit screen: 4x2 cells that match the atlas UVs baked into the model.
 * Cells: 0-3 MAKE / PRODUCTS / FEEL / AMAZING, 4 cat (redrawn live), 5 prompt, 6 sun or moon
 * (the TV: clicking it switches the colour mode).
 */
function screenAtlas(catPath: string | null) {
  const W = 128
  const H = 96
  const c = document.createElement('canvas')
  c.width = W * 8 // drawn at 2x, in 128 x 96 units per cell
  c.height = H * 4
  const g = c.getContext('2d')!
  g.scale(2, 2)
  const font = (px: number) => `bold ${px}px ui-monospace, Menlo, Consolas, monospace`
  g.fillStyle = '#17231c'
  g.fillRect(0, 0, W * 4, H * 2)
  g.fillStyle = '#5dff86'
  g.textBaseline = 'middle'
  const at = (i: number) => [(i % 4) * W, Math.floor(i / 4) * H] as const

  g.textAlign = 'center'
  ;['MAKE', 'PRODUCTS', 'FEEL', 'AMAZING'].forEach((text, i) => {
    const [x, y] = at(i)
    let px = 44
    do g.font = font(px)
    while (g.measureText(text).width > W - 18 && --px > 8)
    g.fillText(text, x + W / 2, y + H / 2 + 2)
  })
  {
    const [x, y] = at(5)
    g.textAlign = 'left'
    g.font = font(22)
    g.fillText('>_', x + 14, y + 26)
  }
  g.fillStyle = 'rgba(0,0,0,0.16)' // scanlines
  for (let y = 0; y < H * 2; y += 2) g.fillRect(0, y, W * 4, 1)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false // glTF UV convention

  // The cat: the favicon silhouette, with its spiral eyes redrawn so they can look around and
  // blink. lx/ly: where it looks, -1..1 (ly positive = down). open: 1 eyes open, 0 shut.
  const cat = catPath ? new Path2D(catPath) : null
  const drawCat = (lx: number, ly: number, open: number) => {
    const [x, y] = at(4)
    g.save()
    g.beginPath()
    g.rect(x, y, W, H)
    g.clip()
    g.fillStyle = '#17231c'
    g.fillRect(x, y, W, H)
    g.translate(x + W / 2 + lx * 3, y + H / 2 + ly * 2) // the head leans a little towards what it watches
    g.rotate(lx * 0.07)
    g.scale(100 / 500, 100 / 500) // the favicon is drawn on a 500 unit square
    g.translate(-250, -240)
    g.fillStyle = '#5dff86'
    g.strokeStyle = '#5dff86'
    if (cat) g.fill(cat, 'evenodd')
    g.lineWidth = 12
    g.lineCap = 'round'
    for (const cx of [170, 326]) {
      g.fillStyle = '#17231c'
      g.beginPath()
      g.arc(cx, 275, 49, 0, Math.PI * 2)
      g.fill()
      g.save()
      g.translate(cx + lx * 13, 275 + ly * 10) // the eyes move more than the head
      g.scale(1, Math.max(0.08, open))
      g.beginPath()
      for (let a = 0; a < Math.PI * 2.8; a += 0.2) g.lineTo(Math.cos(a) * (2 + a * 3.9), Math.sin(a) * (2 + a * 3.9))
      g.stroke()
      g.restore()
    }
    g.restore()
    g.fillStyle = 'rgba(0,0,0,0.16)'
    for (let yy = y; yy < y + H; yy += 2) g.fillRect(x, yy, W, 1)
    tex.needsUpdate = true
  }
  drawCat(0, 0, 1)

  // The TV shows a sun in light mode and a moon in dark mode.
  const drawThemeIcon = (dark: boolean) => {
    const [x, y] = at(6)
    const cx = x + W / 2 - 6 // the TV's screen is a little left of its cell's centre
    const cy = y + H / 2
    g.save()
    g.fillStyle = '#17231c'
    g.fillRect(x, y, W, H)
    g.fillStyle = g.strokeStyle = '#5dff86'
    g.lineWidth = 5
    g.lineCap = 'round'
    if (dark) {
      g.beginPath()
      g.arc(cx, cy, 22, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#17231c'
      g.beginPath()
      g.arc(cx + 11, cy - 9, 19, 0, Math.PI * 2)
      g.fill()
    } else {
      g.beginPath()
      g.arc(cx, cy, 13, 0, Math.PI * 2)
      g.fill()
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4
        g.beginPath()
        g.moveTo(cx + Math.cos(a) * 21, cy + Math.sin(a) * 21)
        g.lineTo(cx + Math.cos(a) * 29, cy + Math.sin(a) * 29)
        g.stroke()
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.16)'
    for (let yy = y; yy < y + H; yy += 2) g.fillRect(x, yy, W, 1)
    g.restore()
    tex.needsUpdate = true
  }
  drawThemeIcon(document.documentElement.dataset.theme === 'dark')
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearFilter // no mipmaps: they would bleed one cell into the next
  tex.generateMipmaps = false
  return { tex, drawCat, drawThemeIcon }
}

export type HeroStage = 'wire' | 'reveal' | 'done'

/**
 * Builds the scene and waits, drawing nothing visible, until `start()` is called: the page
 * shows its loader until then. `onStage('reveal')` fires as the colour wipe begins, which is
 * the cue for the heading to animate in; `done` means the intro is over and the page may scroll.
 */
export async function createHero(
  canvas: HTMLCanvasElement,
  opts: { onProgress: (p: number) => void; onStage: (s: HeroStage) => void; scroll: { smooth: number } },
) {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
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
    uDeep: tc('#4a8a36', '#0f3038'), // sunlit
    uMid: tc('#86b146', '#17454a'),
    uSun: tc('#cfd468', '#2a6a5c'),
    uShadeA: tc('#113121', '#050f16'), // in shade
    uShadeB: tc('#1a432b', '#08181d'),
    uAir: tc('#a9c9c4', '#101a33'),
    uGlow: tc('#000000', '#1f7a3c'),
    uTip: tc('#f0e392', '#3f8f7c'),
    uDry: tc('#cbbf7c', '#2f5f5a'),
    uShadow: { value: null as THREE.Texture | null },
    uShadowMat: { value: new THREE.Matrix4() },
    uShadowMix: { value: 0 },
  }
  const wind = { uTime, uShake, uPointer }

  // ---- lights (toon materials only): low warm sun from the left, cool fill ----
  const sunColor = tc('#ffe0ad', '#8fa8ff')
  const ambColor = tc('#e6e4ee', '#5568c8')
  const sun = new THREE.DirectionalLight()
  sun.position.copy(SUN)
  const amb = new THREE.AmbientLight()
  const glow = new THREE.PointLight(0x4dff80, 0, 3, 2)
  glow.position.set(0, 1.1, 0.45)
  scene.add(sun, amb, glow)

  // Everything that is not part of the wireframe pass.
  const notInWire: Array<THREE.Object3D> = []

  // ---- sky: a thin strip above the ridges, with faint drifting smoke-like cloud ----
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTop: tc('#7fb6d6', '#060a1c'),
        uMid: tc('#a9d2df', '#0f1a40'),
        uLow: tc('#d3e8e4', '#2b2857'),
        uHorizon: tc('#f6e6cf', '#6a4372'),
        uCloud: tc('#f7f0e8', '#2a2f55'),
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
        uniform vec3 uTop, uMid, uLow, uHorizon, uCloud, uSunGlow;
        uniform float uNight, uTime;
        varying vec3 vDir;
        ${NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float e = d.y, az = atan(d.x, -d.z);
          vec3 c = mix(uHorizon, uLow, smoothstep(-0.04, 0.03, e));
          c = mix(c, uMid, smoothstep(0.02, 0.12, e));
          c = mix(c, uTop, smoothstep(0.1, 0.4, e));
          float sg = max(dot(d, normalize(vec3(-0.92, 0.04, -0.4))), 0.0);
          c += uSunGlow * (pow(sg, 3.0) * 0.6 + pow(sg, 40.0) * 0.6);

          vec2 cp = vec2(az * 5.0 - uTime * 0.012, e * 14.0);
          float f = vnoise(cp) * 0.5 + vnoise(cp * 2.1 + 4.0) * 0.3 + vnoise(cp * 4.3 + 9.0) * 0.2;
          c = mix(c, uCloud, smoothstep(0.42, 0.78, f) * smoothstep(-0.02, 0.05, e) * 0.6);

          vec2 sp = vec2(az, e) * 90.0, cell = floor(sp);
          float h = hash(cell);
          vec2 o = (vec2(hash(cell + 1.7), hash(cell + 9.2)) - 0.5) * 0.6;
          float star = step(0.93, h) * smoothstep(0.12, 0.0, length(fract(sp) - 0.5 - o));
          star *= 0.6 + 0.4 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
          c += star * uNight * smoothstep(-0.02, 0.1, e) * vec3(0.9, 0.95, 1.0);

          float m = distance(d, normalize(vec3(0.3, 0.075, -1.0)));
          c += uNight * (smoothstep(0.02, 0.017, m) * vec3(1.0, 0.96, 0.85) + exp(-m * 9.0) * 0.18 * vec3(0.6, 0.7, 1.0));

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
  const gltf = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync('/hero/scene.glb', (e) => opts.onProgress(0.8 * Math.min(1, e.loaded / (e.total || 190000))))
  opts.onProgress(0.85)
  const catPath = /<path d="([^"]+)"/.exec(catSvg)?.[1] ?? null
  const cypress = ['Cypress1', 'Cypress2'].map((name) => {
    const m = gltf.scene.getObjectByName(name) as THREE.Mesh
    m.removeFromParent()
    ;(m.material as THREE.Material).dispose()
    return m // keeps its own transform: mesh compression stores the vertices rescaled
  })

  // ---- the parts that float away, and the anchors that stay ----
  const nodeOf = (name: string) => gltf.scene.getObjectByName(name)!
  const portOf = (name: string): Port => {
    const o = nodeOf(name)
    const q = (o.userData.port as Array<number> | undefined) ?? [0, 0, 0]
    return { obj: o, offset: new THREE.Vector3(q[0], q[2], -q[1]) } // Blender is Z-up, the page is Y-up
  }
  type Floater = { obj: THREE.Object3D; home: THREE.Vector3; target: THREE.Vector3; spin: THREE.Vector3; phase: number }
  // Parts only drift up a few hundred pixels from where they sit: higher pieces rise more, and
  // each moves slightly sideways and towards the camera so the stack loosens instead of lifting as a block.
  const floaters: Array<Floater> = gltf.scene.children
    .filter((o) => o.name.startsWith('Float_'))
    .map((obj) => {
      const h = clamp01((obj.position.y - 0.8) / 1.5)
      const lift = 0.3 + 0.6 * h + rand() * 0.2
      return {
        obj,
        home: obj.position.clone(),
        target: obj.position.clone().add(new THREE.Vector3((rand() - 0.5) * 0.55 + obj.position.x * 0.1, lift, (rand() - 0.5) * 0.5)),
        spin: new THREE.Vector3((rand() - 0.5) * 0.35, (rand() - 0.5) * 0.7, (rand() - 0.5) * 0.35),
        phase: rand() * 6.28,
      }
    })
  const pcNode = nodeOf('Float_pc')
  const mugNode = nodeOf('Float_mug')
  const CAT_OFFSET = new THREE.Vector3(0, 1.1, -0.06).sub(pcNode.position) // the cat's screen, from the PC's centre
  const MUG_OFFSET = new THREE.Vector3(0.69, 0.86, 0.2).sub(mugNode.position) // the rim of the mug

  // ---- shadows: rendered once from the sun, then they are just a texture ----
  // Two channels by multiply-blending two passes: r is the shadow of everything, g the shadow of
  // the parts that stay (desk and the two ground monitors), so shadows fade as things float off.
  const shadowCam = new THREE.OrthographicCamera(-2.6, 2.6, 2.6, -2.6, 0.1, 40)
  shadowCam.position.copy(SUN).multiplyScalar(15).setY(SUN.y * 15 + 1)
  shadowCam.lookAt(0, 1, 0)
  shadowCam.updateMatrixWorld()
  const shadowRT = new THREE.WebGLRenderTarget(512, 512)
  const bake = new THREE.Scene().add(gltf.scene)
  const stamp = (r: number, g: number, b: number) =>
    new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace),
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
    })
  const stampAll = stamp(0, 1, 1)
  const stampStay = stamp(1, 0, 1)
  renderer.setClearColor(0xffffff)
  renderer.setRenderTarget(shadowRT)
  bake.overrideMaterial = stampAll
  renderer.render(bake, shadowCam)
  renderer.autoClear = false
  for (const f of floaters) f.obj.visible = false
  bake.overrideMaterial = stampStay
  renderer.render(bake, shadowCam)
  for (const f of floaters) f.obj.visible = true
  renderer.autoClear = true
  renderer.setRenderTarget(null)
  stampAll.dispose()
  stampStay.dispose()
  ground.uShadow.value = shadowRT.texture
  ground.uShadowMat.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse)

  // ---- desk + monitors: toon materials and inverted-hull outlines ----
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
  let drawCat: ((lx: number, ly: number, open: number) => void) | null = null
  let drawThemeIcon: ((dark: boolean) => void) | null = null
  let screenMat: THREE.MeshBasicMaterial | null = null
  const toon = new Map<string, THREE.Material>()
  const meshes: Array<THREE.Mesh> = []
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
  })
  for (const mesh of meshes) {
    const src = mesh.material as THREE.MeshStandardMaterial
    if (src.name === 'glass') {
      if (!screenMat) {
        const atlas = screenAtlas(catPath)
        drawCat = atlas.drawCat
        drawThemeIcon = atlas.drawThemeIcon
        screenMat = new THREE.MeshBasicMaterial({ map: atlas.tex })
      }
      mesh.material = screenMat
    } else if (src.name === 'led') {
      mesh.material = new THREE.MeshBasicMaterial({ color: 0x7dff8a })
    } else {
      if (!toon.has(src.name)) {
        const side = src.name === 'leaf' ? THREE.DoubleSide : THREE.FrontSide
        toon.set(src.name, new THREE.MeshToonMaterial({ color: src.color, gradientMap: gradient, side }))
      }
      mesh.material = toon.get(src.name)!
      // small parts read better without a line around each one
      if (!/^(key|bay|label|metal|coffee|cable|glassOff|deskGap|note|leaf|vine|pages|teal|orange)/.test(src.name)) {
        const outline = new THREE.Mesh(mesh.geometry, outlineMat)
        mesh.add(outline)
        notInWire.push(outline)
      }
    }
    src.dispose()
  }
  scene.add(gltf.scene)

  // ---- cypresses on the shoulders of the two hills ----
  const treeMat = new THREE.ShaderMaterial({
    vertexColors: true,
    uniforms: { uSunDir: { value: SUN }, uTreeLight: tc('#ffffff', '#2c3f73'), uAir: ground.uAir },
    vertexShader: /* glsl */ `
      uniform vec3 uSunDir, uTreeLight, uAir;
      varying vec3 vColor;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float l = smoothstep(-0.3, 0.8, dot(normalize(mat3(modelMatrix) * normal), uSunDir));
        vColor = mix(color.rgb * mix(0.5, 1.5, l) * uTreeLight, uAir, smoothstep(8.0, 48.0, -wp.z) * 0.55);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); \n#include <colorspace_fragment>\n }`,
  })
  // x, z, scale, model
  for (const [x, z, s, kind] of [
    [-12.5, -14, 0.52, 0], [-5.5, -16.5, 0.5, 1], [-3.2, -13.5, 0.5, 0], // hill A
    [7.5, -26.5, 0.62, 0], [11.5, -25.5, 0.6, 1], [14, -27.5, 0.55, 0], // hill B
    [2.5, -42, 0.7, 1], // far off, in the dip between them
  ]) {
    const model = cypress[kind].clone()
    model.material = treeMat
    const tree = new THREE.Group().add(model)
    tree.position.set(x, hill(x, z) - 0.05, z)
    tree.rotation.y = rand() * 6.28
    tree.scale.setScalar(s)
    scene.add(tree)
  }

  // ---- ground: the soil seen between the blades ----
  const groundGeo = new THREE.PlaneGeometry(90, 74, 110, 90).rotateX(-Math.PI / 2).translate(0, 0, -25)
  const gp = groundGeo.attributes.position
  for (let i = 0; i < gp.count; i++) gp.setY(i, hill(gp.getX(i), gp.getZ(i)))
  groundGeo.computeVertexNormals()
  scene.add(
    new THREE.Mesh(
      groundGeo,
      new THREE.ShaderMaterial({
        uniforms: { ...ground, uSunDir: { value: SUN } },
        vertexShader: /* glsl */ `
          uniform vec3 uSunDir;
          varying vec3 vW;
          varying float vLit;
          void main() {
            vW = position;
            vLit = dot(normal, uSunDir);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          ${NOISE}${POOL}${SHADOW}${GROUND}
          varying vec3 vW;
          varying float vLit;
          void main() {
            vec3 c = groundColor(vW, smoothstep(0.1, 0.6, vLit), pool(vW.xz), shadowAt(vW));
            // dark between the blades close up; further off the tufts thin out, so match their tone
            c *= mix(0.42, 0.8, smoothstep(6.0, 22.0, length(vW.xz))) + 0.18 * vnoise(vW.xz * 26.0);
            gl_FragColor = vec4(air(c, vW), 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    ),
  )

  // ---- grass and flowers: one instanced draw call each ----
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
  // A point inside the wedge the cameras can see, between two depths. `patch` is the
  // size of the clumps it grows in: noise decides where the meadow is thick or thin.
  const spot = (z0: number, z1: number, patch: number) => {
    for (;;) {
      const z = lerp(z0, z1, rand())
      const x = (rand() * 2 - 1) * Math.min(1.5 + (10.5 - z) * 0.68, 38)
      if (rand() < 0.25 + 0.75 * noise2(x * patch + 40, z * patch)) return [x, hill(x, z), z] as const
    }
  }

  // Flowers first: each one also gets a stem, which is just another blade in the grass.
  const kinds = [
    { color: new THREE.Color('#fffaf0'), petals: 12 }, // daisy
    { color: new THREE.Color('#f29ac0'), petals: 8 },
    { color: new THREE.Color('#e5532d'), petals: 6 }, // poppy, echoing the desk
    { color: new THREE.Color('#b99be6'), petals: 5 },
  ]
  const blooms = Array.from({ length: desktop ? 6000 : 2000 }, () => {
    const [x, y, z] = spot(6.5, -22, 0.3)
    const far = 1 + Math.max(0, -z - 4) / 12 // grow with distance so they stay visible
    return { x, y, z, rnd: rand(), size: (0.03 + rand() * 0.03) * far, stem: (0.08 + rand() * 0.1) * far, kind: kinds[rand() < 0.45 ? 0 : 1 + Math.floor(rand() * 3)] }
  })

  // Bands of blades: thin and dense near the desk, then wider and sparser, then tufts on
  // the hills, so the cover stays even while the count falls with distance.
  const coarse = desktop ? 1 : 1.7
  const bands = [
    { count: desktop ? 110000 : 30000, z0: 6.5, z1: -6, wide: 1, tall: 1 },
    { count: desktop ? 50000 : 14000, z0: -6, z1: -14, wide: 1.6, tall: 1.2 },
    { count: desktop ? 45000 : 12000, z0: -14, z1: -23, wide: 2.8, tall: 1.6 },
    { count: desktop ? 35000 : 9000, z0: -23, z1: -44, wide: 4.5, tall: 2.3 },
  ]
  const blade = new THREE.BufferGeometry()
  blade.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.4, 0.33, 0, 0.4, 0.33, 0, -0.25, 0.66, 0, 0.25, 0.66, 0, 0, 1, 0], 3))
  blade.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6])
  const grass = new THREE.Mesh(
    instanced(blade, blooms.length + bands.reduce((n, b) => n + b.count, 0), (i, a, b, c) => {
      if (i < blooms.length) {
        const f = blooms[i]
        a.set([f.x, f.y, f.z], i * 3)
        b.set([f.stem, rand() * Math.PI, f.rnd, 0.006], i * 4)
        c.set([0, 0, slopeLit(f.x, f.z)], i * 3) // straight and green
        return
      }
      let n = i - blooms.length
      const band = bands.find((bd) => (n -= bd.count) < 0)!
      const [x, y, z] = spot(band.z0, band.z1, 0.9)
      const seed = band === bands[0] && rand() < 0.03 // a few tall seed stalks
      const height = (0.06 + rand() * 0.1) * band.tall * (0.7 + 0.6 * noise2(x * 0.5 + 9, z * 0.5)) * (seed ? 2.2 : 1)
      a.set([x, y, z], i * 3)
      b.set([height, rand() * Math.PI, rand(), (0.009 + rand() * 0.009) * band.wide * coarse * (seed ? 0.6 : 1)], i * 4)
      // dryness, how far the blade arcs over, slope light
      c.set([seed ? 1 : rand() < 0.14 ? 0.5 + rand() * 0.5 : rand() * 0.15, 0.15 + rand() * 0.5, slopeLit(x, z)], i * 3)
    }),
    new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { ...ground, ...wind, uSunDir: { value: SUN } },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset, aColor; // aColor: dryness, arc, slope light
        attribute vec4 aData;           // height, yaw, random, width
        uniform vec3 uSunDir;
        varying vec3 vColor;
        ${NOISE}${POOL}${SHADOW}${GROUND}${WIND}
        void main() {
          float h = position.y, c = cos(aData.y), s = sin(aData.y);
          // a blade that arcs over as it rises
          vec3 p = vec3(position.x * aData.w, h * aData.x * (1.0 - 0.18 * aColor.y * h), h * h * aData.x * aColor.y);
          p = vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
          vec2 sw = sway(aOffset, aData.z) * h * h * aData.x;
          p.xz += sw;
          p.y -= length(sw) * 0.3;

          float pl = pool(aOffset.xz), sh = shadowAt(aOffset);
          vec3 g = groundColor(aOffset, aColor.z, pl, sh);
          vec3 col = g * mix(0.4, 1.0, smoothstep(0.0, 0.75, h));              // roots sit in the blades' own shade
          col = mix(col, uDry * dot(g, vec3(1.2)), aColor.x * (0.25 + 0.6 * h)); // dry blades and seed heads
          col = mix(col, mix(g * 1.5, uTip, pl * sh), h * h * 0.45);           // tips catch the light
          col *= 0.82 + 0.36 * abs(dot(vec3(s, 0.0, c), uSunDir));             // face-on to the sun is brighter than edge-on
          vColor = air(col * (0.9 + 0.2 * aData.z), aOffset);
          gl_Position = projectionMatrix * viewMatrix * vec4(aOffset + p, 1.0);
        }`,
      fragmentShader: `varying vec3 vColor; void main() { gl_FragColor = vec4(vColor, 1.0); \n#include <colorspace_fragment>\n }`,
    }),
  )

  const flowers = new THREE.Mesh(
    instanced(new THREE.PlaneGeometry(1, 1), blooms.length, (i, a, b, c) => {
      const f = blooms[i]
      a.set([f.x, f.y, f.z], i * 3)
      b.set([f.size, f.rnd, f.kind.petals, f.stem], i * 4)
      f.kind.color.toArray(c, i * 3)
    }),
    new THREE.ShaderMaterial({
      uniforms: { ...wind, uShadow: ground.uShadow, uShadowMat: ground.uShadowMat, uShadowMix: ground.uShadowMix, uAir: ground.uAir, uFlowerTint: tc('#ffffff', '#7f8fd0'), uCenter: { value: new THREE.Color('#f2b632') } },
      vertexShader: /* glsl */ `
        attribute vec3 aOffset, aColor;
        attribute vec4 aData; // size, random, petals, stem height
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec4 vShape;
        ${NOISE}${POOL}${SHADOW}${WIND}
        void main() {
          vec3 base = aOffset + vec3(0.0, aData.w, 0.0);
          base.xz += sway(aOffset, aData.y) * aData.w;
          vec4 mv = viewMatrix * vec4(base, 1.0);
          // billboard, squashed vertically so the bloom reads as tilted up towards the sky
          mv.xy += position.xy * aData.x * vec2(1.0, 0.5 + 0.35 * aData.y);
          vUv = position.xy * 2.0;
          vColor = aColor;
          float light = mix(0.38, 1.0, pool(aOffset.xz)) * mix(0.6, 1.0, shadowAt(aOffset));
          vShape = vec4(aData.z, aData.y, light, smoothstep(8.0, 48.0, -aOffset.z) * 0.55);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFlowerTint, uCenter, uAir;
        varying vec3 vColor;
        varying vec2 vUv;
        varying vec4 vShape; // petals, random, light, haze
        void main() {
          float r = length(vUv);
          float petal = pow(abs(cos(atan(vUv.y, vUv.x) * vShape.x * 0.5 + vShape.y * 6.28)), 0.7);
          if (r > mix(0.4, 1.0, petal)) discard;
          vec3 c = r < 0.26
            ? uCenter * mix(1.0, 0.72, smoothstep(0.1, 0.26, r))
            : vColor * mix(0.78, 1.0, smoothstep(0.26, 0.9, r)) * mix(0.9, 1.0, petal);
          gl_FragColor = vec4(mix(c * uFlowerTint * vShape.z, uAir, vShape.w), 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  )

  // ---- steam off the coffee: one billboard with a scrolling-noise wisp ----
  const uMug = { value: new THREE.Vector3(0.69, 0.86, 0.2) }
  const steam = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime, uColor: tc('#ffffff', '#9fb0e0'), uMug },
      vertexShader: /* glsl */ `
        uniform vec3 uMug;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mv = viewMatrix * vec4(uMug, 1.0); // rim of the mug
          mv.xy += (position.xy + vec2(0.0, 0.5)) * vec2(0.14, 0.34);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        ${NOISE}
        void main() {
          float n = vnoise(vec2(vUv.x * 3.0, vUv.y * 2.2 - uTime * 0.45));
          float x = vUv.x - 0.5 + (n - 0.5) * 0.45 * vUv.y + sin(vUv.y * 5.0 + uTime * 0.8) * 0.08 * vUv.y;
          float a = smoothstep(0.16 + 0.1 * vUv.y, 0.0, abs(x)) * smoothstep(0.0, 0.12, vUv.y)
                  * (1.0 - smoothstep(0.35, 1.0, vUv.y)) * (0.35 + 0.65 * n);
          gl_FragColor = vec4(uColor, a * 0.5);
          #include <colorspace_fragment>
        }`,
    }),
  )
  for (const m of [grass, flowers, steam]) {
    m.frustumCulled = false
    scene.add(m)
    notInWire.push(m)
  }

  // ---- wires between the parts, long enough to stay joined all the way up ----
  const dist = (n: string) => (floaters.find((f) => f.obj.name === n)?.target ?? nodeOf(n).position)
  const wire = (a: string, b: string, radius: number, color = '#2b2c30') => ({
    a: portOf(a), b: portOf(b), radius, color, finalDistance: dist(a).distanceTo(dist(b)),
  })
  const cables = createCables(
    [
      // thick trunks from the two ground monitors up to the main machines
      wire('Ground_R', 'Float_pc', 0.026), wire('Ground_L', 'Float_big', 0.019), wire('Ground_R', 'Float_term', 0.02),
      wire('Ground_L', 'Float_studio', 0.011), wire('Ground_R', 'Float_tv', 0.012, '#cbc2ab'), wire('Ground_L', 'Float_keyboard', 0.006),
      // between the monitors
      wire('Float_pc', 'Float_top', 0.012), wire('Float_pc', 'Float_big', 0.015), wire('Float_pc', 'Float_mac', 0.009, '#3fb7a5'),
      wire('Float_pc', 'Float_term', 0.008), wire('Float_big', 'Float_studio', 0.007), wire('Float_studio', 'Float_top', 0.005),
      wire('Float_mac', 'Float_top', 0.005, '#cbc2ab'), wire('Float_term', 'Float_tv', 0.006),
      // thin ones for the keyboard, mouse and headphones
      wire('Float_keyboard', 'Float_pc', 0.004), wire('Float_mouse', 'Float_keyboard', 0.003), wire('Float_headphones', 'Float_pc', 0.0035, '#e8823c'),
    ],
    { light: tc('#ffffff', '#7f8fd0'), sun: SUN, res: uRes },
  )
  for (const m of cables.meshes) {
    scene.add(m)
    notInWire.push(m)
  }

  // ---- heading, hung in the scene (not on the page) so the hills can hide it ----
  try {
    await Promise.all([document.fonts.load('600 200px "Inter Tight"'), document.fonts.load('500 62px "Inter Tight"')])
  } catch {
    // the fallback system font is used instead
  }
  const TH1 = 200 // design sizes, in canvas pixels; the plane is scaled to the page's text size
  const TH2 = 62
  const TGAP = 50
  const TPAD = 30
  const titleCanvas = document.createElement('canvas')
  const tg = titleCanvas.getContext('2d')!
  const font = (weight: number, px: number) => `${weight} ${px}px "Inter Tight", ui-sans-serif, system-ui, sans-serif`
  tg.font = font(600, TH1)
  tg.letterSpacing = `${-0.025 * TH1}px`
  const w1 = tg.measureText('GlitchNobody').width
  tg.font = font(500, TH2)
  tg.letterSpacing = `${-0.011 * TH2}px`
  const w2 = tg.measureText('aka Siddhant Vij').width
  titleCanvas.width = Math.ceil(Math.max(w1, w2)) + 2 * TPAD // resizing resets the context
  titleCanvas.height = 2 * TPAD + TH1 + TGAP + TH2
  tg.fillStyle = '#fff'
  tg.textAlign = 'center'
  tg.textBaseline = 'middle'
  tg.font = font(600, TH1)
  tg.letterSpacing = `${-0.025 * TH1}px`
  tg.fillText('GlitchNobody', titleCanvas.width / 2, TPAD + TH1 * 0.52)
  tg.font = font(500, TH2)
  tg.letterSpacing = `${-0.011 * TH2}px`
  tg.fillText('aka Siddhant Vij', titleCanvas.width / 2, TPAD + TH1 + TGAP + TH2 * 0.52)
  const titleTex = new THREE.CanvasTexture(titleCanvas)
  const uAnim = { value: new THREE.Vector4(1, 0, 1, 0) } // heading position/opacity, subtitle position/opacity
  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      uniforms: {
        map: { value: titleTex },
        uInk: tc('#171717', '#ededed'),
        uBlue: { value: new THREE.Color('#498fff') },
        uCoral: { value: new THREE.Color('#ff7a7a') },
        uAmber: { value: new THREE.Color('#ffbc74') },
        uAnim,
        uSplit: { value: 1 - (TPAD + TH1 + TGAP / 2) / titleCanvas.height },
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      // the same gradient as auctervia.tech: ink, then a blue / coral / amber edge, then a faint ghost
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uInk, uBlue, uCoral, uAmber;
        uniform vec4 uAnim;
        uniform float uSplit;
        varying vec2 vUv;
        void main() {
          bool head = vUv.y > uSplit;
          float pos = head ? uAnim.x : uAnim.z;
          float op = head ? uAnim.y : uAnim.w;
          float u = (vUv.x + 1.5 * pos) / 2.5; // a 250% wide gradient sliding across
          vec3 col = mix(uInk, uBlue, smoothstep(0.40, 0.45, u));
          col = mix(col, uCoral, smoothstep(0.45, 0.50, u));
          col = mix(col, uAmber, smoothstep(0.50, 0.55, u));
          col = mix(col, uInk, smoothstep(0.55, 0.60, u));
          float ghost = mix(1.0, 0.2, smoothstep(0.55, 0.60, u));
          float cover = texture2D(map, vUv).r * ghost * op;
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
          gl_FragColor = vec4(gl_FragColor.rgb * cover, cover); // premultiplied
        }`,
    }),
  )
  title.frustumCulled = false
  title.position.z = TITLE_Z
  scene.add(title)
  notInWire.push(title)
  let titleHome = 11

  // ---- theme ----
  const wantNight = () => {
    const t = root.dataset.theme
    return t === 'dark' ? 1 : 0
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
    drawThemeIcon?.(night > 0.5)
  }
  applyTheme()

  // ---- state ----
  let t = still ? ZOOM_END : 0 // intro clock; it only runs once start() is called
  let started = false
  let revealed = false
  let finished = false
  let revealAt = 0
  let dirty = true // reduced motion renders on demand only
  let visible = true
  let comp: ReturnType<typeof createComposite> | null = still
    ? null
    : createComposite(renderer, scene, camera, notInWire, uBg, uLine)

  let themeWipe: ReturnType<typeof createComposite> | null = null
  let wipeAt = 0
  let relayout: (() => void) | null = null
  const size = new THREE.Vector2()
  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    renderer.setPixelRatio(Math.min(devicePixelRatio, desktop ? 2 : 1.5))
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // slide the picture down so the title has sky to sit on
    camera.setViewOffset(w, h, 0, -Math.round(h * (w < h ? 0.08 : 0.07)), w, h)
    renderer.getDrawingBufferSize(size)
    uRes.value.copy(size)
    comp?.setSize(size.x, size.y)
    themeWipe?.setSize(size.x, size.y)
    relayout?.()
    dirty = true
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()
  const viewObserver = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
  viewObserver.observe(canvas)

  const themeObserver = new MutationObserver(() => (dirty = true))
  themeObserver.observe(root, { attributes: true, attributeFilter: ['data-theme'] })

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

  // ---- the TV is the colour-mode switch ----
  const tv = nodeOf('Float_tv')
  const caster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const onTv = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2)
    caster.setFromCamera(ndc, camera)
    return caster.intersectObject(tv, true).length > 0
  }
  const onClick = (e: MouseEvent) => {
    if (started && onTv(e)) toggleTheme()
  }
  const onHover = (e: PointerEvent) => {
    canvas.style.cursor = started && onTv(e) ? 'pointer' : ''
  }
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('pointermove', onHover)

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

  const catHead = new THREE.Vector3(0, 1.1, -0.06) // centre of the cat's screen
  const look = new THREE.Vector2()
  const aim = new THREE.Vector2()
  let lastLook = new THREE.Vector3(9, 9, 9)
  let nextBlink = 2 + rand() * 3
  const blinkLen = 0.2

  /** Put the heading where the page's text used to sit, as seen from the end of the intro. */
  const tmpCam = new THREE.PerspectiveCamera()
  const layoutTitle = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    tmpCam.copy(camera)
    tmpCam.position.copy(fit(CLOSE, a))
    tmpCam.lookAt(CLOSE.tgt)
    tmpCam.updateMatrixWorld()
    const scale = Math.min(72, Math.max(36, w * 0.06)) / TH1
    const pxW = titleCanvas.width * scale
    const pxH = titleCanvas.height * scale
    const top = Math.min(150, Math.max(80, h * 0.135)) - TPAD * scale // low enough that the tree tops overlap it a little
    const ndcY = 1 - (2 * (top + pxH / 2)) / h
    const dir = new THREE.Vector3(0, ndcY, 0.5).unproject(tmpCam).sub(tmpCam.position).normalize()
    const hit = tmpCam.position.clone().addScaledVector(dir, (TITLE_Z - tmpCam.position.z) / dir.z)
    const perPx = (2 * (tmpCam.position.z - TITLE_Z) * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / h
    title.scale.set(pxW * perPx, pxH * perPx, 1)
    title.position.x = hit.x
    titleHome = hit.y
  }
  layoutTitle()
  relayout = layoutTitle

  let warm = 6 // reduced motion draws on demand: draw the first few frames so every texture has settled
  let raf = 0
  let last = performance.now()
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!visible) return

    // A theme switch after the intro plays the same depth colorama wipe, from a still of the
    // old theme to the new one; during the intro (or with reduced motion) it simply cuts over.
    const target = wantNight()
    if (target !== night) {
      if (!still && !comp && started) {
        themeWipe?.dispose()
        themeWipe = createComposite(renderer, scene, camera, notInWire, uBg, uLine)
        themeWipe.snapshot()
        wipeAt = uTime.value
      }
      night = target
      applyTheme()
      dirty = true
    }
    // On touch screens the scene holds still once the page scrolls (it only shrinks into the card),
    // so stop drawing it then: scrolling stays smooth on phones. A theme wipe still plays.
    const parked = !desktop && finished && window.scrollY > 0 && !themeWipe
    if ((still || parked) && !dirty && warm <= 0) return
    dirty = false
    warm--

    if (!still) {
      if (started) t += dt
      uTime.value += dt
    }
    if (started && !revealed && t >= TITLE_AT) {
      revealed = true
      revealAt = uTime.value
      opts.onStage('reveal')
    }
    if (started && !finished && t >= ZOOM_END) {
      finished = true
      opts.onStage('done')
    }

    // scrolling: the camera climbs, the heading sinks behind the hills, the parts float away
    const sRaw = clamp01(still || !desktop ? 0 : opts.scroll.smooth)
    const s = sRaw * sRaw * (3 - 2 * sRaw)
    ground.uShadowMix.value = s
    const time = uTime.value
    for (const f of floaters) {
      const l = s // everything moves together with the camera
      f.obj.position.lerpVectors(f.home, f.target, l)
      f.obj.position.y += Math.sin(time * 0.7 + f.phase) * 0.1 * l
      f.obj.rotation.set(f.spin.x * l + Math.sin(time * 0.5 + f.phase) * 0.06 * l, f.spin.y * l, f.spin.z * l)
    }
    cables.update(s)
    uMug.value.copy(MUG_OFFSET).applyQuaternion(mugNode.quaternion).add(mugNode.position)
    catHead.copy(CAT_OFFSET).applyQuaternion(pcNode.quaternion).add(pcNode.position)

    const since = revealed ? time - revealAt : -1
    const hp = revealEase((since) / 1.2)
    const sp = revealEase((since - 0.18) / 1.2)
    uAnim.value.set(1 - hp, since < 0 ? 0 : revealEase(since / 1.2 / 0.15), 1 - sp, since < 0.18 ? 0 : revealEase((since - 0.18) / 1.2 / 0.15))
    // sinks well below the dip between the hills, and fades too, so no sliver shows on any screen
    const sink = smooth(0.04, 0.38, s) // gone just before the card starts forming (CARD_AT in index.tsx)
    title.position.y = lerp(titleHome, -4, sink)
    uAnim.value.y *= 1 - sink
    uAnim.value.w *= 1 - sink

    // camera: intro zoom, then pointer parallax around the target
    const k = zoom(t)
    pos.lerpVectors(fit(WIDE, a), fit(CLOSE, b), k)
    tgt.lerpVectors(WIDE.tgt, CLOSE.tgt, k)
    if (s > 0) {
      const u = 1 - s
      const mid = fit(SKY_MID, a)
      const end = fit(SKY, b)
      pos.multiplyScalar(u * u).addScaledVector(mid, 2 * u * s).addScaledVector(end, s * s)
      tgt.multiplyScalar(u * u).addScaledVector(SKY_MID.tgt, 2 * u * s).addScaledVector(SKY.tgt, s * s)
    }
    const active = hovering && t > ZOOM_END
    parallax.lerp(active ? pointer : pointer.set(0, 0), 1 - Math.exp(-dt * 4))
    camera.position.copy(pos)
    camera.lookAt(tgt)
    camera.translateX(parallax.x * lerp(0.9, 0.45, k))
    camera.translateY(parallax.y * lerp(0.4, 0.2, k))
    camera.lookAt(tgt)
    uOutlinePx.value = lerp(0.8, 1.2, k) * renderer.getPixelRatio()

    // the cat watches the cursor (or wanders on touch screens) and blinks now and then
    if (drawCat && !still) {
      if (hovering) {
        const c = catHead.clone().project(camera)
        const dx = (pointer.x - c.x) * camera.aspect
        const dy = pointer.y - c.y
        const len = Math.hypot(dx, dy) || 1
        const m = Math.min(1, len / 0.7) / len
        aim.set(dx * m, -dy * m)
      } else {
        aim.set(Math.sin(uTime.value * 0.6) * 0.5, Math.sin(uTime.value * 0.4) * 0.2)
      }
      look.lerp(aim, 1 - Math.exp(-dt * 8))
      if (uTime.value > nextBlink + blinkLen) nextBlink = uTime.value + 2.5 + rand() * 4
      const p = (uTime.value - nextBlink) / blinkLen
      const open = p > 0 && p < 1 ? Math.abs(2 * p - 1) : 1
      const changed = Math.abs(look.x - lastLook.x) + Math.abs(look.y - lastLook.y) + Math.abs(open - lastLook.z)
      if (changed > 0.01) {
        drawCat(look.x, look.y, open)
        lastLook.set(look.x, look.y, open)
      }
    }

    // where the cursor ray meets the hill
    let hit = false
    if (active && s < 0.15) {
      camera.updateMatrixWorld()
      ray.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(camera.position).normalize()
      if (ray.y < -0.01) {
        let y = 0
        for (let i = 0; i < 5; i++) {
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
    const wipe = themeWipe ? (uTime.value - wipeAt) / 1.6 : 1
    if (themeWipe && wipe >= 1) {
      themeWipe.dispose()
      themeWipe = null
    }
    if (comp) comp.render(t)
    else if (themeWipe) themeWipe.renderWipe(smooth(0, 1, wipe), uTime.value)
    else renderer.render(scene, camera)
  }
  raf = requestAnimationFrame(frame)
  opts.onProgress(1)

  const start = () => {
    started = true
    opts.onStage('wire')
    if (still) {
      // nothing animates: the heading simply appears, and the page is free to scroll
      revealed = true
      revealAt = -99
      finished = true
      opts.onStage('reveal')
      opts.onStage('done')
    }
    dirty = true
  }

  /** The loader's count once the wireframe shows: 75 → 100, done just before the colour wipe starts. */
  const count = () => 75 + 25 * Math.min(1, t / (REVEAL_START - 0.15))

  return { start, count, dispose: () => {
    cancelAnimationFrame(raf)
    resizeObserver.disconnect()
    viewObserver.disconnect()
    themeObserver.disconnect()
    window.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('click', onClick)
    canvas.removeEventListener('pointermove', onHover)
    root.removeEventListener('pointerleave', onLeave)
    comp?.dispose()
    themeWipe?.dispose()
    cables.dispose()
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
    shadowRT.dispose()
    renderer.dispose()
  } }
}
