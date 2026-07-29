import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Instances, Instance } from '@react-three/drei'
import { Vector3 } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import { useFont, useTextGeometries } from '../../shared/useTypographyGeometries'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

const PHRASE = 'everything moves'
const INSTANCE_COUNT_RANGE = [300, 500]
const VOLUME = { x: 6, y: 4, z: 6 }
const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015
const BASE_COLOR = '#fcfcfa'
const ACCENT_COLOR = '#7fff00'
const ACCENT_RATIO = 0.125

// Motion tuning — provisional, meant to be felt and adjusted.
const LERP_FACTOR_RANGE = [0.02, 0.15] // per-letter catch-up speed: low = laggard, high = eager
const CAMERA_OFFSET_GAIN = 1 // how strongly camera movement displaces the swarm's shared target
const CAMERA_OFFSET_DECAY = 0.92 // per-frame decay of that displacement back toward zero
const DRIFT_AMPLITUDE_RANGE = [0.015, 0.05] // idle wander, in world units
const DRIFT_SPEED_RANGE = [0.2, 0.6] // idle wander speed, radians/sec

// Separation (boids-style, position-only — no velocity/physics integration).
const SEPARATION_RADIUS = 0.9 // letters closer than this push apart
const SEPARATION_RADIUS_SQ = SEPARATION_RADIUS * SEPARATION_RADIUS
const SEPARATION_STRENGTH = 0.06 // per-neighbour push strength before capping
const SEPARATION_MAX_OFFSET = 0.15 // hard cap on the resulting displacement
const MAX_NEIGHBOR_CHECKS = 12 // hard cap on candidates examined per letter per frame
const CELL_SIZE = SEPARATION_RADIUS // grid cell size == radius, so a 3x3x3 block covers it
const GRID_BIAS = 512 // keeps packed cell keys non-negative for our bounded volume

const CELL_OFFSETS = []
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      CELL_OFFSETS.push([dx, dy, dz])
    }
  }
}

function cellKey(ix, iy, iz) {
  return ((ix + GRID_BIAS) * 1024 + (iy + GRID_BIAS)) * 1024 + (iz + GRID_BIAS)
}

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

function DriftingScatter() {
  const font = useFont(fontUrl)
  const chars = useMemo(() => [...new Set(PHRASE.replace(/\s/g, '').split(''))], [])
  const geometries = useTextGeometries(font, chars, {
    size: GLYPH_SIZE,
    height: EXTRUDE_DEPTH,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
  })

  // Flat particle list (shared across all characters) — separation has to reason
  // about every letter regardless of glyph, so it can't stay grouped by char.
  // Generated once and never touched by React re-renders afterward.
  const particles = useMemo(() => {
    const count = Math.round(randRange(...INSTANCE_COUNT_RANGE))
    const list = []
    for (let i = 0; i < count; i++) {
      list.push({
        flatIndex: i,
        char: chars[Math.floor(Math.random() * chars.length)],
        home: [
          randRange(-VOLUME.x, VOLUME.x),
          randRange(-VOLUME.y, VOLUME.y),
          randRange(-VOLUME.z, VOLUME.z),
        ],
        rotation: [randRange(0, Math.PI * 2), randRange(0, Math.PI * 2), randRange(0, Math.PI * 2)],
        scale: randRange(0.85, 1.15),
        color: Math.random() < ACCENT_RATIO ? ACCENT_COLOR : BASE_COLOR,
        lerpFactor: randRange(...LERP_FACTOR_RANGE),
        driftPhase: randRange(0, Math.PI * 2),
        driftAmplitude: randRange(...DRIFT_AMPLITUDE_RANGE),
        driftSpeed: randRange(...DRIFT_SPEED_RANGE),
      })
    }
    return list
  }, [chars])

  // Same particles, grouped by char only for rendering (each char needs its own geometry).
  const particlesByChar = useMemo(() => {
    const map = {}
    for (const char of chars) map[char] = []
    for (const p of particles) map[p.char].push(p)
    return map
  }, [particles, chars])

  // Flat, parallel to `particles` — refs to each rendered instance's transform,
  // so the animation loop below can mutate positions directly without re-rendering React.
  const meshRefs = useRef([])

  // Cached current position of every particle, refreshed each frame — read once
  // up front so the separation pass compares a consistent snapshot instead of
  // some neighbours' already-updated positions and some not.
  const positions = useMemo(() => new Float32Array(particles.length * 3), [particles.length])

  // Uniform grid for neighbour lookups: cellKey -> array of flat indices. Bucket
  // arrays are reused across frames (length reset, not reallocated) since the
  // swarm's occupied cells stay roughly stable frame to frame.
  const gridRef = useRef(new Map())

  // Shared displacement applied to every letter's target, driven by how fast the
  // camera has been moving lately. It decays each frame, so it spikes while
  // scrolling/orbiting and relaxes back toward zero once the camera settles.
  const cameraOffset = useRef(new Vector3())
  const prevCameraPos = useRef(null)
  const scratchTarget = useRef(new Vector3())
  const scratchDelta = useRef(new Vector3())

  useFrame((state) => {
    const camera = state.camera
    if (!prevCameraPos.current) {
      prevCameraPos.current = camera.position.clone()
    }
    // Negative: letters should lag BEHIND the camera's travel (trail away from
    // the direction it's moving), not be dragged along with it.
    scratchDelta.current.copy(prevCameraPos.current).sub(camera.position).multiplyScalar(CAMERA_OFFSET_GAIN)
    cameraOffset.current.add(scratchDelta.current).multiplyScalar(CAMERA_OFFSET_DECAY)
    prevCameraPos.current.copy(camera.position)

    const t = state.clock.elapsedTime
    const offset = cameraOffset.current
    const refs = meshRefs.current
    const grid = gridRef.current
    const pos = positions

    // Pass 1: snapshot current positions and bucket them into the spatial grid.
    for (const bucket of grid.values()) bucket.length = 0
    for (let k = 0; k < particles.length; k++) {
      const mesh = refs[k]
      if (!mesh) continue
      const p = mesh.position
      pos[k * 3] = p.x
      pos[k * 3 + 1] = p.y
      pos[k * 3 + 2] = p.z
      const key = cellKey(Math.floor(p.x / CELL_SIZE), Math.floor(p.y / CELL_SIZE), Math.floor(p.z / CELL_SIZE))
      let bucket = grid.get(key)
      if (!bucket) {
        bucket = []
        grid.set(key, bucket)
      }
      bucket.push(k)
    }

    // Pass 2: ease each letter toward home + camera lag + idle drift + separation.
    for (let k = 0; k < particles.length; k++) {
      const mesh = refs[k]
      if (!mesh) continue
      const inst = particles[k]
      const px = pos[k * 3]
      const py = pos[k * 3 + 1]
      const pz = pos[k * 3 + 2]

      const ix = Math.floor(px / CELL_SIZE)
      const iy = Math.floor(py / CELL_SIZE)
      const iz = Math.floor(pz / CELL_SIZE)

      let sepX = 0
      let sepY = 0
      let sepZ = 0
      let checked = 0
      for (let oi = 0; oi < CELL_OFFSETS.length && checked < MAX_NEIGHBOR_CHECKS; oi++) {
        const [dx, dy, dz] = CELL_OFFSETS[oi]
        const bucket = grid.get(cellKey(ix + dx, iy + dy, iz + dz))
        if (!bucket) continue
        for (let bi = 0; bi < bucket.length && checked < MAX_NEIGHBOR_CHECKS; bi++) {
          const j = bucket[bi]
          if (j === k) continue
          checked++
          const ddx = px - pos[j * 3]
          const ddy = py - pos[j * 3 + 1]
          const ddz = pz - pos[j * 3 + 2]
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz
          if (distSq > 1e-6 && distSq < SEPARATION_RADIUS_SQ) {
            const dist = Math.sqrt(distSq)
            const push = (SEPARATION_RADIUS - dist) / SEPARATION_RADIUS / dist
            sepX += ddx * push
            sepY += ddy * push
            sepZ += ddz * push
          }
        }
      }
      sepX *= SEPARATION_STRENGTH
      sepY *= SEPARATION_STRENGTH
      sepZ *= SEPARATION_STRENGTH
      const sepLenSq = sepX * sepX + sepY * sepY + sepZ * sepZ
      if (sepLenSq > SEPARATION_MAX_OFFSET * SEPARATION_MAX_OFFSET) {
        const s = SEPARATION_MAX_OFFSET / Math.sqrt(sepLenSq)
        sepX *= s
        sepY *= s
        sepZ *= s
      }

      const wobble = t * inst.driftSpeed + inst.driftPhase
      scratchTarget.current.set(
        inst.home[0] + offset.x + Math.sin(wobble) * inst.driftAmplitude + sepX,
        inst.home[1] + offset.y + Math.cos(wobble * 0.8) * inst.driftAmplitude + sepY,
        inst.home[2] + offset.z + sepZ
      )
      mesh.position.lerp(scratchTarget.current, inst.lerpFactor)
    }
  })

  return (
    <>
      {chars.map((char) => {
        const list = particlesByChar[char]
        if (!list.length) return null
        return (
          <Instances key={char} limit={list.length}>
            <primitive object={geometries[char]} attach="geometry" />
            <meshStandardMaterial color="#ffffff" roughness={0.85} metalness={0} />
            {list.map((p) => (
              <Instance
                key={p.flatIndex}
                ref={(el) => {
                  meshRefs.current[p.flatIndex] = el
                  if (el) el.position.set(...p.home)
                }}
                rotation={p.rotation}
                scale={p.scale}
                color={p.color}
              />
            ))}
          </Instances>
        )
      })}
    </>
  )
}

export default function Type02() {
  return (
    <SceneCanvas>
      <DriftingScatter />
    </SceneCanvas>
  )
}
