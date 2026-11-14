import { FlatMaterial } from '@pixi/3d'
import type { BaseMaterial3D, ShaderBit } from '@pixi/3d'

// Intro timeline, in seconds: wireframe fades in, colour wipes in by depth, camera zooms.
export const WIRE_IN = 0.8
export const REVEAL_START = 1.2
export const REVEAL_END = 3.4
export const ZOOM_END = 6.0
// The heading sweeps in just as the colour wipe reaches the sky, where it sits; the loader's
// count reaches 100% a moment before (see HeroScene).
export const TITLE_AT = REVEAL_END - 0.5

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

export const wireFade = (t: number) => clamp01(t / WIRE_IN)
export const reveal = (t: number) =>
  clamp01((t - REVEAL_START) / (REVEAL_END - REVEAL_START))
export const zoom = (t: number) =>
  ease(clamp01((t - REVEAL_END) / (ZOOM_END - REVEAL_END)))

if (import.meta.env.DEV) {
  console.assert(wireFade(0) === 0 && wireFade(WIRE_IN) === 1, 'wireFade bounds')
  console.assert(reveal(REVEAL_START) === 0 && reveal(REVEAL_END) === 1, 'reveal bounds')
  console.assert(zoom(REVEAL_END) === 0 && zoom(ZOOM_END) === 1, 'zoom bounds')
  console.assert(zoom(0) === 0 && zoom(99) === 1, 'zoom clamps')
}

/**
 * GLSL shared by every hero material. Header code can't read `material`, so colours come in as
 * arguments. Colours are authored sRGB: hzL() linearises them, hzOut() writes a linear result in
 * whatever space pixi runs the material in (macros, since decodeColor is declared after this).
 */
export const HELPERS: ShaderBit = {
  name: 'heroHelpers',
  gl: {
    header: /* glsl */ `
vec3 hzL(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
#define hzOut(c) decodeColor(pow(max(c, 0.0), vec3(1.0 / 2.2)))
#define hzToLinear(c) (decodeColor(vec3(0.5)).x > 0.4 ? hzL(c) : (c))
float hzHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hzNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hzHash(i), hzHash(i + vec2(1.0, 0.0)), f.x),
             mix(hzHash(i + vec2(0.0, 1.0)), hzHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 1 where sunlight reaches the ground, 0 in shade (p = world xz)
float hzPool(vec2 p) {
  vec2 q = (p - vec2(0.9, 0.3)) / vec2(6.5, 3.0);
  q.x += q.y * 0.35;
  float desk = 1.0 - smoothstep(0.45, 1.1, length(q) + (hzNoise(p * 0.45) - 0.5) * 0.5);
  float patches = 0.75 * smoothstep(0.56, 0.74, hzNoise(p * 0.07 + 3.7)) * smoothstep(8.0, 13.0, length(p)); // on the hills
  return max(desk, patches);
}
// where a ground point falls on the baked shadow texture; rect = x0, z0, 1/width, 1/depth
vec2 hzShadowUV(vec2 p, vec4 rect) { return (p - rect.xy) * rect.zw; }
// r: shadow of everything, g: of the parts that stay; mix: 0 all on the desk, 1 all floated off
float hzShadow(vec2 s, float mixer) { return mix(s.r, s.g, mixer); }
// Meadow colour at a world position; shared by the ground, every blade and the flowers.
// lit: how far the slope faces the sun; pl: hzPool(); sh: the shadow
vec3 hzGround(vec3 wp, float lit, float pl, float sh, vec3 deep, vec3 mid, vec3 sun, vec3 shadeA, vec3 shadeB, vec3 glow) {
  vec2 p = wp.xz;
  float n = hzNoise(p * 0.35) * 0.65 + hzNoise(p * 1.3 + 7.0) * 0.35;
  vec3 sunny = mix(mix(deep, mid, smoothstep(0.25, 0.55, n)), sun, smoothstep(0.5, 0.8, n));
  vec3 shade = mix(shadeA, shadeB, smoothstep(0.3, 0.7, n));
  vec3 c = mix(shade, sunny, pl) * mix(0.7, 1.15, lit) * mix(0.5, 1.0, sh);
  vec2 g = p - vec2(0.0, 0.9); // CRT glow (night only)
  return c + glow * exp(-dot(g, g) * 0.9);
}
// distance haze: this is what separates the far hill from the near one
float hzAir(vec3 wp) { return smoothstep(8.0, 48.0, -wp.z) * 0.55; }
float hzGust(vec2 p, float t) { return hzNoise(p * 0.16 - vec2(t * 0.55, t * 0.12)); } // bands of wind crossing the meadow
float hzCloud(vec2 cp) { return hzNoise(cp) * 0.5 + hzNoise(cp * 2.1 + 4.0) * 0.3 + hzNoise(cp * 4.3 + 9.0) * 0.2; }
float hzSteam(vec2 uv, float t) {
  float n = hzNoise(vec2(uv.x * 3.0, uv.y * 2.2 - t * 0.45));
  float x = uv.x - 0.5 + (n - 0.5) * 0.45 * uv.y + sin(uv.y * 5.0 + t * 0.8) * 0.08 * uv.y;
  return smoothstep(0.16 + 0.1 * uv.y, 0.0, abs(x)) * smoothstep(0.0, 0.12, uv.y)
       * (1.0 - smoothstep(0.35, 1.0, uv.y)) * (0.35 + 0.65 * n);
}
// xz sway for a point rooted at 'root'; rnd in 0..1
vec2 hzSway(vec3 root, float rnd, float t, float shake, vec3 pointer) {
  float gust = hzGust(root.xz, t);
  float flutter = sin(t * 3.1 + rnd * 40.0 + root.x * 2.0) * 0.12;
  float k = shake * (1.0 - smoothstep(0.0, 1.3, distance(root.xz, pointer.xz)));
  vec2 sh = vec2(sin(t * 16.0 + rnd * 40.0), cos(t * 19.0 + rnd * 23.0)) * k * 0.3;
  return vec2(0.08 + gust * 0.5 + flutter, gust * 0.12) + sh;
}
vec3 hzHue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
// 0..1 "distance" the wipe travels: the ground by real distance, then up the sky
float hzRevealN(vec3 wp, vec3 eye) {
  vec3 v = wp - eye;
  float d = length(v);
  return d > 100.0
    ? 0.72 + 0.28 * smoothstep(-0.05, 0.4, v.y / d)
    : 0.72 * clamp(log(d / 4.0) / log(60.0 / 4.0), 0.0, 1.0);
}
// how far the wipe has passed a point: x shown 0..1, y the colour band
vec2 hzWipe(float n, float progress) {
  const float W = 0.2;
  float front = mix(-0.02, 1.0 + W * 1.7, progress);
  float e = (front - n) / W; // <0 not reached, 0..1 inside the band, >1 settled
  float shown = smoothstep(0.0, 0.35, e);
  return vec2(shown, shown * (1.0 - smoothstep(0.25, 1.0, e)));
}`,
  },
}

/**
 * The intro's colour wipe, on every coloured material: the background until the front passes a
 * point, a band of colorama hue as it does (keeping the light/dark structure), then the scene.
 */
export const revealBit: ShaderBit = {
  name: 'heroReveal',
  requires: [HELPERS],
  bindings: { material: { uBg: 'vec3<f32>', uReveal: 'f32' } },
  gl: {
    fragment: {
      end: /* glsl */ `{
        float n = hzRevealN(vPosition, uCameraPosition);
        vec2 w = hzWipe(n, material.uReveal);
        float luma = dot(finalColor, vec3(0.299, 0.587, 0.114));
        vec3 band = hzHue(n * 5.0 - material.uReveal * 2.5) * (0.4 + 0.8 * luma);
        finalColor = mix(decodeColor(material.uBg), mix(finalColor, band, w.y * 0.8), w.x);
      }`,
    },
  },
}

/**
 * The wireframe's lines, fading in, then wiped away with the colour. They are depth tested
 * against the (still background-coloured) surfaces, so hidden edges never show over revealed ground.
 */
export function wireMaterial<D extends Record<string, unknown>>(
  bind: (mat: BaseMaterial3D, data: D, keys: Array<'uReveal'>) => BaseMaterial3D,
  data: D,
) {
  const material = new FlatMaterial({
    alphaMode: 'blend',
    fog: false,
    topology: 'line-list',
    extraBits: [
      {
        name: 'heroWire',
        requires: [HELPERS],
        bindings: { material: { uLine: 'vec3<f32>', uWire: 'f32', uReveal: 'f32' } },
        gl: {
          // a hair towards the camera, so lines win over the faces they lie on
          vertex: { afterTransform: 'gl_Position.z -= 0.0004 * gl_Position.w;' },
          fragment: {
            material: /* glsl */ `{
              vec2 w = hzWipe(hzRevealN(vPosition, uCameraPosition), material.uReveal);
              albedo = decodeColor(material.uLine);
              alpha = 0.55 * material.uWire * (1.0 - w.x);
            }`,
          },
        },
      },
    ],
  })
  return bind(material, data, ['uReveal'])
}
