import { FlatMaterial, Geometry3D, Mesh3D } from '@pixi/3d'
import type { Container3D, ShaderBit } from '@pixi/3d'
import { Color } from 'pixi.js'

type V3 = [number, number, number]

/** A wire attachment point: an offset in metres from a node's centre, turning with the node. */
export type Port = { obj: Container3D; offset: V3 }

const portWorld = (p: Port): V3 => {
  const m = p.obj.getGlobalTransform().elements
  const [x, y, z] = p.offset
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

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

/** One tube per cable, shaped in the vertex shader so it can follow moving ports for free. */
export function createCables(
  defs: Array<CableDef>,
  shared: { sun: V3; bit: (name: string, b: Omit<ShaderBit, 'name'>) => ShaderBit; revealBit: ShaderBit },
) {
  // uv carries (t along the cable, angle around it); the shader builds the actual positions
  const count = (SEGMENTS + 1) * SIDES
  const uvs = new Float32Array(count * 2)
  const positions = new Float32Array(count * 3)
  positions.set([-60, -60, -60, 60, 60, 60]) // bounds wide enough that the tubes are never culled
  const index: number[] = []
  for (let i = 0; i <= SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) uvs.set([i / SEGMENTS, (j / SIDES) * Math.PI * 2], (i * SIDES + j) * 2)
  }
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * SIDES + j
      const b = i * SIDES + ((j + 1) % SIDES)
      index.push(a, b, a + SIDES, b, b + SIDES, a + SIDES)
    }
  }
  const geometry = new Geometry3D({ positions, uvs, indices: new Uint16Array(index) })

  const cableBit = shared.bit('heroCable', {
    bindings: { material: { uA: 'vec3<f32>', uB: 'vec3<f32>', uL: 'f32', uR: 'f32', uResY: 'f32', uColor: 'vec3<f32>', uLight: 'vec3<f32>' } },
    gl: {
      vertex: {
        beforeTransform: /* glsl */ `{
          vec3 A = material.uA, B = material.uB;
          float T = uv.x;
          float d = distance(A, B);
          // a rope of length uL between two points hangs by about this much
          float sag = sqrt(max(0.0, (material.uL - d) * 0.375 * d));
          vec3 down = vec3(0.0, -1.0, 0.0);
          vec3 P = mix(A, B, T) + down * sag * 4.0 * T * (1.0 - T);
          vec3 tg = normalize((B - A) + down * sag * 4.0 * (1.0 - 2.0 * T));
          vec3 n1 = normalize(cross(tg, abs(tg.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
          vec3 n2 = cross(tg, n1);
          vec3 n = cos(uv.y) * n1 + sin(uv.y) * n2;
          // thin wires would fall below a pixel from far away: never draw them thinner than that
          float w = (uViewProjectionMatrix * vec4(P, 1.0)).w;
          float r = max(material.uR, w * 2.0 / (material.uResY * uProjectionMatrix[1][1]) * 0.9);
          normal = n;
          position = vec4(P + n * r, 1.0);
        }`,
      },
      fragment: {
        material: `{
          float l = smoothstep(-0.2, 0.7, dot(normal, vec3(${shared.sun.join(', ')})));
          albedo = hzOut(hzL(material.uColor) * mix(0.5, 1.15, l) * hzL(material.uLight));
        }`,
      },
    },
  })

  const cables = defs.map((def) => {
    const d0 = Math.hypot(...portWorld(def.a).map((v, i) => v - portWorld(def.b)[i]))
    const material = new FlatMaterial({ extraBits: [cableBit, shared.revealBit] })
    material.data.uR = def.radius
    material.data.uColor = new Color(def.color).toArray().slice(0, 3)
    const mesh = new Mesh3D({ geometry, material, castShadow: false, receiveShadow: false })
    // slack on the desk, nearly taut once everything has floated off
    return { def, mesh, material, l0: d0 * 1.25 + 0.1, l1: def.finalDistance * 1.12 }
  })

  return {
    items: cables,
    /** s: 0 on the desk, 1 in the sky */
    update(s: number, resY: number) {
      for (const c of cables) {
        c.material.data.uA = portWorld(c.def.a)
        c.material.data.uB = portWorld(c.def.b)
        c.material.data.uL = c.l0 + (c.l1 - c.l0) * s
        c.material.data.uResY = resY
      }
    },
  }
}
