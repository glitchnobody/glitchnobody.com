import * as THREE from 'three'

/** A wire attachment point: an offset in metres from a node's centre, turning with the node. */
export type Port = { obj: THREE.Object3D; offset: THREE.Vector3 }

export const portWorld = (p: Port, out: THREE.Vector3) => out.copy(p.offset).applyQuaternion(p.obj.quaternion).add(p.obj.position)

export type CableDef = {
  a: Port
  b: Port
  radius: number
  color: string
  /** distance between the two ports once everything has floated away */
  finalDistance: number
}

const SEGMENTS = 28
const SIDES = 6

const vertexShader = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uL, uR;
  uniform vec2 uRes;
  attribute float aT;
  attribute float aAng;
  varying vec3 vN;
  void main() {
    float d = distance(uA, uB);
    // a rope of length uL between two points hangs by about this much
    float sag = sqrt(max(0.0, (uL - d) * 0.375 * d));
    vec3 down = vec3(0.0, -1.0, 0.0);
    vec3 P = mix(uA, uB, aT) + down * sag * 4.0 * aT * (1.0 - aT);
    vec3 T = normalize((uB - uA) + down * sag * 4.0 * (1.0 - 2.0 * aT));
    vec3 n1 = normalize(cross(T, abs(T.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 n2 = cross(T, n1);
    vec3 n = cos(aAng) * n1 + sin(aAng) * n2;
    // thin wires would fall below a pixel from far away: never draw them thinner than that
    float w = (projectionMatrix * viewMatrix * vec4(P, 1.0)).w;
    float r = max(uR, w * 2.0 / (uRes.y * projectionMatrix[1][1]) * 0.9);
    vN = n;
    gl_Position = projectionMatrix * viewMatrix * vec4(P + n * r, 1.0);
  }`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor, uLight, uSun;
  varying vec3 vN;
  void main() {
    float l = smoothstep(-0.2, 0.7, dot(normalize(vN), uSun));
    gl_FragColor = vec4(uColor * mix(0.5, 1.15, l) * uLight, 1.0);
    #include <colorspace_fragment>
  }`

/** One tube per cable, shaped in the vertex shader so it can follow moving ports for free. */
export function createCables(
  defs: Array<CableDef>,
  shared: { light: { value: THREE.Color }; sun: THREE.Vector3; res: { value: THREE.Vector2 } },
) {
  const base = new THREE.BufferGeometry()
  const pos: number[] = []
  const t: number[] = []
  const ang: number[] = []
  const index: number[] = []
  for (let i = 0; i <= SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      pos.push(0, 0, 0)
      t.push(i / SEGMENTS)
      ang.push((j / SIDES) * Math.PI * 2)
    }
  }
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * SIDES + j
      const b = i * SIDES + ((j + 1) % SIDES)
      index.push(a, b, a + SIDES, b, b + SIDES, a + SIDES)
    }
  }
  base.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  base.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1))
  base.setAttribute('aAng', new THREE.Float32BufferAttribute(ang, 1))
  base.setIndex(index)

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const cables = defs.map((def) => {
    portWorld(def.a, a)
    portWorld(def.b, b)
    const d0 = a.distanceTo(b)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uA: { value: new THREE.Vector3() },
        uB: { value: new THREE.Vector3() },
        uL: { value: 1 },
        uR: { value: def.radius },
        uRes: shared.res,
        uColor: { value: new THREE.Color(def.color) },
        uLight: shared.light,
        uSun: { value: shared.sun },
      },
      vertexShader,
      fragmentShader,
    })
    const mesh = new THREE.Mesh(base, material)
    mesh.frustumCulled = false
    // slack on the desk, nearly taut once everything has floated off
    return { def, mesh, material, l0: d0 * 1.25 + 0.1, l1: def.finalDistance * 1.12 }
  })

  return {
    meshes: cables.map((c) => c.mesh),
    /** s: 0 on the desk, 1 in the sky */
    update(s: number) {
      for (const c of cables) {
        portWorld(c.def.a, c.material.uniforms.uA.value)
        portWorld(c.def.b, c.material.uniforms.uB.value)
        c.material.uniforms.uL.value = c.l0 + (c.l1 - c.l0) * s
      }
    },
    dispose() {
      base.dispose()
      for (const c of cables) c.material.dispose()
    },
  }
}
