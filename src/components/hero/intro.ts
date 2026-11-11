import * as THREE from 'three'

// Intro timeline, in seconds: wireframe fades in, colour wipes in by depth, camera zooms.
export const WIRE_IN = 0.8
export const REVEAL_START = 1.4
export const REVEAL_END = 4.2
export const ZOOM_END = 6.8

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

const fragmentShader = /* glsl */ `
uniform sampler2D tColor, tDepth, tWire;
uniform float uReveal, uWire, uTime, uNear, uFar;
uniform vec3 uBg, uLine;
uniform vec2 uTexel;
varying vec2 vUv;

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  // 0..1 "distance" used by the wipe: ground by real depth, then up the sky.
  float z = texture2D(tDepth, vUv).x;
  float ndc = z * 2.0 - 1.0;
  float d = 2.0 * uNear * uFar / (uFar + uNear - ndc * (uFar - uNear));
  float n = z > 0.9999
    ? 0.72 + 0.28 * vUv.y
    : 0.72 * clamp(log(d / 1.5) / log(25.0 / 1.5), 0.0, 1.0);

  const float W = 0.2;
  float front = mix(-0.02, 1.0 + W * 1.7, uReveal);
  float e = (front - n) / W; // <0 not reached, 0..1 inside the band, >1 settled
  float shown = smoothstep(0.0, 0.35, e);
  float band = shown * (1.0 - smoothstep(0.25, 1.0, e));
  float blur = (1.0 - smoothstep(0.0, 1.6, e)) * 5.0;

  vec3 col = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    col += texture2D(tColor, vUv + vec2(cos(a), sin(a)) * uTexel * blur * (mod(float(i), 2.0) + 1.0)).rgb;
  }
  col /= 8.0;

  // colorama: hue cycled by depth, keeping the scene's light/dark structure
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, hue(n * 5.0 - uTime * 0.35) * (0.4 + 0.8 * luma), band * 0.8);

  float wire = texture2D(tWire, vUv).a * uWire;
  gl_FragColor = vec4(mix(mix(uBg, uLine, wire * 0.55), col, shown), 1.0);
  #include <colorspace_fragment>
}`

/**
 * Two-pass intro renderer: the scene in colour (+depth) and as wireframe, blended by a
 * depth-driven wipe. Only alive until the reveal ends; then the scene renders directly.
 */
export function createComposite(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  hiddenInWire: Array<THREE.Object3D>,
  uBg: THREE.IUniform<THREE.Color>,
  uLine: THREE.IUniform<THREE.Color>,
) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  const color = new THREE.WebGLRenderTarget(size.x, size.y, {
    depthTexture: new THREE.DepthTexture(size.x, size.y),
  })
  color.texture.colorSpace = THREE.SRGBColorSpace // 8-bit target: store sRGB, sample linear
  const wire = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false })
  const wireMat = new THREE.MeshBasicMaterial({ wireframe: true })

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: color.texture },
      tDepth: { value: color.depthTexture },
      tWire: { value: wire.texture },
      uReveal: { value: 0 },
      uWire: { value: 0 },
      uTime: { value: 0 },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uTexel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) },
      uBg,
      uLine,
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat)
  quad.frustumCulled = false
  const quadScene = new THREE.Scene().add(quad)
  const savedClear = new THREE.Color()

  return {
    setSize(w: number, h: number) {
      color.setSize(w, h)
      wire.setSize(w, h)
      mat.uniforms.uTexel.value.set(1 / w, 1 / h)
    },
    render(t: number) {
      renderer.setRenderTarget(color)
      renderer.render(scene, camera)

      const alpha = renderer.getClearAlpha()
      renderer.getClearColor(savedClear)
      for (const o of hiddenInWire) o.visible = false
      scene.overrideMaterial = wireMat
      renderer.setClearColor(0x000000, 0)
      renderer.setRenderTarget(wire)
      renderer.render(scene, camera)
      scene.overrideMaterial = null
      for (const o of hiddenInWire) o.visible = true
      renderer.setClearColor(savedClear, alpha)

      mat.uniforms.uReveal.value = reveal(t)
      mat.uniforms.uWire.value = wireFade(t)
      mat.uniforms.uTime.value = t
      renderer.setRenderTarget(null)
      renderer.render(quadScene, camera)
    },
    dispose() {
      color.dispose()
      wire.dispose()
      wireMat.dispose()
      mat.dispose()
      quad.geometry.dispose()
    },
  }
}
