import { Application, Assets, Color, Texture } from 'pixi.js'
import {
  BatchedMesh3D,
  FlatMaterial,
  Geometry3D,
  Matrix4,
  Mesh3D,
  Model3D,
  PlaneGeometry,
  RenderPassBit,
  SphereGeometry,
  View3D,
  getAttributeData,
} from '@pixi/3d'
import type { BaseMaterial3D, Container3D, Scene3DSource, ShaderBit } from '@pixi/3d'
import { toggleTheme } from '../theme'
import catSvg from './cat.svg?raw' // the favicon artwork; its silhouette is drawn on the PC's screen
import { createCables } from './cables'
import type { Port } from './cables'
import { HELPERS, REVEAL_END, REVEAL_START, TITLE_AT, ZOOM_END, reveal, revealBit, wireFade, wireMaterial, zoom } from './intro'

type V3 = [number, number, number]
const FOV = 35
// Camera poses, looking down into the valley so the frame is mostly ground.
// `need` is the scene width (m) that must stay in frame on narrow screens.
const WIDE = { pos: [0, 3.7, 12.6] as V3, tgt: [0, 1.1, 0] as V3, need: 3.4 }
const CLOSE = { pos: [0, 2.6, 6.9] as V3, tgt: [0, 1.15, 0] as V3, need: 2.9 }
// Scrolling carries the camera from CLOSE, through SKY_MID, to SKY: it lowers a little while tilting
// up to follow the monitors as they float.
const SKY_MID = { pos: [0, 2.4, 7.0] as V3, tgt: [0, 1.5, 0] as V3, need: 3.4 }
const SKY = { pos: [0, 2.15, 7.0] as V3, tgt: [0, 1.9, 0] as V3, need: 3.6 }
const TITLE_Z = -34 // the heading hangs here, behind both hills

const tanHalf = Math.tan((FOV * Math.PI) / 360)

const norm = (v: V3): V3 => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}
// Low sun, from the left and a little in front.
const SUN = norm([-5, 2.8, 3.4])

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
/** A point through a 4x4 column-major matrix (pixi's Matrix4 elements). */
const xform = (m: ArrayLike<number>, x: number, y: number, z: number): V3 => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
]

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
  return smooth(0.1, 0.6, (nx * SUN[0] + 2 * e * SUN[1] + nz * SUN[2]) / Math.hypot(nx, 2 * e, nz))
}
/** f sampled on a grid once, then read bilinearly: for terrain values asked for per grass blade. */
function gridded(f: (x: number, z: number) => number, x0: number, x1: number, z0: number, z1: number, step: number) {
  const nx = Math.ceil((x1 - x0) / step) + 1
  const nz = Math.ceil((z1 - z0) / step) + 1
  const v = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = f(x0 + i * step, z0 + j * step)
  return (x: number, z: number) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (x - x0) / step))
    const fz = Math.min(nz - 1.001, Math.max(0, (z - z0) / step))
    const i = Math.floor(fx)
    const j = Math.floor(fz)
    const k = j * nx + i
    return lerp(lerp(v[k], v[k + 1], fx - i), lerp(v[k + nx], v[k + nx + 1], fx - i), fz - j)
  }
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

// ---- shader pieces ----
// Colours reach the shaders as authored (sRGB) and are linearised there with hzL(); results go out
// through hzOut(), which works whatever colour space pixi runs the material in.
const v3 = 'vec3<f32>' as const
const f1 = 'f32' as const
const GROUND_FIELDS = { uDeep: v3, uMid: v3, uSun: v3, uShadeA: v3, uShadeB: v3, uAir: v3, uGlow: v3, uTip: v3, uDry: v3, uShadowMix: f1, uShRect: 'vec4<f32>' as const }
const GROUND_ARGS = 'hzL(material.uDeep), hzL(material.uMid), hzL(material.uSun), hzL(material.uShadeA), hzL(material.uShadeB), hzL(material.uGlow)'
const WIND_FIELDS = { uT: f1, uShake: f1, uPointer: v3 }
const WIND_ARGS = 'material.uT, material.uShake, material.uPointer'
// 1 = open, 0 = in the shadow of the desk and monitors (baked once, see bakeShadow)
const shadowAt = (wp: string) =>
  `hzShadow(sampleShadowDirect(hzShadowUV(${wp}.xz, material.uShRect)).rg, material.uShadowMix)`

/** A material bit; `gl` holds the GLSL code for each slot. WebGL only (see the app's `preference`). */
const bit = (name: string, b: Omit<ShaderBit, 'name'>): ShaderBit => ({
  name,
  requires: [HELPERS],
  ...b,
})

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

  const tex = Texture.from(c)
  // no mipmaps (they would bleed one cell into the next), crisp pixels up close
  tex.source.style.magFilter = 'nearest'
  tex.source.style.update()
  const changed = () => tex.source.update()

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
    changed()
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
    changed()
  }
  drawThemeIcon(document.documentElement.dataset.theme === 'dark')

  return { tex, drawCat, drawThemeIcon }
}

/** World-space triangles of every mesh under a node. */
function trianglesOf(root: Container3D, each: (a: V3, b: V3, c: V3, mesh: Mesh3D) => void) {
  root.traverse((o) => {
    if (!(o instanceof Mesh3D) || !o.geometry) return
    const p = getAttributeData(o.geometry, 'aPosition', 3)
    const m = o.getGlobalTransform().elements
    const w = (i: number) => xform(m, p[i * 3], p[i * 3 + 1], p[i * 3 + 2])
    const idx = o.geometry.indices
    const n = idx ? idx.length : p.length / 3
    for (let i = 0; i + 2 < n; i += 3) {
      each(w(idx ? idx[i] : i), w(idx ? idx[i + 1] : i + 1), w(idx ? idx[i + 2] : i + 2), o)
    }
  })
}

/**
 * The desk's shadow on the ground, drawn once on a canvas by flattening every triangle along the
 * sun's direction. r: shadow of everything, g: shadow of the parts that stay, so shadows fade as
 * things float off. `rect` is the ground area it covers (x0, z0, width, depth).
 */
function bakeShadow(model: Container3D, stays: (m: Mesh3D) => boolean) {
  const S = 512
  const rect = [-3, -5, 8, 8] as const
  const draw = (keep: (m: Mesh3D) => boolean) => {
    const c = document.createElement('canvas')
    c.width = c.height = S
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, S, S)
    g.fillStyle = '#000'
    // one short path per batch: a single path of every triangle gets slow to build and fill
    let n = 0
    g.beginPath()
    for (const t of flat) {
      if (!keep(t.mesh)) continue
      g.moveTo(t.p[0], t.p[1]) // fill closes each triangle itself
      g.lineTo(t.p[2], t.p[3])
      g.lineTo(t.p[4], t.p[5])
      if (++n % 1000 === 0) {
        g.fill()
        g.beginPath()
      }
    }
    g.fill()
    return c
  }
  // flattened once along the sun's rays onto the ground, in canvas pixels, for both channels
  const at = (p: V3) => {
    const k = p[1] / SUN[1]
    return [((p[0] - SUN[0] * k - rect[0]) / rect[2]) * S, ((p[2] - SUN[2] * k - rect[1]) / rect[3]) * S]
  }
  const flat: Array<{ mesh: Mesh3D; p: number[] }> = []
  trianglesOf(model, (a, b, cc, mesh) => flat.push({ mesh, p: [...at(a), ...at(b), ...at(cc)] }))
  const all = draw(() => true)
  const stay = draw(stays)
  const out = document.createElement('canvas')
  out.width = out.height = S
  const g = out.getContext('2d')!
  // soften the edges, as the old shadow map's five taps did
  g.filter = 'blur(5px)'
  g.drawImage(all, 0, 0)
  const r = g.getImageData(0, 0, S, S)
  g.clearRect(0, 0, S, S)
  g.drawImage(stay, 0, 0)
  const s = g.getImageData(0, 0, S, S)
  for (let i = 0; i < r.data.length; i += 4) {
    r.data[i + 1] = s.data[i]
    r.data[i + 2] = 255
    r.data[i + 3] = 255
  }
  g.filter = 'none'
  g.putImageData(r, 0, 0)
  return { tex: Texture.from(out), rect: [rect[0], rect[1], 1 / rect[2], 1 / rect[3]] }
}

export type HeroStage = 'wire' | 'reveal' | 'done'

/**
 * Builds the scene and waits, drawing nothing visible, until `start()` is called: the page
 * shows its loader until then. `onStage('reveal')` fires as the colour wipe begins, which is
 * the cue for the heading to animate in; `done` means the intro is over and the page may scroll.
 */
export async function createHero(
  host: HTMLCanvasElement,
  opts: { onProgress: (p: number) => void; onStage: (s: HeroStage) => void; scroll: { smooth: number } },
) {
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const root = document.documentElement
  const rand = mulberry32(7)

  // Each scene draws on a canvas of its own, next to React's: StrictMode mounts twice on the same
  // element, and two pixi apps sharing one WebGL context corrupt each other's state.
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  host.after(canvas)
  host.style.display = 'none'

  const app = new Application()
  await app.init({
    canvas,
    preference: 'webgl', // the shader bits below are GLSL only
    antialias: true,
    autoStart: false, // drawn from our own loop, only when something changed
    backgroundAlpha: 0,
    powerPreference: 'high-performance',
    // the canvas only listens for the TV click below; pixi's events would block touch scrolling
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  })
  canvas.style.touchAction = ''
  const view = new View3D({ toneMapping: 'none', environment: null, autoResize: false })
  app.stage.addChild(view)
  const camera = view.camera
  camera.fov = FOV
  camera.near = 0.1
  camera.far = 200

  // ---- day/night colours: every themed material value lerps between its two colours ----
  type TC = { d: V3; n: V3 }
  const tc = (day: string, night: string): TC => ({ d: new Color(day).toArray().slice(0, 3) as V3, n: new Color(night).toArray().slice(0, 3) as V3 })
  const rgb = (hex: string) => new Color(hex).toArray().slice(0, 3) as V3
  const themed: Array<{ mat: BaseMaterial3D; field: string; tc: TC }> = []
  // values every material shares, rewritten each frame
  const shared = { uT: 0, uShake: 0, uPointer: [0, -100, 0] as V3, uShadowMix: 0, uReveal: still ? 1 : 0, uRes: [1, 1] as [number, number] }
  const live: Array<{ mat: BaseMaterial3D; keys: Array<keyof typeof shared> }> = []
  let night = 0
  /** Fill a material's values: theme pairs follow the colour mode, `shared` keys follow the frame. */
  const bind = <M extends BaseMaterial3D>(mat: M, data: Record<string, TC | number | number[]>, keys: Array<keyof typeof shared> = []) => {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'object' && 'd' in v) themed.push({ mat, field: k, tc: v })
      else mat.data[k] = v
    }
    if (keys.length) live.push({ mat, keys })
    return mat
  }

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
  }
  const reveals = { uBg } // every coloured material also takes part in the intro wipe
  const revealKeys: Array<keyof typeof shared> = ['uReveal']

  // ---- toon light for the desk and monitors: low warm sun from the left, cool fill ----
  // a toon shade, by hand: albedo * (sun * ramp(N.L) + ambient), with the ramp
  // (shade, then a soft step into full light) worked out instead of read from a texture
  const toonLight = {
    uSunCol: tc('#ffe0ad', '#8fa8ff'),
    uAmbCol: tc('#e6e4ee', '#5568c8'),
    uK: { d: [0.6, 0.56, 0], n: [0.2, 0.22, 0] } as TC, // sun and fill strength
  }
  const toonBit = bit('heroToon', {
    bindings: { material: { uSunCol: v3, uAmbCol: v3, uK: v3 } },
    gl: {
      fragment: {
        material: /* glsl */ `{
          float x = dot(normal, vec3(${SUN.join(', ')})) * 0.5 + 0.5; // 0 facing away from the sun, 1 facing it
          float ramp = 0.65 * smoothstep(0.42, 0.95, x) + 0.35 * smoothstep(0.52, 0.6, x);
          vec3 light = hzL(material.uSunCol) * material.uK.x * ramp + hzL(material.uAmbCol) * material.uK.y;
          albedo = hzOut(hzToLinear(albedo) * light);
        }`,
      },
    },
  })

  // Meshes drawn as lines during the intro.
  const wired: Array<Mesh3D> = []

  // ---- sky: a thin strip above the ridges, with faint drifting smoke-like cloud ----
  const sky = new Mesh3D({
    geometry: new SphereGeometry({ radius: 1, widthSegments: 24, heightSegments: 12 }),
    material: bind(
      new FlatMaterial({
        doubleSided: true,
        fog: false,
        extraBits: [
          bit('heroSky', {
            bindings: { material: { uTop: v3, uSkyMid: v3, uLow: v3, uHorizon: v3, uCloud: v3, uSunGlow: v3, uNight: f1, uT: f1 } },
            gl: {
              fragment: {
                material: /* glsl */ `{
                  vec3 d = normalize(vPosition - uCameraPosition);
                  float e = d.y, az = atan(d.x, -d.z), t = material.uT;
                  vec3 c = mix(hzL(material.uHorizon), hzL(material.uLow), smoothstep(-0.04, 0.03, e));
                  c = mix(c, hzL(material.uSkyMid), smoothstep(0.02, 0.12, e));
                  c = mix(c, hzL(material.uTop), smoothstep(0.1, 0.4, e));
                  float sg = max(dot(d, normalize(vec3(-0.92, 0.04, -0.4))), 0.0);
                  c += hzL(material.uSunGlow) * (pow(sg, 3.0) * 0.6 + pow(sg, 40.0) * 0.6);

                  float f = hzCloud(vec2(az * 5.0 - t * 0.012, e * 14.0));
                  c = mix(c, hzL(material.uCloud), smoothstep(0.42, 0.78, f) * smoothstep(-0.02, 0.05, e) * 0.6);

                  vec2 sp = vec2(az, e) * 90.0, cell = floor(sp);
                  float h = hzHash(cell);
                  vec2 o = (vec2(hzHash(cell + 1.7), hzHash(cell + 9.2)) - 0.5) * 0.6;
                  float star = step(0.93, h) * smoothstep(0.12, 0.0, length(fract(sp) - 0.5 - o));
                  star *= 0.6 + 0.4 * sin(t * (1.0 + h * 3.0) + h * 40.0);
                  c += star * material.uNight * smoothstep(-0.02, 0.1, e) * vec3(0.9, 0.95, 1.0);

                  float m = distance(d, normalize(vec3(0.3, 0.075, -1.0)));
                  c += material.uNight * (smoothstep(0.02, 0.017, m) * vec3(1.0, 0.96, 0.85) + exp(-m * 9.0) * 0.18 * vec3(0.6, 0.7, 1.0));
                  albedo = hzOut(c);
                }`,
              },
            },
          }),
          revealBit,
        ],
      }),
      {
        uTop: tc('#7fb6d6', '#060a1c'),
        uSkyMid: tc('#a9d2df', '#0f1a40'),
        uLow: tc('#d3e8e4', '#2b2857'),
        uHorizon: tc('#f6e6cf', '#6a4372'),
        uCloud: tc('#f7f0e8', '#2a2f55'),
        uSunGlow: tc('#ffd58a', '#000000'),
        uNight: 0,
        ...reveals,
      },
      ['uReveal', 'uT'],
    ),
    castShadow: false,
    receiveShadow: false,
  })
  sky.scale.set(150, 150, 150)
  view.root.addChild(sky)

  // ---- assets ----
  // The GLB is fetched once here for the progress count and the cable ports (node extras, which
  // the loader drops); the loader then reads it from the HTTP cache.
  const res = await fetch('/hero/scene.glb')
  const total = Number(res.headers.get('content-length')) || 260000
  const chunks: Array<Uint8Array> = []
  let got = 0
  for (const reader = res.body!.getReader(); ; ) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    opts.onProgress(0.8 * Math.min(1, got / total))
  }
  const glb = await new Blob(chunks as BlobPart[]).arrayBuffer()
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))))
  const ports = new Map<string, V3>()
  for (const n of json.nodes) if (n.extras?.port) ports.set(n.name, n.extras.port)
  const source = await Assets.load<Scene3DSource>('/hero/scene.glb')
  // the build below is synchronous; between its heavy steps, let the page paint so the loader
  // keeps counting instead of freezing
  const breathe = (p: number) => {
    opts.onProgress(p)
    return new Promise((r) => setTimeout(r, 0))
  }
  await breathe(0.85)
  const model = new Model3D({ source, castShadow: false, receiveShadow: false })
  view.root.addChild(model)
  const catPath = /<path d="([^"]+)"/.exec(catSvg)?.[1] ?? null
  const nodeOf = (name: string) => model.getChildByLabel(name, true) as Container3D
  const cypress = ['Cypress1', 'Cypress2'].map((name) => {
    const m = nodeOf(name)
    m.removeFromParent()
    return m
  })

  // ---- the parts that float away, and the anchors that stay ----
  const portOf = (name: string): Port => {
    const q = ports.get(name) ?? [0, 0, 0]
    return { obj: nodeOf(name), offset: [q[0], q[2], -q[1]] } // Blender is Z-up, the page is Y-up
  }
  type Floater = { obj: Container3D; home: V3; target: V3; spin: V3; phase: number }
  const floatNodes: Array<Container3D> = []
  model.traverse((o) => {
    if (o.label?.startsWith('Float_') && !(o.parent as Container3D | null)?.label?.startsWith('Float_')) floatNodes.push(o as Container3D)
  })
  // Parts only drift up a few hundred pixels from where they sit: higher pieces rise more, and
  // each moves slightly sideways and towards the camera so the stack loosens instead of lifting as a block.
  const floaters: Array<Floater> = floatNodes.map((obj) => {
      const p: V3 = [obj.position.x, obj.position.y, obj.position.z]
      const h = clamp01((p[1] - 0.8) / 1.5)
      const lift = 0.3 + 0.6 * h + rand() * 0.2
      return {
        obj,
        home: p,
        target: [p[0] + (rand() - 0.5) * 0.55 + p[0] * 0.1, p[1] + lift, p[2] + (rand() - 0.5) * 0.5],
        spin: [(rand() - 0.5) * 0.35, (rand() - 0.5) * 0.7, (rand() - 0.5) * 0.35],
        phase: rand() * 6.28,
      }
    })
  const floating = new Set<Container3D>(floaters.map((f) => f.obj))
  const isFloating = (o: Container3D | null): boolean => !!o && (floating.has(o) || isFloating(o.parent as Container3D | null))
  const pcNode = nodeOf('Float_pc')
  const mugNode = nodeOf('Float_mug')
  const CAT_OFFSET = sub([0, 1.1, -0.06], [pcNode.position.x, pcNode.position.y, pcNode.position.z]) // the cat's screen, from the PC's centre
  const MUG_OFFSET = sub([0.69, 0.86, 0.2], [mugNode.position.x, mugNode.position.y, mugNode.position.z]) // the rim of the mug
  const worldOf = (node: Container3D, o: V3) => xform(node.getGlobalTransform().elements, o[0], o[1], o[2])

  // ---- shadows: drawn once, then they are just a texture ----
  const shadow = bakeShadow(model, (m) => !isFloating(m))
  const shadowFields = { uShRect: shadow.rect }

  await breathe(0.9)

  // ---- desk + monitors: toon materials with outlines ----
  // outlines: an inverted hull per part, pushed out a fixed number of pixels in clip space
  const outlineMat = bind(
    new FlatMaterial({
      fog: false,
      extraBits: [
        bit('heroOutline', {
          bindings: { material: { uOutline: v3, uPx: f1, uRes: 'vec2<f32>' } },
          gl: {
            vertex: {
              afterTransform: /* glsl */ `{
                vec3 vn = mat3(uViewMatrix) * worldNormal;
                vec2 dir = normalize((uProjectionMatrix * vec4(vn, 0.0)).xy * material.uRes + 1e-6);
                gl_Position.xy += dir * (2.0 * material.uPx / material.uRes) * gl_Position.w;
              }`,
            },
            fragment: { material: 'albedo = decodeColor(material.uOutline);' },
          },
        }),
        revealBit,
      ],
    }),
    { uOutline: tc('#5f4a3d', '#04050c'), uPx: 1, ...reveals },
    ['uReveal', 'uRes'],
  )
  outlineMat.state.cullMode = 'front'
  let drawCat: ((lx: number, ly: number, open: number) => void) | null = null
  let drawThemeIcon: ((dark: boolean) => void) | null = null
  let screenMat: FlatMaterial | null = null
  const toon = new Map<string, BaseMaterial3D>()
  const outlined = new Set<string>()
  const meshes: Array<Mesh3D> = []
  model.traverse((o) => {
    if (o instanceof Mesh3D && o.material) meshes.push(o)
  })
  for (const mesh of meshes) {
    const src = mesh.material as BaseMaterial3D & { baseColor?: Color }
    const name = src.label ?? ''
    if (name === 'glass') {
      if (!screenMat) {
        const atlas = screenAtlas(catPath)
        drawCat = atlas.drawCat
        drawThemeIcon = atlas.drawThemeIcon
        screenMat = bind(new FlatMaterial({ baseColorTexture: atlas.tex, extraBits: [revealBit] }), reveals, revealKeys)
      }
      mesh.material = screenMat
    } else if (name === 'led') {
      mesh.material = bind(new FlatMaterial({ baseColor: 0x7dff8a, extraBits: [revealBit] }), reveals, revealKeys)
    } else {
      if (!toon.has(name)) {
        // small parts read better without a line around each one
        const outline = !/^(key|bay|label|metal|coffee|cable|glassOff|deskGap|note|leaf|vine|pages|teal|orange)/.test(name)
        const mat = new FlatMaterial({ baseColor: src.baseColor ?? 0xffffff, doubleSided: name === 'leaf', extraBits: [toonBit, revealBit] })
        toon.set(name, bind(mat, { ...toonLight, ...reveals }, revealKeys))
        if (outline) outlined.add(name)
      }
      mesh.material = toon.get(name)!
      if (outlined.has(name)) mesh.addChild(new Mesh3D({ geometry: mesh.geometry, material: outlineMat, castShadow: false, receiveShadow: false }))
    }
    wired.push(mesh)
  }

  // ---- cypresses on the shoulders of the two hills ----
  const treeMat = bind(
    new FlatMaterial({
      vertexColors: true,
      extraBits: [
        bit('heroTree', {
          bindings: { material: { uTreeLight: v3, uAir: v3 } },
          gl: {
            fragment: {
              material: /* glsl */ `{
                float l = smoothstep(-0.3, 0.8, dot(normal, vec3(${SUN.join(', ')})));
                vec3 c = hzToLinear(albedo) * mix(0.5, 1.5, l) * hzL(material.uTreeLight);
                albedo = hzOut(mix(c, hzL(material.uAir), hzAir(vPosition)));
              }`,
            },
          },
        }),
        revealBit,
      ],
    }),
    { uTreeLight: tc('#ffffff', '#2c3f73'), uAir: ground.uAir, ...reveals },
    revealKeys,
  )
  for (const [x, z, s, kind] of [
    [-12.5, -14, 0.52, 0], [-5.5, -16.5, 0.5, 1], // hill A
    [7.5, -26.5, 0.62, 0], [11.5, -25.5, 0.6, 1], [14, -27.5, 0.55, 0], // hill B
  ]) {
    const src = cypress[kind] as Mesh3D
    const model = new Mesh3D({ geometry: src.geometry, material: treeMat, castShadow: false, receiveShadow: false })
    model.position.copyFrom(src.position)
    model.quaternion.copyFrom(src.quaternion)
    model.scale.copyFrom(src.scale) // keeps its own transform: mesh compression stores the vertices rescaled
    const tree = new Mesh3D()
    tree.addChild(model)
    tree.position.set(x, hill(x, z) - 0.05, z)
    tree.rotation.y = rand() * 6.28
    tree.scale.set(s, s, s)
    view.root.addChild(tree)
    wired.push(model)
  }

  // ---- ground: the soil seen between the blades ----
  {
    const NX = 110
    const NZ = 90
    const positions = new Float32Array((NX + 1) * (NZ + 1) * 3)
    const normals = new Float32Array((NX + 1) * (NZ + 1) * 3)
    const indices = new Uint32Array(NX * NZ * 6)
    for (let j = 0, v = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++, v++) {
        const x = -45 + (90 * i) / NX
        const z = 12 - (74 * j) / NZ
        positions.set([x, hill(x, z), z], v * 3)
        const e = 0.3
        const n = norm([hill(x - e, z) - hill(x + e, z), 2 * e, hill(x, z - e) - hill(x, z + e)])
        normals.set(n, v * 3)
      }
    }
    for (let j = 0, k = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i
        const b = a + NX + 1 // one row further along -z
        indices.set([a, a + 1, b, b, a + 1, b + 1], k)
        k += 6
      }
    }
    const soil = new Mesh3D({
      geometry: new Geometry3D({ positions, normals, indices }),
      material: bind(
        new FlatMaterial({
          doubleSided: true,
          textures: { shadow: shadow.tex },
          extraBits: [
            bit('heroSoil', {
              textures: ['shadow'],
              bindings: { material: GROUND_FIELDS },
              gl: {
                fragment: {
                  material: /* glsl */ `{
                    vec3 w = vPosition;
                    float lit = smoothstep(0.1, 0.6, dot(normal, vec3(${SUN.join(', ')})));
                    vec3 c = hzGround(w, lit, hzPool(w.xz), ${shadowAt('w')}, ${GROUND_ARGS});
                    // dark between the blades close up; further off the tufts thin out, so match their tone
                    c *= mix(0.42, 0.8, smoothstep(6.0, 22.0, length(w.xz))) + 0.18 * hzNoise(w.xz * 26.0);
                    albedo = hzOut(mix(c, hzL(material.uAir), hzAir(w)));
                  }`,
                },
              },
            }),
            revealBit,
          ],
        }),
        { ...ground, ...shadowFields, ...reveals },
        ['uShadowMix', 'uReveal'],
      ),
      castShadow: false,
      receiveShadow: false,
    })
    view.root.addChild(soil)
    wired.push(soil)
  }

  // ---- grass and flowers: one instanced draw each ----
  /** A batch of one geometry: `fill` writes each copy's root position and two vec4s of data. */
  const batch = (geo: Geometry3D, mat: BaseMaterial3D, count: number, fill: (i: number, root: Float32Array, a: Float32Array, b: Float32Array) => void) => {
    const mesh = new BatchedMesh3D({
      size: count,
      instanceData: { a: { value: [0, 0, 0, 0], type: 'vec4<f32>' }, b: { value: [0, 0, 0, 0], type: 'vec4<f32>' } },
    })
    for (let i = 0; i < count; i++) {
      mesh.setGeometryAt(i, geo)
      mesh.setMaterialAt(i, mat)
      mesh.setPassesAt(i, RenderPassBit.OPAQUE)
    }
    // then matrices and per-copy data straight into the batch's arrays, uploaded once
    const mats = mesh.matrices
    const data = mesh.instanceData
    const root = new Float32Array(3)
    const a = new Float32Array(4)
    const b = new Float32Array(4)
    for (let i = 0; i < count; i++) {
      fill(i, root, a, b)
      const o = mats.offset + i * mats.stride // column-major: identity, then the translation
      mats.data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, root[0], root[1], root[2], 1], o)
      const d = data.offset + i * data.stride
      data.data.set(a, d + data.fields.a)
      data.data.set(b, d + data.fields.b)
    }
    mats.update()
    data.update()
    return mesh
  }
  // A point inside the wedge the cameras can see, between two depths. `patch` is the
  // size of the clumps it grows in: noise decides where the meadow is thick or thin.
  const spot = (z0: number, z1: number, patch: number): V3 => {
    for (;;) {
      const z = lerp(z0, z1, rand())
      const x = (rand() * 2 - 1) * Math.min(1.5 + (10.5 - z) * 0.68, 38)
      if (rand() < 0.25 + 0.75 * noise2(x * patch + 40, z * patch)) return [x, heightAt(x, z), z]
    }
  }

  // Flowers first: each one also gets a stem, which is just another blade in the grass.
  const kinds = [
    { color: rgb('#fffaf0'), petals: 12 }, // daisy
    { color: rgb('#f29ac0'), petals: 8 },
    { color: rgb('#e5532d'), petals: 6 }, // poppy, echoing the desk
    { color: rgb('#b99be6'), petals: 5 },
  ]
  // slope light per blade: slopeLit already looks 0.5 m either side, so a 0.5 m grid loses nothing
  const slope = gridded(slopeLit, -39, 39, -45, 7, 0.5)
  const heightAt = gridded(hill, -39, 39, -45, 7, 0.5) // finer than the soil mesh the blades stand on
  if (import.meta.env.DEV) console.assert(Math.abs(slope(3.3, -12.7) - slopeLit(3.3, -12.7)) < 0.05, 'slope grid')
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
  const blade = new Geometry3D({
    positions: new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.4, 0.33, 0, 0.4, 0.33, 0, -0.25, 0.66, 0, 0.25, 0.66, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]),
  })
  const grassMat = bind(
    new FlatMaterial({
      doubleSided: true,
      textures: { shadow: shadow.tex },
      extraBits: [
        bit('heroGrass', {
          textures: ['shadow'],
          interStage: { vColor: 'vec3<f32>' },
          bindings: { material: { ...GROUND_FIELDS, ...WIND_FIELDS }, instance: { a: 'vec4<f32>', b: 'vec4<f32>' } },
          gl: {
            vertex: {
              // a: height, yaw, random, width. b: dryness, arc, slope light
              beforeTransform: /* glsl */ `{
                vec3 root = modelMatrix[3].xyz;
                vec4 D = instance.a, C = instance.b;
                float h = position.y, c = cos(D.y), s = sin(D.y);
                // a blade that arcs over as it rises
                vec3 p = vec3(position.x * D.w, h * D.x * (1.0 - 0.18 * C.y * h), h * h * D.x * C.y);
                p = vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
                vec2 sw = hzSway(root, D.z, ${WIND_ARGS}) * h * h * D.x;
                p.xz += sw;
                p.y -= length(sw) * 0.3;
                position = vec4(p, 1.0);

                float pl = hzPool(root.xz), sh = ${shadowAt('root')};
                vec3 g = hzGround(root, C.z, pl, sh, ${GROUND_ARGS});
                vec3 col = g * mix(0.4, 1.0, smoothstep(0.0, 0.75, h));                    // roots sit in the blades' own shade
                col = mix(col, hzL(material.uDry) * dot(g, vec3(1.2)), C.x * (0.25 + 0.6 * h)); // dry blades and seed heads
                col = mix(col, mix(g * 1.5, hzL(material.uTip), pl * sh), h * h * 0.45);     // tips catch the light
                col *= 0.82 + 0.36 * abs(dot(vec3(s, 0.0, c), vec3(${SUN.join(', ')})));   // face-on to the sun is brighter than edge-on
                vColor = mix(col * (0.9 + 0.2 * D.z), hzL(material.uAir), hzAir(root));
              }`,
            },
            fragment: { material: 'albedo = hzOut(vColor);' },
          },
        }),
        revealBit,
      ],
    }),
    { ...ground, ...shadowFields, ...reveals },
    ['uShadowMix', 'uT', 'uShake', 'uPointer', 'uReveal'],
  )
  const grass = batch(blade, grassMat, blooms.length + bands.reduce((n, b) => n + b.count, 0), (i, r, a, b) => {
    if (i < blooms.length) {
      const f = blooms[i]
      r.set([f.x, f.y, f.z])
      a.set([f.stem, rand() * Math.PI, f.rnd, 0.006])
      b.set([0, 0, slope(f.x, f.z), 0]) // straight and green
      return
    }
    let n = i - blooms.length
    const band = bands.find((bd) => (n -= bd.count) < 0)!
    const [x, y, z] = spot(band.z0, band.z1, 0.9)
    const seed = band === bands[0] && rand() < 0.03 // a few tall seed stalks
    const height = (0.06 + rand() * 0.1) * band.tall * (0.7 + 0.6 * noise2(x * 0.5 + 9, z * 0.5)) * (seed ? 2.2 : 1)
    r.set([x, y, z])
    a.set([height, rand() * Math.PI, rand(), (0.009 + rand() * 0.009) * band.wide * coarse * (seed ? 0.6 : 1)])
    // dryness, how far the blade arcs over, slope light
    b.set([seed ? 1 : rand() < 0.14 ? 0.5 + rand() * 0.5 : rand() * 0.15, 0.15 + rand() * 0.5, slope(x, z), 0])
  })

  const flowerMat = bind(
    new FlatMaterial({
      alphaMode: 'mask',
      textures: { shadow: shadow.tex },
      extraBits: [
        bit('heroFlower', {
          textures: ['shadow'],
          interStage: { vColor: 'vec3<f32>', vShape: 'vec4<f32>', vPetal: 'vec2<f32>' },
          bindings: { material: { ...WIND_FIELDS, uShadowMix: f1, uShRect: 'vec4<f32>', uAir: v3, uFlowerTint: v3, uCenter: v3 }, instance: { a: 'vec4<f32>', b: 'vec4<f32>' } },
          gl: {
            vertex: {
              // a: size, random, petals, stem height. b: colour
              afterTransform: /* glsl */ `{
                vec3 root = modelMatrix[3].xyz;
                vec4 D = instance.a;
                vec3 base = root + vec3(0.0, D.w, 0.0);
                base.xz += hzSway(root, D.y, ${WIND_ARGS}) * D.w;
                vec4 mv = uViewMatrix * vec4(base, 1.0);
                // billboard, squashed vertically so the bloom reads as tilted up towards the sky
                vec2 q = position.xy;
                mv.xy += q * D.x * vec2(1.0, 0.5 + 0.35 * D.y);
                vPetal = q * 2.0;
                vColor = instance.b.rgb;
                float light = mix(0.38, 1.0, hzPool(root.xz)) * mix(0.6, 1.0, ${shadowAt('root')});
                vShape = vec4(D.z, D.y, light, hzAir(root));
                gl_Position = uProjectionMatrix * mv;
              }`,
            },
            fragment: {
              material: /* glsl */ `{
                float r = length(vPetal);
                float petal = pow(abs(cos(atan(vPetal.y, vPetal.x) * vShape.x * 0.5 + vShape.y * 6.28)), 0.7);
                alpha = r > mix(0.4, 1.0, petal) ? 0.0 : 1.0;
                vec3 c = r < 0.26
                  ? hzL(material.uCenter) * mix(1.0, 0.72, smoothstep(0.1, 0.26, r))
                  : hzL(vColor) * mix(0.78, 1.0, smoothstep(0.26, 0.9, r)) * mix(0.9, 1.0, petal);
                albedo = hzOut(mix(c * hzL(material.uFlowerTint) * vShape.z, hzL(material.uAir), vShape.w));
              }`,
            },
          },
        }),
        revealBit,
      ],
    }),
    { ...shadowFields, uAir: ground.uAir, uFlowerTint: tc('#ffffff', '#7f8fd0'), uCenter: rgb('#f2b632'), ...reveals },
    ['uShadowMix', 'uT', 'uShake', 'uPointer', 'uReveal'],
  )
  const flowerQuad = new PlaneGeometry({ width: 1, height: 1 })
  const flowers = batch(flowerQuad, flowerMat, blooms.length, (i, r, a, b) => {
    const f = blooms[i]
    r.set([f.x, f.y, f.z])
    a.set([f.size, f.rnd, f.kind.petals, f.stem])
    b.set([...f.kind.color, 0])
  })
  view.root.addChild(grass, flowers)

  await breathe(0.95)

  // ---- steam off the coffee: one billboard with a scrolling-noise wisp ----
  const steamMat = bind(
    new FlatMaterial({
      alphaMode: 'blend',
      fog: false,
      extraBits: [
        bit('heroSteam', {
          bindings: { material: { uT: f1, uSteam: v3, uMug: v3 } },
          gl: {
            vertex: {
              afterTransform: /* glsl */ `{
                vec4 mv = uViewMatrix * vec4(material.uMug, 1.0); // rim of the mug
                mv.xy += (position.xy + vec2(0.0, 0.5)) * vec2(0.14, 0.34);
                gl_Position = uProjectionMatrix * mv;
              }`,
            },
            fragment: {
              material: /* glsl */ `{
                vec2 uv = vUV;
                float a = hzSteam(uv, material.uT);
                albedo = decodeColor(material.uSteam);
                alpha = a * 0.5;
              }`,
            },
          },
        }),
      ],
    }),
    { uSteam: tc('#ffffff', '#9fb0e0'), uMug: [0.69, 0.86, 0.2] },
    ['uT'],
  )
  const steam = new Mesh3D({ geometry: new PlaneGeometry({ width: 1, height: 1 }), material: steamMat, castShadow: false, receiveShadow: false })
  view.root.addChild(steam)

  // ---- wires between the parts, long enough to stay joined all the way up ----
  const dist = (n: string): V3 => {
    const f = floaters.find((x) => x.obj.label === n)
    if (f) return f.target
    const p = nodeOf(n).position
    return [p.x, p.y, p.z]
  }
  const wire = (a: string, b: string, radius: number, color = '#2b2c30') => {
    const pa = dist(a)
    const pb = dist(b)
    return { a: portOf(a), b: portOf(b), radius, color, finalDistance: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) }
  }
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
    { sun: SUN, bit, revealBit },
  )
  for (const c of cables.items) bind(c.material, { uLight: tc('#ffffff', '#7f8fd0'), ...reveals }, ['uReveal'])
  view.root.addChild(...cables.items.map((c) => c.mesh))

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
  const titleMat = bind(
    new FlatMaterial({
      alphaMode: 'blend',
      fog: false,
      textures: { title: Texture.from(titleCanvas) },
      extraBits: [
        bit('heroTitle', {
          textures: ['title'],
          bindings: { material: { uInk: v3, uBlue: v3, uCoral: v3, uAmber: v3, uAnim: 'vec4<f32>', uSplit: f1 } },
          // the same gradient as auctervia.tech: ink, then a blue / coral / amber edge, then a faint ghost
          gl: {
            fragment: {
              material: /* glsl */ `{
                vec2 uv = vUV;
                bool head = uv.y > material.uSplit;
                float pos = head ? material.uAnim.x : material.uAnim.z;
                float op = head ? material.uAnim.y : material.uAnim.w;
                float u = (uv.x + 1.5 * pos) / 2.5; // a 250% wide gradient sliding across
                vec3 col = mix(hzL(material.uInk), hzL(material.uBlue), smoothstep(0.40, 0.45, u));
                col = mix(col, hzL(material.uCoral), smoothstep(0.45, 0.50, u));
                col = mix(col, hzL(material.uAmber), smoothstep(0.50, 0.55, u));
                col = mix(col, hzL(material.uInk), smoothstep(0.55, 0.60, u));
                float ghost = mix(1.0, 0.2, smoothstep(0.55, 0.60, u));
                albedo = hzOut(col);
                alpha = sampleTitle(vec2(uv.x, 1.0 - uv.y)).a * ghost * op;
              }`,
            },
          },
        }),
      ],
    }),
    {
      uInk: tc('#171717', '#ededed'),
      uBlue: rgb('#498fff'),
      uCoral: rgb('#ff7a7a'),
      uAmber: rgb('#ffbc74'),
      uAnim: [1, 0, 1, 0], // heading position/opacity, subtitle position/opacity
      uSplit: 1 - (TPAD + TH1 + TGAP / 2) / titleCanvas.height,
    },
  )
  const title = new Mesh3D({ geometry: new PlaneGeometry({ width: 1, height: 1 }), material: titleMat, castShadow: false, receiveShadow: false })
  title.position.z = TITLE_Z
  view.root.addChild(title)
  let titleHome = 11

  // ---- the intro's wireframe: every edge of the model, ground and trees ----
  const lines = wireMaterial(bind, { uLine, uWire: 0 })
  const lineMeshes: Array<Mesh3D> = []
  for (const m of wired) {
    const edges: number[] = []
    const p = getAttributeData(m.geometry!, 'aPosition', 3)
    const idx = m.geometry!.indices
    const n = idx ? idx.length : p.length / 3
    const at = (i: number) => edges.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])
    for (let i = 0; i + 2 < n; i += 3) {
      const [a, b, c] = idx ? [idx[i], idx[i + 1], idx[i + 2]] : [i, i + 1, i + 2]
      at(a), at(b), at(b), at(c), at(c), at(a)
    }
    const l = new Mesh3D({ geometry: new Geometry3D({ positions: new Float32Array(edges), topology: 'line-list' }), material: lines, castShadow: false, receiveShadow: false })
    m.addChild(l)
    lineMeshes.push(l)
  }

  // ---- theme ----
  const wantNight = () => (root.dataset.theme === 'dark' ? 1 : 0)
  night = wantNight()
  const applyTheme = () => {
    for (const { mat, field, tc: c } of themed) mat.data[field] = mix3(c.d, c.n, night)
    sky.material!.data.uNight = night
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
  let time = 0 // animation clock for wind, clouds, steam
  let aspect = 1
  let offsetPx = 0 // the picture is slid down by this much, so the title has sky to sit on
  let pixelRatio = 1

  let relayout: (() => void) | null = null
  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    pixelRatio = Math.min(devicePixelRatio, desktop ? 2 : 1.5)
    app.renderer.resolution = pixelRatio
    app.renderer.resize(w, h)
    shared.uRes = [Math.round(w * pixelRatio), Math.round(h * pixelRatio)]
    canvas.style.width = canvas.style.height = '' // the stylesheet sizes it
    view.width = w
    view.height = h
    aspect = w / h
    // slide the picture down so the title has sky to sit on; px floor for short laptop screens
    offsetPx = Math.round(w < h ? h * 0.08 : Math.max(h * 0.07, 105))
    // A taller picture (h + 2 offset) centred `offset` lower, with the fov widened to keep the
    // scale: the part past the bottom of the view is cropped.
    camera.viewport.set(0, 0, 1, (h + 2 * offsetPx) / h)
    camera.fov = (360 / Math.PI) * Math.atan((tanHalf * (h + 2 * offsetPx)) / h)
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

  // ---- camera maths (the view's own matrices include the slide, so poses are worked out here) ----
  /** Camera position for a pose, pulled back on narrow screens so `need` metres fit. */
  const fit = (p: typeof WIDE): V3 => {
    const d = sub(p.pos, p.tgt)
    const len = Math.hypot(...d)
    const want = Math.max(len, p.need / (2 * tanHalf * aspect))
    return [p.tgt[0] + (d[0] * want) / len, p.tgt[1] + (d[1] * want) / len, p.tgt[2] + (d[2] * want) / len]
  }
  /** World direction through a point on the canvas (ndc -1..1, y up), for a camera at `eye` looking at `at`. */
  const rayFrom = (eye: V3, at: V3, nx: number, ny: number): V3 => {
    const f = norm(sub(at, eye))
    const r = norm(cross(f, [0, 1, 0]))
    const u = cross(r, f)
    const y = ny + (2 * offsetPx) / canvas.clientHeight // undo the slide
    const sx = nx * tanHalf * aspect
    const sy = y * tanHalf
    return norm([f[0] + r[0] * sx + u[0] * sy, f[1] + r[1] * sx + u[1] * sy, f[2] + r[2] * sx + u[2] * sy])
  }
  /** Canvas ndc (y up) of a world point, as the current camera sees it. */
  const project = (p: V3) => {
    const eye: V3 = [camera.position.x, camera.position.y, camera.position.z]
    const f = norm(sub(camTarget, eye))
    const r = norm(cross(f, [0, 1, 0]))
    const u = cross(r, f)
    const d = sub(p, eye)
    const z = dot(d, f)
    return [dot(d, r) / z / (tanHalf * aspect), dot(d, u) / z / tanHalf - (2 * offsetPx) / canvas.clientHeight] as const
  }
  let camTarget: V3 = [...CLOSE.tgt]

  // ---- pointer (desktop only): parallax + grass shake under the cursor ----
  const pointer = { x: 0, y: 0 }
  const parallax = { x: 0, y: 0 }
  let hovering = false
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect()
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1
    pointer.y = 1 - ((e.clientY - r.top) / r.height) * 2
    hovering = true
  }
  const onLeave = () => (hovering = false)
  if (desktop && !still) {
    window.addEventListener('pointermove', onMove)
    root.addEventListener('pointerleave', onLeave)
  }

  // ---- the TV is the colour-mode switch ----
  const tv = nodeOf('Float_tv')
  const tvBox = (() => {
    // its box in its own space, measured once, then turned with it each time it is tested
    const lo: V3 = [Infinity, Infinity, Infinity]
    const hi: V3 = [-Infinity, -Infinity, -Infinity]
    const inv = new Matrix4().copyFrom(tv.getGlobalTransform()).getInverse(tv.getGlobalTransform())
    trianglesOf(tv, (a, b, c) => {
      for (const w of [a, b, c]) {
        const q = xform(inv.elements, w[0], w[1], w[2])
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], q[k])
          hi[k] = Math.max(hi[k], q[k])
        }
      }
    })
    return { lo, hi }
  })()
  const onTv = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect()
    const eye: V3 = [camera.position.x, camera.position.y, camera.position.z]
    const d = rayFrom(eye, camTarget, ((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2)
    // into the TV's own space, then a slab test against its box
    const inv = new Matrix4().copyFrom(tv.getGlobalTransform()).getInverse(tv.getGlobalTransform()).elements
    const o = xform(inv, eye[0], eye[1], eye[2])
    const e2 = xform(inv, eye[0] + d[0], eye[1] + d[1], eye[2] + d[2])
    let near = 0
    let far = Infinity
    for (let k = 0; k < 3; k++) {
      const dir = e2[k] - o[k]
      const t1 = (tvBox.lo[k] - o[k]) / dir
      const t2 = (tvBox.hi[k] - o[k]) / dir
      near = Math.max(near, Math.min(t1, t2))
      far = Math.min(far, Math.max(t1, t2))
    }
    return near <= far
  }
  const onClick = (e: MouseEvent) => {
    if (started && onTv(e)) toggleTheme()
  }
  const onHover = (e: PointerEvent) => {
    canvas.style.cursor = started && onTv(e) ? 'pointer' : ''
  }
  canvas.addEventListener('click', onClick)
  canvas.addEventListener('pointermove', onHover)

  let catHead: V3 = [0, 1.1, -0.06] // centre of the cat's screen

  const look = { x: 0, y: 0 }
  let lastLook: V3 = [9, 9, 9]
  let nextBlink = 2 + rand() * 3
  const blinkLen = 0.2

  /** Put the heading where the page's text used to sit, as seen from the end of the intro. */
  const layoutTitle = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    const eye = fit(CLOSE)
    const scale = Math.min(72, Math.max(36, w * 0.06)) / TH1
    const pxW = titleCanvas.width * scale
    const pxH = titleCanvas.height * scale
    const topPx = Math.min(150, Math.max(80, h * 0.135)) - TPAD * scale // low enough that the tree tops overlap it a little
    const d = rayFrom(eye, CLOSE.tgt, 0, 1 - (2 * (topPx + pxH / 2)) / h)
    const k = (TITLE_Z - eye[2]) / d[2]
    const perPx = (2 * (eye[2] - TITLE_Z) * tanHalf) / h
    title.scale.set(pxW * perPx, pxH * perPx, 1)
    title.position.x = eye[0] + d[0] * k
    titleHome = eye[1] + d[1] * k
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

    // a theme switch cuts straight over; the page's own transition covers it (see theme.ts)
    const target = wantNight()
    if (target !== night) {
      night = target
      applyTheme()
      dirty = true
    }
    if (still && !dirty && warm <= 0) return
    dirty = false
    warm--

    if (!still) {
      if (started) t += dt
      time += dt
    }
    if (started && !revealed && t >= TITLE_AT) {
      revealed = true
      revealAt = time
      opts.onStage('reveal')
    }
    if (started && !finished && t >= ZOOM_END) {
      finished = true
      opts.onStage('done')
    }

    // scrolling: the camera climbs, the heading sinks behind the hills, the parts float away
    const sRaw = clamp01(still ? 0 : opts.scroll.smooth)
    const s = sRaw * sRaw * (3 - 2 * sRaw)
    for (const f of floaters) {
      const p = mix3(f.home, f.target, s) // everything moves together with the camera
      f.obj.position.set(p[0], p[1] + Math.sin(time * 0.7 + f.phase) * 0.1 * s, p[2])
      f.obj.rotation.set(f.spin[0] * s + Math.sin(time * 0.5 + f.phase) * 0.06 * s, f.spin[1] * s, f.spin[2] * s)
    }
    cables.update(s, canvas.clientHeight * pixelRatio)
    steamMat.data.uMug = worldOf(mugNode, MUG_OFFSET)
    catHead = worldOf(pcNode, CAT_OFFSET)

    const since = revealed ? time - revealAt : -1
    const hp = revealEase(since / 1.2)
    const sp = revealEase((since - 0.18) / 1.2)
    // sinks well below the dip between the hills, and fades too, so no sliver shows on any screen
    const sink = smooth(0.04, 0.38, s) // gone just before the card starts forming (CARD_AT in index.tsx)
    titleMat.data.uAnim = [
      1 - hp,
      (since < 0 ? 0 : revealEase(since / 1.2 / 0.15)) * (1 - sink),
      1 - sp,
      (since < 0.18 ? 0 : revealEase((since - 0.18) / 1.2 / 0.15)) * (1 - sink),
    ]
    title.position.y = lerp(titleHome, -4, sink)

    // camera: intro zoom, then pointer parallax around the target
    const k = zoom(t)
    let pos = mix3(fit(WIDE), fit(CLOSE), k)
    let tgt = mix3(WIDE.tgt, CLOSE.tgt, k)
    if (s > 0) {
      const u = 1 - s
      const mid = fit(SKY_MID)
      const end = fit(SKY)
      pos = [0, 1, 2].map((i) => pos[i] * u * u + mid[i] * 2 * u * s + end[i] * s * s) as V3
      tgt = [0, 1, 2].map((i) => tgt[i] * u * u + SKY_MID.tgt[i] * 2 * u * s + SKY.tgt[i] * s * s) as V3
    }
    const active = hovering && t > ZOOM_END
    const ease = 1 - Math.exp(-dt * 4)
    parallax.x = lerp(parallax.x, active ? pointer.x : 0, ease)
    parallax.y = lerp(parallax.y, active ? pointer.y : 0, ease)
    {
      const f = norm(sub(tgt, pos))
      const r = norm(cross(f, [0, 1, 0]))
      const up = cross(r, f)
      const px = parallax.x * lerp(0.9, 0.45, k)
      const py = parallax.y * lerp(0.4, 0.2, k)
      pos = [pos[0] + r[0] * px + up[0] * py, pos[1] + r[1] * px + up[1] * py, pos[2] + r[2] * px + up[2] * py]
    }
    camera.position.set(...pos)
    camera.lookAt({ x: tgt[0], y: tgt[1], z: tgt[2] })
    camTarget = tgt
    sky.position.set(...pos)

    // the cat watches the cursor (or wanders on touch screens) and blinks now and then
    if (drawCat && !still) {
      let ax: number
      let ay: number
      if (hovering) {
        const [cx, cy] = project(catHead)
        const dx = (pointer.x - cx) * aspect
        const dy = pointer.y - cy
        const len = Math.hypot(dx, dy) || 1
        const m = Math.min(1, len / 0.7) / len
        ax = dx * m
        ay = -dy * m
      } else {
        ax = Math.sin(time * 0.6) * 0.5
        ay = Math.sin(time * 0.4) * 0.2
      }
      const e = 1 - Math.exp(-dt * 8)
      look.x = lerp(look.x, ax, e)
      look.y = lerp(look.y, ay, e)
      if (time > nextBlink + blinkLen) nextBlink = time + 2.5 + rand() * 4
      const p = (time - nextBlink) / blinkLen
      const open = p > 0 && p < 1 ? Math.abs(2 * p - 1) : 1
      const changed = Math.abs(look.x - lastLook[0]) + Math.abs(look.y - lastLook[1]) + Math.abs(open - lastLook[2])
      if (changed > 0.01) {
        drawCat(look.x, look.y, open)
        lastLook = [look.x, look.y, open]
      }
    }

    // where the cursor ray meets the hill
    let hit = false
    if (active && s < 0.15) {
      const ray = rayFrom(pos, tgt, pointer.x, pointer.y)
      if (ray[1] < -0.01) {
        let y = 0
        for (let i = 0; i < 5; i++) {
          const d = (y - pos[1]) / ray[1]
          shared.uPointer = [pos[0] + ray[0] * d, y, pos[2] + ray[2] * d]
          y = hill(shared.uPointer[0], shared.uPointer[2])
        }
        hit = true
      }
    }
    shared.uShake = lerp(shared.uShake, hit ? 1 : 0, 1 - Math.exp(-dt * 6))
    shared.uT = time
    shared.uShadowMix = s
    shared.uReveal = still ? 1 : reveal(t)
    lines.data.uWire = still || t >= REVEAL_END ? 0 : wireFade(t)
    for (const l of lineMeshes) l.visible = !still && t < REVEAL_END
    outlineMat.data.uPx = lerp(0.8, 1.2, k) * pixelRatio
    for (const { mat, keys } of live) for (const key of keys) mat.data[key] = shared[key]
    app.render()
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

  return {
    start,
    count,
    dispose: () => {
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      viewObserver.disconnect()
      themeObserver.disconnect()
      window.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('pointermove', onHover)
      root.removeEventListener('pointerleave', onLeave)
      app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true })
      // React's canvas stays hidden: another instance (StrictMode's second mount) may be using its spot
    },
  }
}

