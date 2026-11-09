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

// Type08's scrolling column of projects, plus what happens when you open one.
// Click the featured card (or its title, or Enter): the coloured image area
// of its cover grows to fill the screen, and gravity swings to the right —
// the sea pours sideways, each dot falling along its own curve, and pools
// against the right-hand edge as a band of water whose surface now faces
// left, its waves running up and down it. The project page fades in over the
// colour. Close (or Esc) runs it all backward: the water flows back out into
// the sea and the colour shrinks back into the card.
//
// Self-contained like the other experiments — the ocean is Type06/07/08's.

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
const COVER_PAD = 28 // px, around the cover's image area
const COVER_IMAGE_FRACTION = 0.62 // image area height, as a fraction of the texture's height
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
// Opening a project. `progress` runs 0 -> 1 over TRANSITION_SECONDS (and
// back on close); the colour fill and the water's flow are staggered slices
// of it, so closing is the exact reverse of opening.
const TRANSITION_SECONDS = 1.8
const FILL_SPAN = 0.55 // the fill grows over the first 55% of progress
const FLOW_DELAY = 0.12 // the water starts to pour just after the fill starts
const CARD_FADE_SPAN = 0.12 // the 3D card hands over to the fill over the first 12% of the fill
// The pooled water, in screen space (NDC: the screen spans -1..1 each way).
const POOL_BAND_WIDTH = 0.26 // how far in from the right edge the water's surface sits
const POOL_WAVE = 0.035 // height of the waves running along that surface
const POOL_POINT_SIZE = 3.2 // px, before device pixel ratio
const FULL_SCREEN_RECT = [-1, -1, 1, 1]

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
  uniform float uFlow; // 0 = sea, 1 = pooled on the right-hand edge
  uniform float uBandWidth;
  uniform float uPoolWave;
  uniform float uPoolPointSize;
  uniform float uNearZ;
  uniform float uFarZ;
  uniform float uHeightRange; // shared with the fragment shader: the pool sets vHeight within this range
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

    // Project transition: gravity swings to the right. Each dot travels from
    // where it is on screen to its place in the pool — the sea turned on its
    // side and pressed against the right edge: grid x becomes height up the
    // screen, grid depth becomes distance in from the water's surface.
    if (uFlow > 0.0) {
      vec2 from = gl_Position.xy / gl_Position.w;
      float jitter = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
      // Dots nearer the right edge (the new "floor") go first, so it pours
      // rather than all moving at once. Max delay 0.75, hence the 1.75 below:
      // every dot has arrived by uFlow = 1.
      float delay = (1.0 - clamp(from.x * 0.5 + 0.5, 0.0, 1.0)) * 0.6 + jitter * 0.15;
      float t = clamp(uFlow * 1.75 - delay, 0.0, 1.0);

      float depth = (uNearZ - position.z) / (uNearZ - uFarZ); // 0 = surface, 1 = deepest
      float y = (position.x / uHalfWidth) * 1.08 + (jitter - 0.5) * 0.01;
      float wave = (sin(y * 4.0 + uClock * 1.1) * 0.6 + sin(y * 9.0 - uClock * 1.7) * 0.3
        + sin(y * 17.0 + uClock * 2.3) * 0.12) * uPoolWave;
      // Waves die away with depth, like real water; deeper layers sit
      // further right, the deepest two-thirds off-screen.
      float x = 1.0 - uBandWidth + wave * exp(-depth * 6.0) + depth * uBandWidth * 3.0;

      // Falling sideways: x eases in (accelerating toward the new floor)
      // while y eases out, so each dot's path arcs over to the right.
      vec2 ndc = vec2(mix(from.x, x, t * t), mix(from.y, y, 1.0 - (1.0 - t) * (1.0 - t)));
      gl_Position.xy = ndc * gl_Position.w;
      gl_PointSize = mix(gl_PointSize, uPoolPointSize * uPixelRatio, t);
      // Pooled: bright at the surface, fading with depth.
      vAlpha = mix(vAlpha, 1.0 - smoothstep(0.0, 0.35, depth) * 0.85, t);
      vHeight = mix(vHeight, mix(uHeightRange, -uHeightRange, smoothstep(0.0, 0.12, depth)), t);
    }
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
  uniform float uOpacity; // fades the card out as the project fill takes over from it
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    float above = dot(uWaterPlane.xyz, vWorldPosition) + uWaterPlane.w;
    float alpha = smoothstep(0.0, uFadeHeight, above) * uOpacity;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(texture2D(uMap, vUv).rgb, alpha);
  }
`

// Project fill: a quad placed directly in screen space (uRect, in NDC), showing
// the project's fill texture (its cover's image-area gradient) — so it starts
// exactly over the card's image and grows to fill the screen. Drawn first (renderOrder -1, no
// depth test), so the water still draws over it.
const FILL_VERTEX_SHADER = /* glsl */ `
  uniform vec4 uRect; // xy = bottom-left, zw = top-right
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(mix(uRect.xy, uRect.zw, position.xy * 0.5 + 0.5), 0.0, 1.0);
  }
`

const FILL_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;

  void main() {
    gl_FragColor = vec4(texture2D(uMap, vUv).rgb, 1.0);
  }
`

// The cover's image area, in texture UVs (flipped: v runs bottom-up), and its
// corners in the card's local space — where the fill starts from.
const COVER_UV_RECT = [
  COVER_PAD / CARD_TEXTURE_SIZE[0],
  1 - COVER_PAD / CARD_TEXTURE_SIZE[1] - COVER_IMAGE_FRACTION,
  1 - COVER_PAD / CARD_TEXTURE_SIZE[0],
  1 - COVER_PAD / CARD_TEXTURE_SIZE[1],
]
const COVER_IMAGE_CORNERS = [
  [COVER_UV_RECT[0], COVER_UV_RECT[1]],
  [COVER_UV_RECT[2], COVER_UV_RECT[1]],
  [COVER_UV_RECT[0], COVER_UV_RECT[3]],
  [COVER_UV_RECT[2], COVER_UV_RECT[3]],
].map(([u, v]) => [(u - 0.5) * CARD_WIDTH, (v - 0.5) * CARD_HEIGHT])

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

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

function coverGradient(ctx, project, x0, y0, x1, y1) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  gradient.addColorStop(0, `hsl(${project.hue} 45% 42%)`)
  gradient.addColorStop(1, `hsl(${project.hue + 40} 50% 16%)`)
  return gradient
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
  const pad = COVER_PAD
  const imageHeight = h * COVER_IMAGE_FRACTION

  ctx.fillStyle = CARD_FILL_COLOR
  ctx.fillRect(0, 0, w, h)

  ctx.fillStyle = coverGradient(ctx, project, pad, pad, w - pad, pad + imageHeight)
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

// Clean version of the cover's image area — the same gradient, without the
// number and rules, which would balloon into a giant numeral and thick bars
// when stretched to fill the screen. The 3D card's fade-out covers the swap.
function drawFillTexture(project) {
  const [w, h] = [CARD_TEXTURE_SIZE[0] - COVER_PAD * 2, CARD_TEXTURE_SIZE[1] * COVER_IMAGE_FRACTION]
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = coverGradient(ctx, project, 0, 0, w, h)
  ctx.fillRect(0, 0, w, h)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}

// Owns the scroll state (a plain mutable object in `scroll`, never rendered
// through React): listens for input, and each frame eases the column position
// toward its target and reports when the featured project changes.
function ScrollDriver({ scroll, transition, onActiveChange }) {
  useEffect(() => {
    const s = scroll.current
    const lastIndex = PROJECTS.length - 1

    const nudge = (cards) => {
      if (transition.current.target === 1) return // a project is open
      s.target = Math.min(lastIndex, Math.max(0, s.target + cards))
      s.lastInput = performance.now()
      s.snapTo = null
    }
    const step = (direction) => {
      if (transition.current.target === 1) return
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
  }, [scroll, transition])

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

// `water` holds the uniforms Cards and ProjectFill write (object domes,
// ripples, flow) and the surface's shader reads.
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
      uBandWidth: { value: POOL_BAND_WIDTH },
      uPoolWave: { value: POOL_WAVE },
      uPoolPointSize: { value: POOL_POINT_SIZE },
      uNearZ: { value: SURFACE_NEAR_Z },
      uFarZ: { value: SURFACE_FAR_Z },
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
function Card({ project, index, scroll, transition, cards, water, emitRipple, onOpen }) {
  const meshRef = useRef(null)
  const geometry = useMemo(() => new PlaneGeometry(CARD_WIDTH, CARD_HEIGHT), [])
  const { texture, fillTexture, material } = useMemo(() => {
    const cover = drawCoverTexture(project)
    return {
      texture: cover,
      fillTexture: drawFillTexture(project),
      material: new ShaderMaterial({
        uniforms: {
          uMap: { value: cover },
          uWaterPlane: { value: new Vector4(0, 1, 0, 0) },
          uFadeHeight: { value: FADE_HEIGHT },
          uOpacity: { value: 1 },
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
      fillTexture.dispose()
      material.dispose()
    },
    [geometry, texture, fillTexture, material]
  )

  // Registered so ProjectFill can find this card's on-screen image rect and fill.
  useEffect(() => {
    cards.current[index] = { mesh: meshRef.current, fillTexture }
  }, [cards, index, fillTexture])

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

    const tr = transition.current
    const handOver = tr.index === index ? clamp01(tr.fill / CARD_FADE_SPAN) : 0
    material.uniforms.uOpacity.value = 1 - handOver
  })

  // Only the featured card opens, and only once it has settled.
  const isOpenable = () =>
    transition.current.target === 0 &&
    scroll.current.active === index &&
    Math.abs(scroll.current.position - index) < 0.05

  // renderOrder 1: drawn after the (also transparent) water, so a card covers
  // the dots behind it rather than being sorted against them.
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      renderOrder={1}
      onPointerOver={() => {
        if (isOpenable()) document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        document.body.style.cursor = ''
      }}
      onPointerDown={(event) => {
        // onPointerDown, not onClick — see Type03.
        if (!isOpenable()) return
        event.stopPropagation()
        document.body.style.cursor = ''
        onOpen(index)
      }}
    />
  )
}

// Drives the open/close transition: advances `progress`, derives the fill and
// flow from it, feeds the flow to the water, and places the fill quad —
// interpolating from the card's image rect (re-projected every frame, so it
// tracks the camera's bob on the way back) to the full screen.
function ProjectFill({ transition, cards, water }) {
  const meshRef = useRef(null)
  const geometry = useMemo(() => new PlaneGeometry(2, 2), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          uMap: { value: null },
          uRect: { value: new Vector4(...FULL_SCREEN_RECT) },
        },
        vertexShader: FILL_VERTEX_SHADER,
        fragmentShader: FILL_FRAGMENT_SHADER,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    []
  )

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material]
  )

  const corner = useMemo(() => new Vector3(), [])

  useFrame((state, delta) => {
    const tr = transition.current
    const dt = Math.min(delta, 1 / 30)
    const direction = tr.target === 1 ? 1 : -1
    tr.progress = clamp01(tr.progress + (direction * dt) / TRANSITION_SECONDS)
    tr.fill = easeInOutCubic(clamp01(tr.progress / FILL_SPAN))
    water.uFlow.value = clamp01((tr.progress - FLOW_DELAY) / (1 - FLOW_DELAY))

    const mesh = meshRef.current
    const card = cards.current[tr.index]
    mesh.visible = tr.fill > 0 && Boolean(card)
    if (!mesh.visible) return

    // The card's image area, projected to the screen.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const [x, y] of COVER_IMAGE_CORNERS) {
      corner.set(x, y, 0)
      card.mesh.localToWorld(corner).project(state.camera)
      minX = Math.min(minX, corner.x)
      minY = Math.min(minY, corner.y)
      maxX = Math.max(maxX, corner.x)
      maxY = Math.max(maxY, corner.y)
    }
    const f = tr.fill
    material.uniforms.uMap.value = card.fillTexture
    material.uniforms.uRect.value.set(
      minX + (FULL_SCREEN_RECT[0] - minX) * f,
      minY + (FULL_SCREEN_RECT[1] - minY) * f,
      maxX + (FULL_SCREEN_RECT[2] - maxX) * f,
      maxY + (FULL_SCREEN_RECT[3] - maxY) * f
    )
  })

  // frustumCulled off: it's positioned in screen space by its shader.
  return <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={-1} frustumCulled={false} />
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
// the hover/focus states, the portrait breakpoint (matching Card's portrait
// column position) and the project page's delayed entrance.
const STYLES = `
  /* Darkens the sea on the list's side, so text never sits over bright crests. */
  .t09-scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    background: linear-gradient(to right, rgba(5, 9, 13, 0.85), rgba(5, 9, 13, 0) 42%);
  }
  .t09-list {
    position: fixed;
    left: 1.5rem;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    color: #f4f4f0;
    font-family: system-ui, sans-serif;
  }
  .t09-kicker, .t09-num, .t09-meta {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
  }
  .t09-kicker { color: rgba(244, 244, 240, 0.45); margin-bottom: 1rem; }
  .t09-list ul { list-style: none; display: flex; flex-direction: column; gap: 0.2rem; }
  .t09-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    padding: 0.3rem 0;
    color: rgba(244, 244, 240, 0.4);
    transition: color 0.3s ease, transform 0.3s ease;
  }
  .t09-item:hover { color: rgba(244, 244, 240, 0.75); }
  .t09-item.is-active { color: #f4f4f0; transform: translateX(0.4rem); }
  .t09-item:focus-visible { outline: 1px solid rgba(244, 244, 240, 0.5); outline-offset: 4px; }
  .t09-title { font-size: 1.35rem; font-weight: 500; }
  .t09-meta { opacity: 0.6; }
  .t09-scrim, .t09-list { transition: opacity 0.4s ease; }
  .t09-scrim.is-hidden, .t09-list.is-hidden { opacity: 0; pointer-events: none; }

  /* Project page, over the colour fill — clear of the pooled water on the right. */
  .t09-page {
    position: fixed;
    left: clamp(1.5rem, 8vw, 7rem);
    top: 50%;
    z-index: 10;
    width: min(34rem, 62vw);
    color: #f4f4f0;
    font-family: system-ui, sans-serif;
    opacity: 0;
    pointer-events: none;
    transform: translateY(calc(-50% + 1rem));
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  .t09-page.is-open {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(-50%);
    transition: opacity 0.6s ease 0.9s, transform 0.6s ease 0.9s; /* once the fill has landed */
  }
  .t09-page h1 { font-size: clamp(2.5rem, 6vw, 5rem); font-weight: 600; line-height: 1; margin: 0.8rem 0 0.6rem; }
  .t09-page .t09-meta { display: block; margin-bottom: 1.6rem; opacity: 0.75; }
  .t09-page p { font-size: 1.05rem; line-height: 1.6; color: rgba(244, 244, 240, 0.85); }
  .t09-close {
    all: unset;
    cursor: pointer;
    display: inline-block;
    margin-top: 2.2rem;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    color: rgba(244, 244, 240, 0.7);
  }
  .t09-close:hover { color: #f4f4f0; }
  .t09-close:focus-visible { outline: 1px solid rgba(244, 244, 240, 0.6); outline-offset: 4px; }

  @media (max-aspect-ratio: 1/1) {
    .t09-scrim { background: linear-gradient(to top, rgba(5, 9, 13, 0.9), rgba(5, 9, 13, 0) 45%); }
    .t09-list { top: auto; bottom: 3.75rem; transform: none; }
    .t09-title { font-size: 1.1rem; }
  }
`

const PLACEHOLDER_BODY =
  'Placeholder — the case study would go here: the brief, the process and the outcome, with images and video further down the page.'

export default function Type09() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [openIndex, setOpenIndex] = useState(null)
  // Kept after closing, so the page's content doesn't vanish mid-fade-out.
  const [pageIndex, setPageIndex] = useState(null)
  // Mutable transition state, read and advanced in the frame loop. `index` is
  // the project being opened (or last opened, while closing).
  const transition = useRef({ target: 0, progress: 0, fill: 0, index: 0 })
  const cards = useRef([])

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
      uFlow: { value: 0 },
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

  const open = useCallback((index) => {
    transition.current.target = 1
    transition.current.index = index
    setOpenIndex(index)
    setPageIndex(index)
  }, [])
  const close = useCallback(() => {
    transition.current.target = 0
    setOpenIndex(null)
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') close()
      else if (event.key === 'Enter' && transition.current.target === 0 && event.target === document.body) {
        open(scroll.current.active)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const isOpen = openIndex !== null
  const page = pageIndex !== null ? PROJECTS[pageIndex] : null

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
        <ScrollDriver scroll={scroll} transition={transition} onActiveChange={setActiveIndex} />
        <OceanSurface water={water} />
        {PROJECTS.map((project, i) => (
          <Card
            key={project.id}
            project={project}
            index={i}
            scroll={scroll}
            transition={transition}
            cards={cards}
            water={water}
            emitRipple={emitRipple}
            onOpen={open}
          />
        ))}
        <CameraRig />
        <ProjectFill transition={transition} cards={cards} water={water} />
      </SceneCanvas>

      <div className={`t09-scrim${isOpen ? ' is-hidden' : ''}`} />
      <nav className={`t09-list${isOpen ? ' is-hidden' : ''}`} aria-hidden={isOpen ? true : undefined}>
        <p className="t09-kicker">selected work</p>
        <ul>
          {PROJECTS.map((project, i) => (
            <li key={project.id}>
              <button
                type="button"
                className={`t09-item${activeIndex === i ? ' is-active' : ''}`}
                aria-current={activeIndex === i ? 'true' : undefined}
                tabIndex={isOpen ? -1 : 0}
                // The featured title opens its project; any other jumps to it.
                onClick={() => (activeIndex === i ? open(i) : jumpTo(i))}
              >
                <span className="t09-num">{project.number}</span>
                <span className="t09-title">{project.title}</span>
                <span className="t09-meta">{project.year}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <article className={`t09-page${isOpen ? ' is-open' : ''}`} aria-hidden={isOpen ? undefined : true}>
        {page && (
          <>
            <span className="t09-num">{page.number}</span>
            <h1>{page.title}</h1>
            <span className="t09-meta">
              {page.discipline} · {page.year}
            </span>
            <p>{PLACEHOLDER_BODY}</p>
            <button type="button" className="t09-close" tabIndex={isOpen ? 0 : -1} onClick={close}>
              ← all projects
            </button>
          </>
        )}
      </article>
      {!isOpen && <Hint text="scroll · click to open" dismissOn={['wheel', 'touchmove', 'keydown']} dark />}
    </>
  )
}
