import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier'
import SceneCanvas from '../../shared/SceneCanvas'
import { useFont, useTextGeometries } from '../../shared/useTypographyGeometries'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

const PHRASE = 'everything moves'
const LETTER_COUNT_RANGE = [150, 250]
const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015
const BASE_COLOR = '#fcfcfa'
const ACCENT_COLOR = '#7fff00'
const ACCENT_RATIO = 0.125

// Spawn volume — letters start scattered mid-air above the floor and drop in on load.
const SPAWN_HALF_WIDTH = 4.5
const SPAWN_HALF_DEPTH = 4.5
const SPAWN_MIN_Y = 3
const SPAWN_MAX_Y = 10

// Play area — walls keep letters from bouncing out of frame sideways.
const WALL_HALF_WIDTH = 5.5
const WALL_HALF_DEPTH = 5.5
const WALL_HALF_HEIGHT = 100 // generously tall, since the floor can drop a long way
const WALL_THICKNESS = 0.5

// Floor — scroll-controlled, provisional tuning.
const FLOOR_HALF_THICKNESS = 0.25
const FLOOR_INITIAL_Y = -4
const FLOOR_MAX_Y = FLOOR_INITIAL_Y // can't be scrolled back up higher than the start
const FLOOR_MIN_Y = -60 // effectively bottomless for a normal scroll session
const SCROLL_TO_FLOOR = 0.015 // wheel deltaY units -> world Y units
const MAX_WHEEL_DELTA = 120 // clamps a single fast fling so the floor can't teleport

// Physics feel — exaggerated gravity for a lively (not sluggish) re-fall.
const GRAVITY_Y = -30
const RESTITUTION = 0.35
const FRICTION = 0.6
const LINEAR_DAMPING = 0.5
const ANGULAR_DAMPING = 0.6

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

// Captures wheel/touch input and drives the floor's Y position — this is the only
// consumer of scroll in this experiment, so the canvas itself never scrolls or zooms.
function ScrollFloorControl({ floorYRef }) {
  const { gl } = useThree()

  useEffect(() => {
    const el = gl.domElement

    const applyDelta = (rawDelta) => {
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, rawDelta))
      floorYRef.current = Math.min(FLOOR_MAX_Y, Math.max(FLOOR_MIN_Y, floorYRef.current - delta * SCROLL_TO_FLOOR))
    }

    const handleWheel = (event) => {
      event.preventDefault()
      applyDelta(event.deltaY)
    }

    let lastTouchY = null
    const handleTouchStart = (event) => {
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const handleTouchMove = (event) => {
      if (lastTouchY === null) return
      event.preventDefault()
      const y = event.touches[0]?.clientY ?? lastTouchY
      applyDelta((lastTouchY - y) * 2) // dragging up == scrolling down
      lastTouchY = y
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
    }
  }, [gl, floorYRef])

  return null
}

// Kinematic floor: its Y is driven by scroll each frame via setNextKinematicTranslation.
// When it drops below letters that had settled on it, they simply lose their support
// and fall again — Rapier handles that naturally, no extra "release" logic needed.
function Floor({ floorYRef }) {
  const rigidRef = useRef(null)

  useFrame(() => {
    rigidRef.current?.setNextKinematicTranslation({ x: 0, y: floorYRef.current, z: 0 })
  })

  return (
    <RigidBody ref={rigidRef} type="kinematicPosition" colliders={false} restitution={0.1} friction={0.9}>
      <CuboidCollider args={[WALL_HALF_WIDTH, FLOOR_HALF_THICKNESS, WALL_HALF_DEPTH]} />
      <mesh>
        <boxGeometry args={[WALL_HALF_WIDTH * 2, FLOOR_HALF_THICKNESS * 2, WALL_HALF_DEPTH * 2]} />
        <meshStandardMaterial color={BASE_COLOR} roughness={0.95} metalness={0} />
      </mesh>
    </RigidBody>
  )
}

// Invisible static walls on all four sides so letters bounce/pile within frame
// instead of escaping sideways. Tall enough to stay valid however low the floor gets.
function Walls() {
  const sideOffset = WALL_HALF_WIDTH + WALL_THICKNESS / 2
  const depthOffset = WALL_HALF_DEPTH + WALL_THICKNESS / 2
  return (
    <>
      <RigidBody type="fixed" colliders={false} position={[sideOffset, 0, 0]}>
        <CuboidCollider args={[WALL_THICKNESS / 2, WALL_HALF_HEIGHT, WALL_HALF_DEPTH]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[-sideOffset, 0, 0]}>
        <CuboidCollider args={[WALL_THICKNESS / 2, WALL_HALF_HEIGHT, WALL_HALF_DEPTH]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[0, 0, depthOffset]}>
        <CuboidCollider args={[WALL_HALF_WIDTH, WALL_HALF_HEIGHT, WALL_THICKNESS / 2]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[0, 0, -depthOffset]}>
        <CuboidCollider args={[WALL_HALF_WIDTH, WALL_HALF_HEIGHT, WALL_THICKNESS / 2]} />
      </RigidBody>
    </>
  )
}

function FallingLetters() {
  const font = useFont(fontUrl)
  const chars = useMemo(() => [...new Set(PHRASE.replace(/\s/g, '').split(''))], [])
  const geometries = useTextGeometries(font, chars, {
    size: GLYPH_SIZE,
    height: EXTRUDE_DEPTH,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
  })

  const letters = useMemo(() => {
    const count = Math.round(randRange(...LETTER_COUNT_RANGE))
    const list = []
    for (let i = 0; i < count; i++) {
      list.push({
        key: i,
        char: chars[Math.floor(Math.random() * chars.length)],
        position: [
          randRange(-SPAWN_HALF_WIDTH, SPAWN_HALF_WIDTH),
          randRange(SPAWN_MIN_Y, SPAWN_MAX_Y),
          randRange(-SPAWN_HALF_DEPTH, SPAWN_HALF_DEPTH),
        ],
        rotation: [randRange(0, Math.PI * 2), randRange(0, Math.PI * 2), randRange(0, Math.PI * 2)],
        scale: randRange(0.85, 1.15),
        color: Math.random() < ACCENT_RATIO ? ACCENT_COLOR : BASE_COLOR,
      })
    }
    return list
  }, [chars])

  const floorYRef = useRef(FLOOR_INITIAL_Y)

  return (
    <Physics gravity={[0, GRAVITY_Y, 0]}>
      <ScrollFloorControl floorYRef={floorYRef} />
      <Floor floorYRef={floorYRef} />
      <Walls />
      {letters.map((letter) => (
        <RigidBody
          key={letter.key}
          colliders="hull"
          position={letter.position}
          rotation={letter.rotation}
          restitution={RESTITUTION}
          friction={FRICTION}
          linearDamping={LINEAR_DAMPING}
          angularDamping={ANGULAR_DAMPING}
        >
          {/* Convex hull is an approximation — letterforms are concave, but a hull
              is cheap and stable and fills the concavities. Good enough for this pass. */}
          <mesh geometry={geometries[letter.char]} scale={letter.scale}>
            <meshStandardMaterial color={letter.color} roughness={0.85} metalness={0} />
          </mesh>
        </RigidBody>
      ))}
    </Physics>
  )
}

export default function Type03() {
  return (
    <SceneCanvas orbitControls={false}>
      <FallingLetters />
    </SceneCanvas>
  )
}
