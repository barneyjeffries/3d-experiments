import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Physics, RigidBody, CuboidCollider } from '@react-three/rapier'
import { RigidBodyType } from '@dimforge/rapier3d-compat'
import { Object3D, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'
import { useFont, useTextGeometries } from '../../shared/useTypographyGeometries'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

// Fixed sequence, hardcoded (not generated). Words don't need to be strict
// anagrams of "everything moves" — the pile holds many copies of each of its
// 12 unique letters, so a word just needs every character it uses to be one
// of those 12; repeats (like GROOVE's two O's) are fine, there's plenty.
const WORDS = ['GROOVE', 'MOTHER', 'SHIVER', 'MEMORY']

// The concluding step: the full phrase, two lines — handled as a distinct
// final segment (see `isFinale` below) since it lays out as two lines instead
// of one row and, unlike the words above, never releases back to the pile.
const FINALE_LINES = ['everything', 'moves']

const PHRASE = 'everything moves'
const LETTER_COUNT_RANGE = [280, 350] // a proper dense pile — see the ceiling note near `letters` below
const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015
const BASE_COLOR = '#fcfcfa'
const ACCENT_COLOR = '#7fff00'
const ACCENT_RATIO = 0.125

// Spawn volume — letters start scattered mid-air above the floor and drop in
// on load. Sized for a few-hundred-letter pile (type-03-scale, slightly larger).
const SPAWN_HALF_WIDTH = 5
const SPAWN_HALF_DEPTH = 5
const SPAWN_MIN_Y = 3
const SPAWN_MAX_Y = 10

// Play area — walls keep letters from bouncing out of frame sideways.
const WALL_HALF_WIDTH = 6
const WALL_HALF_DEPTH = 6
const WALL_HALF_HEIGHT = 20
const WALL_THICKNESS = 0.5

// Floor — fixed. Unlike type-03, scroll no longer drops it; scroll now drives
// the word-assembly cycle instead, so the pile just settles here once and stays.
const FLOOR_HALF_THICKNESS = 0.25
const FLOOR_Y = -4

// Physics feel — same lively, bouncy tuning as type-03.
const GRAVITY_Y = -30
const RESTITUTION = 0.35
const FRICTION = 0.6
const LINEAR_DAMPING = 0.5
const ANGULAR_DAMPING = 0.6
const FLOOR_RESTITUTION = 0.1

// Click/tap poke + drag-throw — identical feel to type-03. Ignored on a letter
// currently claimed by the word-builder (rising, held, or still kinematic).
const POKE_IMPULSE_STRENGTH = 3
const THROW_STRENGTH = 0.3
const MAX_THROW_SPEED = 40
const DRAG_VELOCITY_SMOOTHING = 0.5

// Scroll -> word-cycle timeline. Raw wheel/touch input accumulates into a 0..1
// target, which the frame loop damps toward — same shape as the other
// scroll-driven experiments' timelines.
// Sized up from an initial 8000 to keep each segment's feel now that there are
// 5 segments (4 words + the finale) sharing the timeline instead of 4.
const TOTAL_SCROLL_DISTANCE = 10000
const MAX_WHEEL_DELTA = 120
const PROGRESS_SMOOTHING = 0.1
// Below this, treat the timeline as "untouched" so the pile can settle on load
// without any letters being snatched into kinematic mode before the user scrolls.
const MIN_PROGRESS_TO_BUILD = 1e-4

// Each step owns an equal slice of the timeline. RISE_SPAN is how much of that
// slice (in local-t units) the rise-into-formation animation spans, measured
// from wherever the letter was captured — not from a fixed start — so a
// reversal mid-fall re-uses the exact same curve from whatever point it's at.
const RISE_SPAN = 0.28
const RELEASE_AT = 0.7 // local-t threshold: below = held kinematic, at/above = released to physics (word steps only — the finale never releases)
const STAGGER = 0.4 // per-letter spread of rise start, for a non-lockstep cascade

// Formation — centred, facing the camera, rising clear of the pile.
const ASSEMBLE_HEIGHT_ABOVE_FLOOR = 7
const LETTER_ROW_GAP = 0.14
const LINE_GAP = 1.3 // vertical spacing between the finale's two lines
const WOBBLE_AMPLITUDE = 0.03
const WOBBLE_SPEED_RANGE = [0.3, 0.7]

// A tiny release kick so a dropped letter doesn't just go inert — a light
// natural tumble as gravity retakes it, not a launch.
const RELEASE_LINVEL_RANGE = [-0.4, 0.4]
const RELEASE_ANGVEL_RANGE = [-1, 1]

const TAU = Math.PI * 2

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

function easeOutCubic(t) {
  const inv = 1 - t
  return 1 - inv * inv * inv
}

// Centers a word's letters in a row, spaced by each glyph's actual bounding-box
// width (post-`.center()`, so TextGeometry has already computed it).
function layoutWord(word, geometries, gap) {
  const letters = word.split('')
  const widths = letters.map((ch) => {
    const box = geometries[ch].boundingBox
    return box.max.x - box.min.x
  })
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap * (letters.length - 1)
  let cursor = -totalWidth / 2
  const offsets = []
  for (let i = 0; i < letters.length; i++) {
    offsets.push(cursor + widths[i] / 2)
    cursor += widths[i] + gap
  }
  return { letters, offsets }
}

// Captures wheel/touch input and accumulates a 0..1 scroll target for the
// word-cycle timeline — the only consumer of scroll here, so the page itself
// never scrolls.
function WordCycleScrollControl({ progressTargetRef }) {
  const { gl } = useThree()

  useEffect(() => {
    const el = gl.domElement

    const applyDelta = (rawDelta) => {
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, rawDelta))
      progressTargetRef.current = clamp01(progressTargetRef.current + delta / TOTAL_SCROLL_DISTANCE)
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
      applyDelta((lastTouchY - y) * 2)
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
  }, [gl, progressTargetRef])

  return null
}

// Camera is static in this scene (the floor no longer drops), but it still
// needs to actually aim at the pile — R3F just places the camera, it doesn't
// point it anywhere on its own.
function CameraAim({ target }) {
  const { camera } = useThree()
  useFrame(() => {
    camera.lookAt(target[0], target[1], target[2])
  })
  return null
}

// Tracks a letter's drag-to-throw globally (one DOM listener, not one per
// letter). Identical to type-03's version.
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

// Invisible static walls on all four sides so letters bounce/pile within frame
// instead of escaping sideways.
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

  // The pile itself — a few hundred letters, each independently drawn from
  // "everything moves"'s 12 unique characters, so every char has many copies
  // for the word-builder to pick from. Not the exact phrase multiset (that
  // was tried and made for a thin, sparse pile) — deliberately redundant.
  //
  // Performance ceiling: the per-frame cost here is dominated by Rapier
  // settling this many `colliders="hull"` dynamic bodies on load and letting
  // them sleep, not by the word-builder (which only ever touches the ~6-20
  // letters actively selected for the current step, scanning the full pile
  // just once per step change). 280-350 tracks type-03's proven 150-250 base
  // reasonably scaled up; if this is pushed much past ~500 on a slower
  // device, expect the initial fall-and-settle to chug before it's felt
  // anywhere else.
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

  const letterRefs = useRef([])
  const activeDragRef = useRef(null)
  // Tags a pile letter as claimed the moment it's selected into a build, and
  // frees it the moment it's released back to dynamic — so a fresh selection
  // (a new word, or a reversal reselecting mid-air) never fights an in-flight
  // letter for the same physical body.
  const letterInUseRef = useRef(new Array(letters.length).fill(false))

  const progressTargetRef = useRef(0) // raw, instantly updated from scroll input
  const progressRef = useRef(0) // damped display value that actually drives the build

  // The word currently under construction: which word index owns the active
  // scroll segment, and the selected pile letters assembling/holding/falling
  // for it. Cleared and reselected whenever the active word index changes.
  const buildRef = useRef({ wordIndex: -1, items: [] })

  const cameraTmp = useMemo(() => new Object3D(), [])
  const dummyQuat = useMemo(() => new Quaternion(), [])

  // Grabs available pile letters spelling `lines` (one row per line, stacked
  // vertically and centred as a block), laid out facing the camera. Only
  // called once per step transition — reversal within the same step re-poses
  // the already-selected letters, it doesn't reselect them.
  function selectLetters(lines, camera) {
    const formationCenter = new Vector3(0, FLOOR_Y + ASSEMBLE_HEIGHT_ABOVE_FLOOR, 0)
    // Pure-yaw facing: project the camera onto the formation's own horizontal
    // plane before aiming, so letters stand upright with no pitch/roll — just
    // rotated to face the camera's direction. For a plain Object3D (unlike a
    // Camera/Light), `lookAt` already points local +Z — this geometry's front —
    // straight at the target, so no extra flip is needed here.
    const lookTarget = camera.position.clone()
    lookTarget.y = formationCenter.y
    cameraTmp.position.copy(formationCenter)
    cameraTmp.lookAt(lookTarget)
    const facingQuat = cameraTmp.quaternion.clone()
    const rightVector = new Vector3(1, 0, 0).applyQuaternion(facingQuat)
    const upVector = new Vector3(0, 1, 0).applyQuaternion(facingQuat)

    const items = []
    const lineCount = lines.length

    lines.forEach((line, lineIndex) => {
      const { letters: lineChars, offsets } = layoutWord(line, geometries, LETTER_ROW_GAP)
      const lineOffsetY = ((lineCount - 1) / 2 - lineIndex) * LINE_GAP // first line on top

      lineChars.forEach((char, k) => {
        let letterIndex = -1
        for (let i = 0; i < letters.length; i++) {
          if (letters[i].char === char && !letterInUseRef.current[i]) {
            letterIndex = i
            break
          }
        }
        if (letterIndex === -1) return // pile happened to run out of this char — skip gracefully
        letterInUseRef.current[letterIndex] = true

        items.push({
          letterIndex,
          targetPos: formationCenter
            .clone()
            .addScaledVector(rightVector, offsets[k])
            .addScaledVector(upVector, lineOffsetY),
          targetQuat: facingQuat.clone(),
          capturePos: new Vector3(),
          captureQuat: new Quaternion(),
          captureLocalT: 0,
          mode: 'dynamic', // not yet captured — the per-frame loop below captures it on first pass
          entryStagger: Math.random(),
          wobblePhase: randRange(0, TAU),
          wobbleSpeed: randRange(...WOBBLE_SPEED_RANGE),
        })
      })
    })
    return items
  }

  function releaseItem(item) {
    if (item.mode !== 'kinematic') return
    const mesh = letterRefs.current[item.letterIndex]
    if (mesh) {
      mesh.setBodyType(RigidBodyType.Dynamic, true)
      mesh.setLinvel({ x: randRange(...RELEASE_LINVEL_RANGE), y: 0, z: randRange(...RELEASE_LINVEL_RANGE) }, true)
      mesh.setAngvel(
        { x: randRange(...RELEASE_ANGVEL_RANGE), y: randRange(...RELEASE_ANGVEL_RANGE), z: randRange(...RELEASE_ANGVEL_RANGE) },
        true
      )
    }
    item.mode = 'dynamic'
    letterInUseRef.current[item.letterIndex] = false
  }

  useFrame((state) => {
    progressRef.current += (progressTargetRef.current - progressRef.current) * PROGRESS_SMOOTHING
    const progress = progressRef.current
    const build = buildRef.current

    if (progress < MIN_PROGRESS_TO_BUILD) {
      // Untouched: let the pile settle with nothing captured, and forget any
      // previous selection so scrolling back down starts a clean rise.
      for (const item of build.items) releaseItem(item)
      build.wordIndex = -1
      build.items = []
      return
    }

    // 4 word steps + 1 finale step, sharing the timeline in equal slices.
    const stepCount = WORDS.length + 1
    const finaleIndex = stepCount - 1
    const segmentLength = 1 / stepCount
    const activeWordIndex = Math.min(finaleIndex, Math.floor(progress * stepCount))
    const segStart = activeWordIndex * segmentLength
    const localT = clamp01((progress - segStart) / segmentLength)
    const isFinale = activeWordIndex === finaleIndex

    if (build.wordIndex !== activeWordIndex) {
      for (const item of build.items) releaseItem(item)
      build.wordIndex = activeWordIndex
      const lines = isFinale ? FINALE_LINES : [WORDS[activeWordIndex].toLowerCase()]
      build.items = selectLetters(lines, state.camera)
    }

    const t = state.clock.elapsedTime
    // The finale is the sequence's concluding state — it rises and holds,
    // never releasing back to the pile on its own (only a reversal past its
    // segment boundary forces a release, via the word-change branch above).
    const desiredKinematic = isFinale || localT < RELEASE_AT

    for (const item of build.items) {
      const mesh = letterRefs.current[item.letterIndex]
      if (!mesh) continue

      if (desiredKinematic && item.mode !== 'kinematic') {
        // Capture wherever the letter currently is — whether resting in the
        // pile (fresh word) or mid-fall (a reversal catching it) — and start
        // the rise from exactly that pose. No pop either way.
        const p = mesh.translation()
        const r = mesh.rotation()
        item.capturePos.set(p.x, p.y, p.z)
        item.captureQuat.set(r.x, r.y, r.z, r.w)
        item.captureLocalT = localT
        item.mode = 'kinematic'
        mesh.setLinvel({ x: 0, y: 0, z: 0 }, true)
        mesh.setAngvel({ x: 0, y: 0, z: 0 }, true)
        mesh.setBodyType(RigidBodyType.KinematicPositionBased, true)
      } else if (!desiredKinematic && item.mode === 'kinematic') {
        releaseItem(item)
      }

      if (item.mode === 'kinematic') {
        const span = Math.abs(localT - item.captureLocalT)
        const raw = clamp01(span / RISE_SPAN)
        const staggered = clamp01((raw - item.entryStagger * STAGGER) / (1 - STAGGER))
        const eased = easeOutCubic(staggered)
        const wobble = Math.sin(t * item.wobbleSpeed + item.wobblePhase) * WOBBLE_AMPLITUDE * eased

        dummyQuat.copy(item.captureQuat).slerp(item.targetQuat, eased)
        mesh.setNextKinematicTranslation({
          x: lerp(item.capturePos.x, item.targetPos.x, eased),
          y: lerp(item.capturePos.y, item.targetPos.y, eased) + wobble,
          z: lerp(item.capturePos.z, item.targetPos.z, eased),
        })
        mesh.setNextKinematicRotation({ x: dummyQuat.x, y: dummyQuat.y, z: dummyQuat.z, w: dummyQuat.w })
      }
      // else: released — physics owns it entirely, no scripted control.
    }
  })

  return (
    <Physics gravity={[0, GRAVITY_Y, 0]}>
      <WordCycleScrollControl progressTargetRef={progressTargetRef} />
      <DragThrowControl activeDragRef={activeDragRef} letterRefs={letterRefs} />
      <CameraAim target={[0, FLOOR_Y + 1, 0]} />
      <RigidBody type="fixed" position={[0, FLOOR_Y, 0]} restitution={FLOOR_RESTITUTION} friction={0.9}>
        <CuboidCollider args={[WALL_HALF_WIDTH, FLOOR_HALF_THICKNESS, WALL_HALF_DEPTH]} />
      </RigidBody>
      <Walls />
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
              // Ignore pokes on a letter the word-builder currently owns —
              // don't want a click yanking it out of the kinematic formation.
              const owningItem = buildRef.current.items.find((it) => it.letterIndex === i)
              if (owningItem && owningItem.mode === 'kinematic') return

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

export default function Type04() {
  return (
    <>
      <SceneCanvas orbitControls={false}>
        <FallingLetters />
      </SceneCanvas>
      <Hint text="scroll" dismissOn={['wheel', 'touchmove']} />
    </>
  )
}
