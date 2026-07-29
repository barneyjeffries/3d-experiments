import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier'
import { Euler, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
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

// Physics feel — exaggerated gravity for a lively (not sluggish) re-fall. Bouncy
// on purpose, including accepting that the floor can launch letters upward if it
// rises into them fast — that liveliness is the point of this pass.
const GRAVITY_Y = -30
const RESTITUTION = 0.35
const FRICTION = 0.6
const LINEAR_DAMPING = 0.5
const ANGULAR_DAMPING = 0.6
const FLOOR_RESTITUTION = 0.1

// Camera follow — eases down with the floor rather than snapping, keeping the
// same relative height above it so the landing zone stays framed.
const CAMERA_HEIGHT_ABOVE_FLOOR = 8 - FLOOR_INITIAL_Y // matches SceneCanvas's default camera Y (8)
const CAMERA_FOLLOW_LERP = 0.06
const LOOK_AT_ABOVE_FLOOR = 1 // look slightly above the floor plane, where letters pile

// Recycling — letters left far above the current camera (out of view) are
// teleported back to just above it, so the fall keeps feeding the frame as we descend.
const RECYCLE_ABOVE_CAMERA_MARGIN = 6
const RESPAWN_HEIGHT_ABOVE_CAMERA_RANGE = [7, 14]

// Contact shadow — soft grounding cue since the floor mesh itself is invisible.
const SHADOW_ABOVE_FLOOR = 0.02

// Click/tap "poke" — a light prod, not a launch. Letter hull masses are tiny
// (thin extruded glyphs), so this impulse is small on purpose; scale it up if it
// reads as too subtle.
const POKE_IMPULSE_STRENGTH = 3

// Click-and-throw — press on a letter (still pokes it immediately, same as
// above), then if you drag before releasing, its on-screen drag velocity is
// tracked and thrown as an impulse on release. A plain click with no drag
// naturally computes a near-zero velocity, so it just reads as the poke above —
// no separate "was this a drag" branch needed.
const THROW_STRENGTH = 0.3 // impulse = tracked drag velocity * this
const MAX_THROW_SPEED = 40 // world units/sec cap on the raw velocity sample, so a dropped frame can't produce one huge throw
const DRAG_VELOCITY_SMOOTHING = 0.5 // 0..1, how much each new sample updates the tracked velocity

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

// Captures wheel/touch input and drives the floor's Y position — this is the only
// consumer of scroll in this experiment, so the canvas itself never scrolls or zooms.
// Skips touch-drag handling while a letter is being dragged (see DragThrowControl)
// so a throw gesture on touch doesn't also drag the floor.
function ScrollFloorControl({ floorYRef, activeDragRef }) {
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
      if (lastTouchY === null || activeDragRef.current) return
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

// Tracks a letter's drag-to-throw globally (one DOM listener, not one per letter)
// so hover/move tracking doesn't need a full-scene raycast on every mouse move.
// A letter's onPointerDown starts the drag by writing into activeDragRef; this
// component only reads/updates it and applies the throw impulse on release.
// The drag path is computed by intersecting the current pointer ray against a
// plane fixed at the grab point, facing the camera — necessary because r3f's own
// event.point does NOT update for a captured/dragged object as the pointer moves
// off its original geometry, only a fresh event.ray does.
function DragThrowControl({ activeDragRef, letterRefs }) {
  const { gl, camera } = useThree()

  useEffect(() => {
    const el = gl.domElement
    const raycaster = new Raycaster()
    const pointer = new Vector2()
    const point = new Vector3()

    const updateRay = (event) => {
      const rect = el.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
    }

    const handlePointerMove = (event) => {
      const drag = activeDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      updateRay(event)
      if (!raycaster.ray.intersectPlane(drag.plane, point)) return
      const now = performance.now()
      const dt = Math.max((now - drag.lastTime) / 1000, 1 / 120)
      const instant = point.clone().sub(drag.lastPoint).divideScalar(dt)
      if (instant.length() > MAX_THROW_SPEED) instant.setLength(MAX_THROW_SPEED)
      drag.velocity.lerp(instant, DRAG_VELOCITY_SMOOTHING)
      drag.lastPoint.copy(point)
      drag.lastTime = now
    }

    const releaseDrag = (event) => {
      const drag = activeDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) return
      const rigidBody = letterRefs.current[drag.letterIndex]
      if (rigidBody) {
        const v = drag.velocity
        rigidBody.applyImpulseAtPoint(
          { x: v.x * THROW_STRENGTH, y: v.y * THROW_STRENGTH, z: v.z * THROW_STRENGTH },
          { x: drag.lastPoint.x, y: drag.lastPoint.y, z: drag.lastPoint.z },
          true
        )
      }
      activeDragRef.current = null
    }

    el.addEventListener('pointermove', handlePointerMove)
    el.addEventListener('pointerup', releaseDrag)
    el.addEventListener('pointercancel', releaseDrag)
    return () => {
      el.removeEventListener('pointermove', handlePointerMove)
      el.removeEventListener('pointerup', releaseDrag)
      el.removeEventListener('pointercancel', releaseDrag)
    }
  }, [gl, camera, activeDragRef, letterRefs])

  return null
}

// Kinematic floor: its Y is driven by scroll each frame via setNextKinematicTranslation,
// unthrottled in both directions. When it drops below letters that had settled on
// it, they simply lose their support and fall again — Rapier handles that
// naturally, no extra "release" logic needed. Moving up into resting letters can
// launch them — that's an accepted quirk here in favor of keeping the motion lively.
// No visible mesh here — a ContactShadows plane (see SceneController) reads as the
// ground instead, so grounding stays soft rather than a hard-edged box.
function Floor({ floorYRef }) {
  const rigidRef = useRef(null)

  useFrame(() => {
    rigidRef.current?.setNextKinematicTranslation({ x: 0, y: floorYRef.current, z: 0 })
  })

  return (
    <RigidBody ref={rigidRef} type="kinematicPosition" colliders={false} restitution={FLOOR_RESTITUTION} friction={0.9}>
      <CuboidCollider args={[WALL_HALF_WIDTH, FLOOR_HALF_THICKNESS, WALL_HALF_DEPTH]} />
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

// Owns everything that needs to react to the floor's Y each frame but isn't the
// floor's own physics body: the camera (position + lookAt, eased rather than
// snapped), the contact shadow plane, and recycling letters that end up stranded
// above the current view back into the fall.
function SceneController({ floorYRef, letterRefs, shadowRef }) {
  const { camera } = useThree()
  const cameraYRef = useRef(camera.position.y)

  useFrame(() => {
    const targetCameraY = floorYRef.current + CAMERA_HEIGHT_ABOVE_FLOOR
    cameraYRef.current += (targetCameraY - cameraYRef.current) * CAMERA_FOLLOW_LERP
    camera.position.y = cameraYRef.current
    camera.lookAt(0, cameraYRef.current - CAMERA_HEIGHT_ABOVE_FLOOR + LOOK_AT_ABOVE_FLOOR, 0)

    if (shadowRef.current) {
      shadowRef.current.position.y = floorYRef.current + SHADOW_ABOVE_FLOOR
    }

    const recycleAboveY = cameraYRef.current + RECYCLE_ABOVE_CAMERA_MARGIN
    for (const rigidBody of letterRefs.current) {
      if (!rigidBody) continue
      if (rigidBody.translation().y <= recycleAboveY) continue

      rigidBody.setTranslation(
        {
          x: randRange(-SPAWN_HALF_WIDTH, SPAWN_HALF_WIDTH),
          y: cameraYRef.current + randRange(...RESPAWN_HEIGHT_ABOVE_CAMERA_RANGE),
          z: randRange(-SPAWN_HALF_DEPTH, SPAWN_HALF_DEPTH),
        },
        true
      )
      rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
      const q = new Quaternion().setFromEuler(
        new Euler(randRange(0, Math.PI * 2), randRange(0, Math.PI * 2), randRange(0, Math.PI * 2))
      )
      rigidBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
    }
  })

  return (
    <ContactShadows
      ref={shadowRef}
      position={[0, FLOOR_INITIAL_Y + SHADOW_ABOVE_FLOOR, 0]}
      scale={WALL_HALF_WIDTH * 2.2}
      opacity={0.35}
      blur={2.8}
      far={6}
      resolution={512}
      color="#000000"
    />
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
  const letterRefs = useRef([])
  const shadowRef = useRef(null)
  const activeDragRef = useRef(null)

  return (
    <Physics gravity={[0, GRAVITY_Y, 0]}>
      <ScrollFloorControl floorYRef={floorYRef} activeDragRef={activeDragRef} />
      <DragThrowControl activeDragRef={activeDragRef} letterRefs={letterRefs} />
      <Floor floorYRef={floorYRef} />
      <Walls />
      <SceneController floorYRef={floorYRef} letterRefs={letterRefs} shadowRef={shadowRef} />
      {letters.map((letter, i) => (
        <RigidBody
          key={letter.key}
          ref={(el) => (letterRefs.current[i] = el)}
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
          <mesh
            geometry={geometries[letter.char]}
            scale={letter.scale}
            onPointerDown={(event) => {
              // Deliberately onPointerDown, not onClick: r3f's onClick only fires
              // if the object hit at pointerdown still matches the object hit when
              // the click resolves (its "click-through-drag" guard). These letters
              // are always moving at least a little — falling, tumbling, settling —
              // so that match very often fails and onClick silently never fires.
              // onPointerDown raycasts fresh on press with no such gate, and reads
              // as a more natural "poke" (immediate on press) besides.
              event.stopPropagation()
              const rigidBody = letterRefs.current[i]
              if (!rigidBody) return
              const dir = event.ray.direction
              rigidBody.applyImpulseAtPoint(
                { x: dir.x * POKE_IMPULSE_STRENGTH, y: dir.y * POKE_IMPULSE_STRENGTH, z: dir.z * POKE_IMPULSE_STRENGTH },
                { x: event.point.x, y: event.point.y, z: event.point.z },
                true
              )

              // Start tracking a potential drag-to-throw on top of the poke above —
              // DragThrowControl reads/updates this and applies the release impulse.
              const normal = new Vector3()
              event.camera.getWorldDirection(normal)
              activeDragRef.current = {
                pointerId: event.pointerId,
                letterIndex: i,
                plane: new Plane().setFromNormalAndCoplanarPoint(normal, event.point),
                lastPoint: event.point.clone(),
                lastTime: performance.now(),
                velocity: new Vector3(),
              }
            }}
          >
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
