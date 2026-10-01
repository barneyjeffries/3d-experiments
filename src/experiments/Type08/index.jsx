import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'

// Portfolio prototype, take two (compare Type07, where the cards float in
// place). Here the projects are a vertical column that scrolling carries
// upward: each card rises from the depths, through the surface, to a featured
// spot above the water, then on up and out of frame as the next one arrives.
// A card is invisible underwater and fades in from the waterline up as it
// emerges; passing through the surface, it sends out ripples.
//
// Self-contained like the other experiments — the ocean is Type06/07's.

// Placeholder content — swap for real projects.
const PROJECTS = [
  { id: 'tidal-index', title: 'Tidal Index', discipline: 'Brand identity', year: 2025, hue: 200 },
  { id: 'north-light', title: 'North Light', discipline: 'Web design', year: 2025, hue: 30 },
  { id: 'paper-harbour', title: 'Paper Harbour', discipline: 'Editorial', year: 2024, hue: 340 },
  { id: 'signal-noise', title: 'Signal & Noise', discipline: 'Creative code', year: 2024, hue: 150 },
  { id: 'lowland', title: 'Lowland', discipline: 'Art direction', year: 2023, hue: 260 },
  { id: 'afterglow', title: 'Afterglow', discipline: 'Motion', year: 2023, hue: 10 },
].map((project, i) => ({ ...project, number: String(i + 1).padStart(2, '0') }))

const BACKGROUND_COLOR = '#05090d'
const TROUGH_COLOR = [0.09, 0.19, 0.27] // raw RGB, same convention as Type05/06
const CREST_COLOR = [0.9, 0.95, 0.96]
const TROUGH_ALPHA = 0.35
const HEIGHT_RANGE = 0.8

// Surface — Type06's extent and points grid (the camera doesn't travel here).
const SURFACE_HALF_WIDTH = 34
const SURFACE_NEAR_Z = 10
const SURFACE_FAR_Z = -30
const EDGE_FADE_START = 0.75
const DISTANCE_FADE_NEAR = 12
const DISTANCE_FADE_FAR = 36
const POINT_GRID = { cols: 272, rows: 151 }
const POINT_SIZE = 38 // gl_PointSize numerator before the /distance falloff
// Points are fill-rate bound, so cap DPR as Type06's points mode does.
const DPR_RANGE = [1, 1.5]

// Same Gerstner set as Type06: [dirX, dirZ, wavelength, calmSteepness, roughSteepness].
const WAVES = [
  [0.15, 1, 18, 0.1, 0.22],
  [-0.45, 1, 11, 0.07, 0.18],
  [0.7, 0.7, 6.5, 0.03, 0.17],
  [-0.9, 0.45, 4.2, 0.02, 0.14],
  [0.35, -0.6, 2.7, 0.01, 0.12],
  [1, 0.15, 1.8, 0.005, 0.1],
]
const WAVE_TERMS = WAVES.map(([dx, dz, wavelength, calm, rough]) => {
  const len = Math.hypot(dx, dz)
  const k = (Math.PI * 2) / wavelength
  return { dx: dx / len, dz: dz / len, k, speed: Math.sqrt(9.8 / k), calm, rough }
})
const TIME_SCALE = 0.55
const TURBULENCE = 0.3

// The column of cards. Scroll position is measured in cards: at position p,
// card i sits (p - i) spacings above the featured height — so card `p` is
// featured, the next one is a spacing below (underwater, unseen), and the
// previous one a spacing above (out of the top of the frame).
const CARD_WIDTH = 2.4
const CARD_HEIGHT = 3
const CARD_TEXTURE_SIZE = [480, 600] // same 4:5 aspect as the card
const CARD_FILL_COLOR = '#0b1117'
const CARD_BORDER_COLOR = 'rgba(230, 240, 242, 0.85)'
const COLUMN_X = 2.6 // right of centre on a landscape screen, clear of the list; centred (0) on a portrait one
const COLUMN_Z = -2
const FEATURED_Y = 2.6 // card centre when featured — its bottom edge sits just over a unit above the water
const CARD_SPACING = 6 // more than the visible height above the water, so only one card is up at a time
const CULL_ABOVE_Y = 9 // a card whose bottom is above this is out of frame; skip drawing it
// Fade: each part of a card is invisible at the waterline and fully opaque
// this far above it — so a card fades in from the top down as it emerges,
// and is solid once it has cleared the water.
const FADE_HEIGHT = 1

// Scroll -> column position. Wheel/touch input accumulates into a target
// (clamped to the first..last card), which the frame loop eases toward — the
// same shape as Type03/04's scroll handling. Shortly after input stops, the
// target settles onto a card, so a project always comes to rest featured
// rather than half-submerged. The settle is directional: any scroll past
// SNAP_COMMIT (as a fraction of a card) carries on to the next card in that
// direction, rather than needing to pass the halfway point — otherwise a
// couple of wheel notches would just spring back.
const SCROLL_PER_CARD = 400 // wheel deltaY units to advance one card
const SNAP_COMMIT = 0.15
const MAX_WHEEL_DELTA = 120 // clamps a single fast fling
const TOUCH_SCROLL_GAIN = 2.5
const SCROLL_EASE = 5 // exponential ease rate toward the target, per second
const SNAP_DELAY_MS = 160
const SNAP_EASE = 0.12
const INTRO_START_POSITION = -1 // starts one card below, so the first project rises through the water on load

// Water displaced by a card passing through the surface (Type06's dome +
// ripples). Ripples: a ring when the top edge breaks the surface, a steady
// wake of smaller rings while the card is passing through it, and one more
// as the bottom edge leaves — each scaled by how fast the card is moving.
const DOME_PEAK = 0.25
const DOME_RADIUS = 1.4
const DOME_REFERENCE_SPEED = 3
const RIPPLE_COUNT = 8
const RIPPLE_SPEED = 3.5
const RIPPLE_WAVELENGTH = 1.6
const RIPPLE_WIDTH = 1.8
const RIPPLE_SPREAD = 0.6 // stronger falloff than Type06/07: the column is close to the camera, and rings reaching the foreground read large
const RIPPLE_DECAY = 0.55
const RIPPLE_BASE = 0.05 // so even a slow crossing is visible
const RIPPLE_GAIN = 0.008 // extra amplitude per unit of speed
const RIPPLE_MAX = 0.11 // kept low — top ring, wake and bottom ring overlap, and their heights add up
const RIPPLE_COOLDOWN = 0.25
const WAKE_INTERVAL = 0.4 // seconds between wake rings while a card is passing through
const WAKE_MIN_SPEED = 0.4 // a card resting in the surface doesn't keep rippling
const WAKE_STRENGTH = 0.5 // wake rings, relative to an edge-crossing ring

// Camera — Type06's floating viewpoint.
const CAMERA_POSITION = [0, 3.2, 12]
const LOOK_AT = [0, 0, -6]
const BOB_AMPLITUDE = 0.12
const BOB_SPEED = 0.45
const PARALLAX_X = 1.2
const PARALLAX_Y = 0.5
const PARALLAX_LERP = 0.03

const WATER_VERTEX_SHADER = /* glsl */ `
  #define WAVE_COUNT ${WAVES.length}
  #define OBJECT_COUNT ${PROJECTS.length}
  #define RIPPLE_COUNT ${RIPPLE_COUNT}
  uniform float uTime;
  uniform float uTurbulence;
  uniform vec4 uWaves[WAVE_COUNT]; // xy = direction, z = wavelength, w = calm steepness
  uniform float uRoughSteepness[WAVE_COUNT];
  uniform float uHalfWidth;
  uniform float uEdgeFadeStart;
  uniform float uFadeNear;
  uniform float uFadeFar;
  uniform float uClock;
  uniform vec3 uObjects[OBJECT_COUNT]; // xy = position on the water (x, z), z = dome height
  uniform float uDomeRadius;
  uniform vec4 uRipples[RIPPLE_COUNT]; // xy = origin, z = start clock, w = strength (0 = unused)
  uniform float uRippleSpeed;
  uniform float uRippleK;
  uniform float uRippleWidth;
  uniform float uRippleDecay;
  uniform float uRippleSpread;
  uniform float uPointSize;
  uniform float uPixelRatio;
  varying float vHeight;
  varying float vAlpha;

  void main() {
    vec2 xz = position.xz;
    vec3 p = position;
    for (int i = 0; i < WAVE_COUNT; i++) {
      vec4 w = uWaves[i];
      vec2 dir = normalize(w.xy);
      float k = 6.28318530718 / w.z;
      float speed = sqrt(9.8 / k);
      float f = k * (dot(dir, xz) - speed * uTime);
      float a = mix(w.w, uRoughSteepness[i], uTurbulence) / k;
      float c = cos(f);
      p.x += dir.x * a * c;
      p.z += dir.y * a * c;
      p.y += a * sin(f);
    }

    for (int i = 0; i < OBJECT_COUNT; i++) {
      vec3 obj = uObjects[i];
      if (obj.z == 0.0) continue;
      vec2 offset = xz - obj.xy;
      p.y += obj.z * exp(-dot(offset, offset) / (uDomeRadius * uDomeRadius));
    }
    for (int i = 0; i < RIPPLE_COUNT; i++) {
      vec4 ripple = uRipples[i];
      float age = uClock - ripple.z;
      if (ripple.w <= 0.0 || age < 0.0) continue;
      float travelled = uRippleSpeed * age;
      float d = distance(xz, ripple.xy) - travelled;
      float envelope = exp(-(d * d) / (uRippleWidth * uRippleWidth)) * exp(-age * uRippleDecay)
        / (1.0 + uRippleSpread * travelled);
      p.y += ripple.w * envelope * cos(d * uRippleK);
    }
    vHeight = p.y;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float dist = -mvPosition.z;

    float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, 1.0, abs(xz.x) / uHalfWidth);
    vAlpha = edgeFade * (1.0 - smoothstep(uFadeNear, uFadeFar, dist));
    gl_PointSize = uPointSize * uPixelRatio / dist;
  }
`

const WATER_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uTroughColor;
  uniform vec3 uCrestColor;
  uniform float uTroughAlpha;
  uniform float uHeightRange;
  varying float vHeight;
  varying float vAlpha;

  void main() {
    float h = smoothstep(-uHeightRange, uHeightRange, vHeight);
    vec3 color = mix(uTroughColor, uCrestColor, h);
    float alpha = vAlpha * mix(uTroughAlpha, 1.0, h);
    alpha *= smoothstep(0.5, 0.3, length(gl_PointCoord - vec2(0.5))); // soft round dot
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

// Card: its cover texture, faded per fragment by height above the waterline
// (uWaterPlane — the local water surface as a plane, refitted every frame).
const CARD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const CARD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec4 uWaterPlane; // xyz = normal, w = constant: signed height above the water = dot(n, p) + w
  uniform float uFadeHeight;
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    float above = dot(uWaterPlane.xyz, vWorldPosition) + uWaterPlane.w;
    float alpha = smoothstep(0.0, uFadeHeight, above);
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(texture2D(uMap, vUv).rgb, alpha);
  }
`

// Swell height at (x, z) — the shader's Gerstner sum, height term only.
function swellHeight(x, z, time, turbulence) {
  let y = 0
  for (const w of WAVE_TERMS) {
    const steepness = w.calm + (w.rough - w.calm) * turbulence
    y += (steepness / w.k) * Math.sin(w.k * (w.dx * x + w.dz * z - w.speed * time))
  }
  return y
}

// A flat XZ grid of points (displaced in the shader).
function buildPointGrid({ cols, rows }) {
  const positions = new Float32Array(cols * rows * 3)
  for (let r = 0; r < rows; r++) {
    const z = SURFACE_FAR_Z + ((SURFACE_NEAR_Z - SURFACE_FAR_Z) * r) / (rows - 1)
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3
      positions[i] = -SURFACE_HALF_WIDTH + (2 * SURFACE_HALF_WIDTH * c) / (cols - 1)
      positions[i + 2] = z
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

// Placeholder cover (as Type07's, plus a drawn border): a tinted "image"
// area, then the number, title and meta. Swap for real imagery by loading a
// texture instead.
function drawCoverTexture(project) {
  const [w, h] = CARD_TEXTURE_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const pad = 28
  const imageHeight = h * 0.62

  ctx.fillStyle = CARD_FILL_COLOR
  ctx.fillRect(0, 0, w, h)

  const gradient = ctx.createLinearGradient(pad, pad, w - pad, pad + imageHeight)
  gradient.addColorStop(0, `hsl(${project.hue} 45% 42%)`)
  gradient.addColorStop(1, `hsl(${project.hue + 40} 50% 16%)`)
  ctx.fillStyle = gradient
  ctx.fillRect(pad, pad, w - pad * 2, imageHeight)

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
  ctx.lineWidth = 2
  for (let y = pad + imageHeight * 0.55; y < pad + imageHeight; y += 14) {
    ctx.beginPath()
    ctx.moveTo(pad, y)
    ctx.lineTo(w - pad, y)
    ctx.stroke()
  }

  ctx.fillStyle = 'rgba(244, 244, 240, 0.9)'
  ctx.font = '500 22px ui-monospace, Menlo, monospace'
  ctx.fillText(project.number, pad + 18, pad + 38)
  ctx.fillStyle = '#f4f4f0'
  ctx.font = '600 44px system-ui, sans-serif'
  ctx.fillText(project.title, pad, pad + imageHeight + 64)
  ctx.fillStyle = 'rgba(244, 244, 240, 0.55)'
  ctx.font = '400 20px ui-monospace, Menlo, monospace'
  ctx.fillText(`${project.discipline} · ${project.year}`, pad, pad + imageHeight + 102)

  ctx.strokeStyle = CARD_BORDER_COLOR
  ctx.lineWidth = 3
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3)

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

// Owns the scroll state (a plain mutable object in `scroll`, never rendered
// through React): listens for input, and each frame eases the column position
// toward its target and reports when the featured project changes.
function ScrollDriver({ scroll, onActiveChange }) {
  useEffect(() => {
    const s = scroll.current
    const lastIndex = PROJECTS.length - 1

    const nudge = (cards) => {
      s.target = Math.min(lastIndex, Math.max(0, s.target + cards))
      s.lastInput = performance.now()
      s.snapTo = null
    }
    const step = (direction) => {
      s.target = Math.min(lastIndex, Math.max(0, s.anchor + direction))
      s.anchor = s.target
      s.lastInput = performance.now()
      s.snapTo = null
    }

    const handleWheel = (event) => {
      nudge(Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, event.deltaY)) / SCROLL_PER_CARD)
    }
    let lastTouchY = null
    const handleTouchStart = (event) => {
      lastTouchY = event.touches[0]?.clientY ?? null
    }
    const handleTouchMove = (event) => {
      if (lastTouchY === null) return
      const y = event.touches[0]?.clientY ?? lastTouchY
      nudge(((lastTouchY - y) * TOUCH_SCROLL_GAIN) / SCROLL_PER_CARD) // dragging up == scrolling down
      lastTouchY = y
    }
    const handleKey = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'PageDown') step(1)
      else if (event.key === 'ArrowUp' || event.key === 'PageUp') step(-1)
    }

    // On window, not the canvas: the list overlays the canvas, and scrolling
    // over it should still drive the column. The page itself never scrolls.
    window.addEventListener('wheel', handleWheel, { passive: true })
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: true })
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('keydown', handleKey)
    }
  }, [scroll])

  useFrame((state, delta) => {
    const s = scroll.current
    const dt = Math.min(delta, 1 / 30)

    if (performance.now() - s.lastInput > SNAP_DELAY_MS) {
      if (s.snapTo === null) {
        // Pick where to settle, once per gesture: `anchor` is the card we
        // were resting on before this scroll began.
        const moved = s.target - s.anchor
        const cards = Math.abs(moved) < SNAP_COMMIT ? 0 : Math.max(1, Math.round(Math.abs(moved)))
        s.snapTo = Math.min(PROJECTS.length - 1, Math.max(0, s.anchor + Math.sign(moved) * cards))
        s.anchor = s.snapTo
      }
      s.target += (s.snapTo - s.target) * SNAP_EASE
    }
    const previous = s.position
    s.position += (s.target - s.position) * (1 - Math.exp(-SCROLL_EASE * dt))
    s.velocity = (s.position - previous) / dt

    const active = Math.min(PROJECTS.length - 1, Math.max(0, Math.round(s.position)))
    if (active !== s.active) {
      s.active = active
      onActiveChange(active)
    }
  })

  return null
}

// `water` holds the uniforms Cards write (object domes, ripples) and the
// surface's shader reads.
function OceanSurface({ water }) {
  const uniforms = useMemo(
    () => ({
      ...water,
      uTime: { value: 0 },
      uTurbulence: { value: TURBULENCE },
      uWaves: { value: WAVES.map(([dx, dz, wavelength, calm]) => new Vector4(dx, dz, wavelength, calm)) },
      uRoughSteepness: { value: WAVES.map((w) => w[4]) },
      uHalfWidth: { value: SURFACE_HALF_WIDTH },
      uEdgeFadeStart: { value: EDGE_FADE_START },
      uFadeNear: { value: DISTANCE_FADE_NEAR },
      uFadeFar: { value: DISTANCE_FADE_FAR },
      uTroughColor: { value: new Vector3(...TROUGH_COLOR) },
      uCrestColor: { value: new Vector3(...CREST_COLOR) },
      uTroughAlpha: { value: TROUGH_ALPHA },
      uHeightRange: { value: HEIGHT_RANGE },
      uDomeRadius: { value: DOME_RADIUS },
      uRippleSpeed: { value: RIPPLE_SPEED },
      uRippleK: { value: (Math.PI * 2) / RIPPLE_WAVELENGTH },
      uRippleWidth: { value: RIPPLE_WIDTH },
      uRippleDecay: { value: RIPPLE_DECAY },
      uRippleSpread: { value: RIPPLE_SPREAD },
      uPointSize: { value: POINT_SIZE },
      uPixelRatio: { value: 1 },
    }),
    [water]
  )

  const geometry = useMemo(() => buildPointGrid(POINT_GRID), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms,
        vertexShader: WATER_VERTEX_SHADER,
        fragmentShader: WATER_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      }),
    [uniforms]
  )

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime * TIME_SCALE
    uniforms.uClock.value = state.clock.elapsedTime
    uniforms.uPixelRatio.value = state.gl.getPixelRatio()
  })

  // frustumCulled off: the grid's bounding box is computed flat, and the
  // shader displaces vertices outside it.
  return <points geometry={geometry} material={material} frustumCulled={false} />
}

// One project card. Its height comes straight from the scroll position; this
// component just places it, fits its fade to the local waterline, and turns
// its passage through the surface into a dome and ripples.
function Card({ project, index, scroll, water, emitRipple }) {
  const meshRef = useRef(null)
  const geometry = useMemo(() => new PlaneGeometry(CARD_WIDTH, CARD_HEIGHT), [])
  const { texture, material } = useMemo(() => {
    const cover = drawCoverTexture(project)
    return {
      texture: cover,
      material: new ShaderMaterial({
        uniforms: {
          uMap: { value: cover },
          uWaterPlane: { value: new Vector4(0, 1, 0, 0) },
          uFadeHeight: { value: FADE_HEIGHT },
        },
        vertexShader: CARD_VERTEX_SHADER,
        fragmentShader: CARD_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      }),
    }
  }, [project])

  useEffect(
    () => () => {
      geometry.dispose()
      texture.dispose()
      material.dispose()
    },
    [geometry, texture, material]
  )

  const track = useRef({ prevTop: null, prevBottom: null, lastRipple: -Infinity })
  const waterNormal = useMemo(() => new Vector3(), [])

  useFrame((state) => {
    const s = scroll.current
    const t = track.current
    const clock = state.clock.elapsedTime
    const time = clock * TIME_SCALE

    const x = state.size.width < state.size.height ? 0 : COLUMN_X
    const z = COLUMN_Z
    const y = FEATURED_Y + (s.position - index) * CARD_SPACING
    const vy = s.velocity * CARD_SPACING

    const surface = swellHeight(x, z, time, TURBULENCE)
    const top = y + CARD_HEIGHT / 2 - surface
    const bottom = y - CARD_HEIGHT / 2 - surface
    const passing = top > 0 && bottom < 0
    const speed = Math.abs(vy)

    // Ripples: on either edge crossing the surface, and as a wake while the
    // card is passing through it.
    if (t.prevTop !== null && clock - t.lastRipple > RIPPLE_COOLDOWN) {
      const crossed = Math.sign(top) !== Math.sign(t.prevTop) || Math.sign(bottom) !== Math.sign(t.prevBottom)
      const wake = passing && speed > WAKE_MIN_SPEED && clock - t.lastRipple > WAKE_INTERVAL
      if (crossed || wake) {
        const strength = Math.min(RIPPLE_MAX, RIPPLE_BASE + speed * RIPPLE_GAIN)
        emitRipple(x, z, clock, crossed ? strength : strength * WAKE_STRENGTH)
        t.lastRipple = clock
      }
    }
    t.prevTop = top
    t.prevBottom = bottom

    // Dome: water lifted (or drawn down) around the card while it's in the
    // surface, by its direction and speed of travel.
    const dome = passing ? DOME_PEAK * Math.min(1, Math.max(-0.6, vy / DOME_REFERENCE_SPEED)) : 0
    water.uObjects.value[index].set(x, z, dome)

    // Waterline for the fade: the local surface as a plane — normal
    // (-dh/dx, 1, -dh/dz), through the swell height plus the dome.
    const e = 0.6
    const dhdx = (swellHeight(x + e, z, time, TURBULENCE) - swellHeight(x - e, z, time, TURBULENCE)) / (2 * e)
    const dhdz = (swellHeight(x, z + e, time, TURBULENCE) - swellHeight(x, z - e, time, TURBULENCE)) / (2 * e)
    waterNormal.set(-dhdx, 1, -dhdz).normalize()
    material.uniforms.uWaterPlane.value.set(
      waterNormal.x,
      waterNormal.y,
      waterNormal.z,
      -(waterNormal.x * x + waterNormal.y * (surface + dome) + waterNormal.z * z)
    )

    const mesh = meshRef.current
    mesh.position.set(x, y, z)
    mesh.rotation.y = Math.atan2(CAMERA_POSITION[0] - x, CAMERA_POSITION[2] - z) // face the camera
    mesh.visible = top > 0 && y - CARD_HEIGHT / 2 < CULL_ABOVE_Y
  })

  // renderOrder 1: drawn after the (also transparent) water, so a card covers
  // the dots behind it rather than being sorted against them.
  return <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={1} />
}

function CameraRig() {
  const parallax = useRef(new Vector2())

  useFrame((state) => {
    const t = state.clock.elapsedTime
    parallax.current.lerp(state.pointer, PARALLAX_LERP)
    state.camera.position.set(
      CAMERA_POSITION[0] + parallax.current.x * PARALLAX_X,
      CAMERA_POSITION[1] + parallax.current.y * PARALLAX_Y + Math.sin(t * BOB_SPEED) * BOB_AMPLITUDE,
      CAMERA_POSITION[2]
    )
    state.camera.lookAt(...LOOK_AT)
  })

  return null
}

// Page chrome for this experiment only — a <style> block (as in Type07) for
// the hover/focus states and the portrait breakpoint, which matches Card's
// portrait column position.
const STYLES = `
  /* Darkens the sea on the list's side, so text never sits over bright crests. */
  .t08-scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    background: linear-gradient(to right, rgba(5, 9, 13, 0.85), rgba(5, 9, 13, 0) 42%);
  }
  .t08-list {
    position: fixed;
    left: 1.5rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    color: #f4f4f0;
    font-family: system-ui, sans-serif;
  }
  .t08-kicker, .t08-num, .t08-meta {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
  }
  .t08-kicker { color: rgba(244, 244, 240, 0.45); margin-bottom: 1rem; }
  .t08-list ul { list-style: none; display: flex; flex-direction: column; gap: 0.2rem; }
  .t08-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    padding: 0.3rem 0;
    color: rgba(244, 244, 240, 0.4);
    transition: color 0.3s ease, transform 0.3s ease;
  }
  .t08-item:hover { color: rgba(244, 244, 240, 0.75); }
  .t08-item.is-active { color: #f4f4f0; transform: translateX(0.4rem); }
  .t08-item:focus-visible { outline: 1px solid rgba(244, 244, 240, 0.5); outline-offset: 4px; }
  .t08-title { font-size: 1.35rem; font-weight: 500; }
  .t08-meta { opacity: 0.6; }

  @media (max-aspect-ratio: 1/1) {
    .t08-scrim { background: linear-gradient(to top, rgba(5, 9, 13, 0.9), rgba(5, 9, 13, 0) 45%); }
    .t08-list { top: auto; bottom: 3.75rem; transform: none; }
    .t08-title { font-size: 1.1rem; }
  }
`

export default function Type08() {
  const [activeIndex, setActiveIndex] = useState(0)

  const scroll = useRef({
    target: 0,
    position: INTRO_START_POSITION,
    velocity: 0,
    lastInput: -Infinity,
    active: 0,
    anchor: 0, // the card last settled on
    snapTo: null, // where the current settle is heading (null while input is live)
  })

  const water = useMemo(
    () => ({
      uClock: { value: 0 },
      uObjects: { value: PROJECTS.map(() => new Vector3()) },
      uRipples: { value: Array.from({ length: RIPPLE_COUNT }, () => new Vector4()) },
    }),
    []
  )
  const rippleCursor = useRef(0)
  const emitRipple = useCallback(
    (x, z, clock, strength) => {
      water.uRipples.value[rippleCursor.current].set(x, z, clock, strength)
      rippleCursor.current = (rippleCursor.current + 1) % RIPPLE_COUNT
    },
    [water]
  )

  const jumpTo = (index) => {
    scroll.current.target = index
    scroll.current.anchor = index
    scroll.current.snapTo = null
    scroll.current.lastInput = performance.now()
  }

  return (
    <>
      <style>{STYLES}</style>
      <SceneCanvas
        cameraPosition={CAMERA_POSITION}
        fov={50}
        orbitControls={false}
        background={BACKGROUND_COLOR}
        dpr={DPR_RANGE}
        ambientOcclusion={false}
      >
        <ScrollDriver scroll={scroll} onActiveChange={setActiveIndex} />
        <OceanSurface water={water} />
        {PROJECTS.map((project, i) => (
          <Card key={project.id} project={project} index={i} scroll={scroll} water={water} emitRipple={emitRipple} />
        ))}
        <CameraRig />
      </SceneCanvas>

      <div className="t08-scrim" />
      <nav className="t08-list">
        <p className="t08-kicker">selected work</p>
        <ul>
          {PROJECTS.map((project, i) => (
            <li key={project.id}>
              <button
                type="button"
                className={`t08-item${activeIndex === i ? ' is-active' : ''}`}
                aria-current={activeIndex === i ? 'true' : undefined}
                onClick={() => jumpTo(i)}
              >
                <span className="t08-num">{project.number}</span>
                <span className="t08-title">{project.title}</span>
                <span className="t08-meta">{project.year}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <Hint text="scroll" dismissOn={['wheel', 'touchmove', 'keydown']} dark />
    </>
  )
}
