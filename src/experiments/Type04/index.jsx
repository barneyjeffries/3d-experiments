import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Instances, Instance } from '@react-three/drei'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'
import { useFont, useTextGeometries } from '../../shared/useTypographyGeometries'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

// Anagrams of "everything moves" — fixed sequence, hardcoded on purpose (not
// generated) so the words themselves stay authored and swappable in one place.
const WORDS = ['MOVES', 'SHIVER', 'GROVES', 'NERVES']

const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015
const BASE_COLOR = '#fcfcfa'
const ACCENT_COLOR = '#7fff00'
const LETTER_GAP = 0.14

// Scroll -> timeline. Raw wheel/touch input accumulates into a 0..1 target,
// which the frame loop damps toward — that damping is the "smooth" in smooth
// scroll, decoupled from the per-letter easing curves below.
const TOTAL_SCROLL_DISTANCE = 8000 // wheel deltaY units for the full 4-word sequence
const MAX_WHEEL_DELTA = 120 // clamps a single fast fling so a trackpad flick can't skip a word
const PROGRESS_SMOOTHING = 0.1 // per-frame damping of the displayed timeline position

// Each word gets an equal slice of the timeline, split into fly-in / hold / fall-away.
const ENTRY_FRAC = 0.32 // fraction of a word's segment spent flying in
const EXIT_FRAC = 0.32 // fraction spent falling away (hold fills the remainder)
const STAGGER = 0.45 // fraction of each phase's duration spread across per-letter start delays

// Fly-in origin: deep in the background, scattered wide, tumbled.
const SCATTER_IN_X = [-6, 6]
const SCATTER_IN_Y = [-4, 4]
const SCATTER_IN_Z = [-15, -9]

// Fall-away destination: dropped well below frame, scattered wide, tumbled.
const SCATTER_OUT_X = [-7, 7]
const SCATTER_OUT_Y = [-14, -8]
const SCATTER_OUT_Z = [-3, 3]

const WOBBLE_AMPLITUDE = 0.035 // subtle idle life while a word holds formed
const WOBBLE_SPEED_RANGE = [0.3, 0.7]

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

function easeInCubic(t) {
  return t * t * t
}

// Centers a word's letters in a row, spacing by each glyph's actual bounding-box
// width (post-`.center()`, so TextGeometry has already computed it) rather than
// a fixed pitch — keeps mixed glyph widths (e.g. "I" vs "M") from looking uneven.
function layoutWord(word, geometries, gap) {
  const letters = word.split('')
  const widths = letters.map((ch) => {
    const box = geometries[ch].boundingBox
    return box.max.x - box.min.x
  })
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + gap * (letters.length - 1)
  let cursor = -totalWidth / 2
  const positions = []
  for (let i = 0; i < letters.length; i++) {
    positions.push(cursor + widths[i] / 2)
    cursor += widths[i] + gap
  }
  return { letters, positions }
}

// Captures wheel/touch input and accumulates a 0..1 scroll target — the only
// consumer of scroll here, so the page itself never scrolls.
function ScrollProgressControl({ progressTargetRef }) {
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

function AnagramSequence() {
  const font = useFont(fontUrl)
  const chars = useMemo(() => [...new Set(WORDS.join('').split(''))], [])
  const geometries = useTextGeometries(font, chars, {
    size: GLYPH_SIZE,
    height: EXTRUDE_DEPTH,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
  })

  // One flat list across all four words — each entry carries its own segment,
  // formed target, entry/exit scatter poses, and per-letter stagger/wobble seeds.
  // Built once (positions are deterministic thereafter) so scroll progress is
  // the only thing driving motion, which is what makes reversing it clean.
  const letters = useMemo(() => {
    const list = []
    let flatIndex = 0
    WORDS.forEach((word, wordIndex) => {
      const { letters: wordLetters, positions } = layoutWord(word, geometries, LETTER_GAP)
      // A couple of accent letters per word, symmetric and never the first/last glyph.
      const greenIndices = new Set([1, wordLetters.length - 2].filter((i) => i > 0 && i < wordLetters.length - 1))
      wordLetters.forEach((char, i) => {
        list.push({
          flatIndex: flatIndex++,
          char,
          wordIndex,
          target: { x: positions[i], y: 0, z: 0 },
          scatterIn: {
            x: randRange(...SCATTER_IN_X),
            y: randRange(...SCATTER_IN_Y),
            z: randRange(...SCATTER_IN_Z),
            rot: [randRange(0, TAU), randRange(0, TAU), randRange(0, TAU)],
          },
          scatterOut: {
            x: randRange(...SCATTER_OUT_X),
            y: randRange(...SCATTER_OUT_Y),
            z: randRange(...SCATTER_OUT_Z),
            rot: [randRange(0, TAU), randRange(0, TAU), randRange(0, TAU)],
          },
          entryStagger: Math.random(),
          exitStagger: Math.random(),
          wobblePhase: randRange(0, TAU),
          wobbleSpeed: randRange(...WOBBLE_SPEED_RANGE),
          scale: randRange(0.92, 1.05),
          color: greenIndices.has(i) ? ACCENT_COLOR : BASE_COLOR,
        })
      })
    })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometries])

  const lettersByChar = useMemo(() => {
    const map = {}
    for (const char of chars) map[char] = []
    for (const letter of letters) map[letter.char].push(letter)
    return map
  }, [letters, chars])

  const meshRefs = useRef([])
  const progressTargetRef = useRef(0) // raw, instantly updated from scroll input
  const progressRef = useRef(0) // damped display value that actually drives the scene

  useFrame((state) => {
    progressRef.current += (progressTargetRef.current - progressRef.current) * PROGRESS_SMOOTHING
    const progress = progressRef.current
    const t = state.clock.elapsedTime
    const segmentLength = 1 / WORDS.length

    for (const letter of letters) {
      const mesh = meshRefs.current[letter.flatIndex]
      if (!mesh) continue

      const segStart = letter.wordIndex * segmentLength
      const localT = clamp01((progress - segStart) / segmentLength)

      let x, y, z, rx, ry, rz

      if (localT <= ENTRY_FRAC) {
        const rawT = localT / ENTRY_FRAC
        const staggered = clamp01((rawT - letter.entryStagger * STAGGER) / (1 - STAGGER))
        const eased = easeOutCubic(staggered)
        const from = letter.scatterIn
        x = lerp(from.x, letter.target.x, eased)
        y = lerp(from.y, letter.target.y, eased)
        z = lerp(from.z, letter.target.z, eased)
        rx = lerp(from.rot[0], 0, eased)
        ry = lerp(from.rot[1], 0, eased)
        rz = lerp(from.rot[2], 0, eased)
      } else if (localT >= 1 - EXIT_FRAC) {
        const rawT = (localT - (1 - EXIT_FRAC)) / EXIT_FRAC
        const staggered = clamp01((rawT - letter.exitStagger * STAGGER) / (1 - STAGGER))
        const eased = easeInCubic(staggered)
        const to = letter.scatterOut
        x = lerp(letter.target.x, to.x, eased)
        y = lerp(letter.target.y, to.y, eased)
        z = lerp(letter.target.z, to.z, eased)
        rx = lerp(0, to.rot[0], eased)
        ry = lerp(0, to.rot[1], eased)
        rz = lerp(0, to.rot[2], eased)
      } else {
        x = letter.target.x
        y = letter.target.y
        z = letter.target.z
        rx = ry = rz = 0
      }

      const wobble = Math.sin(t * letter.wobbleSpeed + letter.wobblePhase) * WOBBLE_AMPLITUDE
      mesh.position.set(x, y + wobble, z)
      mesh.rotation.set(rx, ry, rz)
    }
  })

  return (
    <>
      <ScrollProgressControl progressTargetRef={progressTargetRef} />
      {chars.map((char) => {
        const list = lettersByChar[char]
        if (!list.length) return null
        return (
          <Instances key={char} limit={list.length}>
            <primitive object={geometries[char]} attach="geometry" />
            <meshStandardMaterial color="#ffffff" roughness={0.85} metalness={0} />
            {list.map((letter) => (
              <Instance
                key={letter.flatIndex}
                ref={(el) => {
                  meshRefs.current[letter.flatIndex] = el
                  if (el) el.position.set(letter.scatterIn.x, letter.scatterIn.y, letter.scatterIn.z)
                }}
                scale={letter.scale}
                color={letter.color}
              />
            ))}
          </Instances>
        )
      })}
    </>
  )
}

export default function Type04() {
  return (
    <>
      <SceneCanvas cameraPosition={[0, 0.2, 8.5]} fov={42} orbitControls={false}>
        <AnagramSequence />
      </SceneCanvas>
      <Hint text="scroll" dismissOn={['wheel', 'touchmove']} />
    </>
  )
}
