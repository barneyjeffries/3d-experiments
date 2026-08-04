import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, ShaderMaterial } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

// GPU points-based particle system — a single THREE.Points draw call, not
// instanced meshes or physics bodies. Position updates are still CPU-side
// (a flat typed-array loop, same cost class as Type02's instanced particles)
// but rendering is one draw call regardless of count.
//
// Typed letters accumulate into a word buffer (see `wordBufferRef`) and the
// whole buffer is rendered/sampled as one string per keystroke, so multiple
// letters form side by side, naturally kerned and centred, rather than each
// keystroke replacing the last.
//
// Tune this for the target device (aiming for smooth on iPhone 14). The
// per-frame cost here is a flat O(N) loop of a handful of trig calls per
// particle (the curl field) — at 6000 particles that's ~60k Math.cos calls a
// frame, comfortably inside budget on modern mobile GPUs/CPUs. The ceiling in
// practice is more about point-sprite fill rate than the JS loop; if this
// needs to go lower, halve PARTICLE_COUNT before touching anything else.
const PARTICLE_COUNT = 6000

const BASE_COLOR = [0.1, 0.1, 0.1] // dark near-black, roughly '#1a1a1a' — reads clearly on the light background
const ACCENT_COLOR = [0.3, 0.49, 0.06] // dark accent green, roughly '#4d7c0f' — darkened from the acid-green used elsewhere so it still has contrast on a light bg
const ACCENT_RATIO = 0.12
const POINT_SCALE_RANGE = [0.6, 1.4]
const BASE_POINT_SIZE = 120 // gl_PointSize numerator before /-mvPosition.z falloff — tune to taste

// Idle swirl — particles drift forever via a curl (divergence-free) flow
// field, so the cloud never looks static even when nothing is forming.
const SWIRL_HALF_WIDTH = 4.5
const SWIRL_HALF_HEIGHT = 3
const SWIRL_HALF_DEPTH = 1.4 // shallow — this is a "mostly flat" scene, not a volumetric one
const SWIRL_SPEED = 0.55
// Containment used to be per-axis (clamp X once past its own bound, clamp Y
// once past ITS own bound, etc.) — that's a rectangular box by construction,
// which is exactly what read as boxy/cornered: particles slide along a flat
// wall while only the crossed axis gets pulled back. Fixed by containing on
// a single ellipsoid RADIUS instead (normalized by the three half-extents
// above), so the pull-back has no flat faces or corners at all — see the
// radial containment in the frame loop below.
const SOFT_RADIUS_START = 0.8 // fraction of the ellipsoid where particles roam completely freely; beyond this, the pull-back ramps up
const CONTAIN_STRENGTH = 0.9 // spring-like pull-back strength once past SOFT_RADIUS_START — gentle: this only has to stop escape, separation below does the actual spacing work

// Short-range separation — without this, particles have nothing pushing them
// apart, so over time the (weak) centre containment above is the only net
// force and they drift together into a dense clump. This is what actually
// keeps the cloud looking like an evenly-spread nebula rather than either a
// hard box (old bug) or a soft blob (this one). Grid-bucketed rather than
// checking every pair (O(n^2) would not stay smooth at thousands of
// particles) — same spatial-hash approach as Type02's boids-style scatter.
const SEPARATION_RADIUS = 0.4 // particles closer than this repel each other — the cloud's loose minimum spacing
const SEPARATION_RADIUS_SQ = SEPARATION_RADIUS * SEPARATION_RADIUS
const SEPARATION_STRENGTH = 3 // per-neighbour push strength before capping
const SEPARATION_MAX_FORCE = 2.5 // hard cap on the summed push per particle, so a tight cluster can't fling apart violently
const MAX_NEIGHBOR_CHECKS = 8 // hard cap on candidates examined per particle per frame
const SEPARATION_CELL_SIZE = SEPARATION_RADIUS // grid cell size == radius, so a 3x3x3 block of cells covers it
const GRID_BIAS = 512 // keeps packed cell keys non-negative for this volume's coordinate range

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
// Spatial/time frequencies for the curl field's underlying vector potential.
// Raised from the original (0.3-0.42) — at that spatial scale, the cosine
// terms don't complete even half a period across this volume, so the field
// reads as one coherent "wind" rather than churning local eddies, and can
// look like it's steadily driving particles toward one side. This is
// mathematically still exactly divergence-free either way (curl of ANY
// vector field is — verified analytically, not just asserted), but higher
// spatial frequency keeps the circulation local instead of domain-spanning.
const CURL_FREQ = [0.62, 0.74, 0.55, 0.68, 0.58, 0.7]
const CURL_TIME_SPEED = [0.2, 0.24, 0.18, 0.22, 0.19, 0.26]
// How strongly a particle's underlying swirl anchor is damped as it commits
// to a letter (multiplies swirl-advection speed by (1 - formAmount)^this).
// Higher = swirl gets suppressed harder/sooner, so the target dominates and
// the shape actually resolves instead of the blend being dragged around by
// a still-wandering swirl point. 1 = linear falloff, 2 = the current default
// (strong, matches the "strongly reduce" ask), try 3+ for near-total kill.
const SWIRL_FORM_SUPPRESSION_POWER = 2

// Word formation — render the whole current word buffer as one string to an
// offscreen canvas (natural kerning, and centring falls out for free since
// the canvas is sized to the word and we draw centred on it) into a point
// cloud, then assign every particle an evenly-shuffled sample point to
// converge on (see `formWord` — a shuffled round-robin, not independent
// random draws, so every sampled point gets coverage as evenly as the
// particle budget allows).
const CANVAS_HEIGHT = 320 // fixed — canvas WIDTH is resized per word to fit, so letters don't shrink as the word grows
const CANVAS_FONT_PX = 240 // large relative to CANVAS_HEIGHT for a high-resolution, non-clipped sample
const SAMPLE_STRIDE = 3 // pixel step when scanning the canvas for filled pixels — lower = more sample points, denser shape
const ALPHA_THRESHOLD = 128
const LETTER_WORLD_HEIGHT = 6.2 // world-space size CANVAS_HEIGHT maps onto (word width follows from this + the canvas's aspect ratio)
const LETTER_JITTER = 0.05 // small per-particle scatter around its sampled point, so it doesn't read as a grid
const LETTER_DEPTH_RANGE = [-0.5, 0.5] // slight parallax — letters stay mostly flat, facing the camera
const MAX_WORD_LENGTH = 16 // safety cap (e.g. against key-repeat) — beyond this, further letters are ignored until the buffer clears

// Rolling typing window: resets on every keystroke (letter or backspace).
// While it hasn't elapsed, the current word buffer keeps forming/holding;
// once it elapses with no further input, the word dissolves back into the
// swirl and the next letter typed starts a fresh word. ~2-3s per the brief.
const TYPING_TIMEOUT_MS = 2500
// This also has to comfortably exceed the time it takes the SLOWEST particle
// to actually reach its target (see FORM_RATE_RANGE/POS_RATE_RANGE below) —
// otherwise typing would stop, the timeout would elapse mid-transit, and the
// word would never read as fully resolved. With the rates below, worst-case
// transit is ~700-900ms, comfortably inside the window above.
// Two-stage easing per particle: formAmount (how "word" vs "swirl" this
// particle's target is) eases toward 0/1 first, then position eases toward
// that blended target — kept fast/tight so both stages resolve well within
// TYPING_TIMEOUT_MS, with just enough per-particle spread for an organic
// (non-lockstep) arrival.
const FORM_RATE_RANGE = [0.06, 0.12]
const POS_RATE_RANGE = [0.18, 0.3]

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

// Resizes the shared canvas to fit `word` at CANVAS_FONT_PX (measuring first,
// since canvas width has to be set before drawing) and renders it centred.
// Returns the canvas's actual {width, height} — width varies with word
// length, height is always CANVAS_HEIGHT. Centring the word at width/2 here
// is what makes the whole buffer stay centred in the scene as it grows: the
// pixel-to-world mapping in `formWord` centres on the canvas dimensions, so
// a wider canvas for a longer word is still centred around world x=0.
function drawWord(canvasEntry, word, fontFamily) {
  const { ctx, canvas } = canvasEntry
  ctx.font = `bold ${CANVAS_FONT_PX}px ${fontFamily}`
  const measuredWidth = ctx.measureText(word).width
  const width = Math.max(Math.ceil(measuredWidth + CANVAS_FONT_PX * 0.6), CANVAS_FONT_PX)
  const height = CANVAS_HEIGHT

  // Resizing a canvas clears it and resets its 2D context state, so the
  // fillStyle/align/baseline/font below have to be (re-)applied after.
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${CANVAS_FONT_PX}px ${fontFamily}`
  ctx.fillText(word, width / 2, height / 2)

  return { width, height }
}

// Scans the canvas (already drawn by `drawWord`) for filled pixels and
// returns them as a flat [x0, y0, x1, y1, ...] array in canvas pixel space.
function sampleFilledPixels(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height)
  const points = []
  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    const row = y * width
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const alpha = data[(row + x) * 4 + 3]
      if (alpha > ALPHA_THRESHOLD) points.push(x, y)
    }
  }
  return points
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aScale;
  attribute vec3 aColor;
  varying vec3 vColor;
  uniform float uBaseSize;
  uniform float uPixelRatio;

  void main() {
    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uBaseSize * aScale * uPixelRatio / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float alpha = smoothstep(0.5, 0.0, length(uv));
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`

function ParticleCloud() {
  // Offscreen canvas used to rasterize the typed word — created once, reused
  // (and resized as needed by `drawWord`) for every keystroke.
  const canvasRef = useRef(null)
  if (!canvasRef.current) {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_FONT_PX
    canvas.height = CANVAS_HEIGHT
    canvasRef.current = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) }
  }
  const fontFamilyRef = useRef('sans-serif')
  // The word currently being typed. Appended to on each letter keypress,
  // trimmed on backspace, and cleared once the rolling typing window has
  // elapsed (see the staleness check in the keydown handler below).
  const wordBufferRef = useRef('')

  useEffect(() => {
    const face = new FontFace('Type05GlyphFont', `url(${fontUrl})`)
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded)
        fontFamilyRef.current = 'Type05GlyphFont'
      })
      .catch(() => {
        // Sampling already falls back to sans-serif — nothing else to do.
      })
  }, [])

  // Flat typed arrays, mutated directly every frame — same "refs, not React
  // state, drive the animation" approach as the physics experiments.
  const positions = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), [])
  const swirlTargets = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), [])
  const letterTargets = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), [])
  const formAmounts = useMemo(() => new Float32Array(PARTICLE_COUNT), [])
  const formRates = useMemo(() => new Float32Array(PARTICLE_COUNT), [])
  const posRates = useMemo(() => new Float32Array(PARTICLE_COUNT), [])
  // Scratch buffer of shuffled POINT indices, used in `formWord` to assign
  // particles to sampled points. Sized to the sampled point count (which
  // varies with word length), not PARTICLE_COUNT — grown lazily, never
  // shrunk, so most keystrokes don't reallocate at all.
  const pointIndexScratchRef = useRef(new Int32Array(4096))
  // Spatial hash for separation — cellKey -> array of particle indices.
  // Rebuilt (bucket arrays cleared and refilled, not reallocated) every
  // frame from the swirl targets' current positions, then used for
  // neighbour lookups in the same frame's main update pass below.
  const gridRef = useRef(new Map())

  const lastKeyTimeRef = useRef(-Infinity)

  const geometry = useMemo(() => {
    const geo = new BufferGeometry()
    const colors = new Float32Array(PARTICLE_COUNT * 3)
    const scales = new Float32Array(PARTICLE_COUNT)

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = randRange(-SWIRL_HALF_WIDTH, SWIRL_HALF_WIDTH)
      const y = randRange(-SWIRL_HALF_HEIGHT, SWIRL_HALF_HEIGHT)
      const z = randRange(-SWIRL_HALF_DEPTH, SWIRL_HALF_DEPTH)
      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
      swirlTargets[i * 3] = x
      swirlTargets[i * 3 + 1] = y
      swirlTargets[i * 3 + 2] = z

      formAmounts[i] = 0
      formRates[i] = randRange(...FORM_RATE_RANGE)
      posRates[i] = randRange(...POS_RATE_RANGE)

      const isAccent = Math.random() < ACCENT_RATIO
      const color = isAccent ? ACCENT_COLOR : BASE_COLOR
      colors[i * 3] = color[0]
      colors[i * 3 + 1] = color[1]
      colors[i * 3 + 2] = color[2]
      scales[i] = randRange(...POINT_SCALE_RANGE)
    }

    const positionAttribute = new BufferAttribute(positions, 3)
    positionAttribute.setUsage(DynamicDrawUsage)
    geo.setAttribute('position', positionAttribute)
    geo.setAttribute('aColor', new BufferAttribute(colors, 3))
    geo.setAttribute('aScale', new BufferAttribute(scales, 1))
    return geo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: {
          uBaseSize: { value: BASE_POINT_SIZE },
          uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        },
        transparent: true,
        depthWrite: false,
      }),
    []
  )

  // Regenerates the CURRENT WORD BUFFER's target points and reassigns every
  // particle a sample point to converge on. Called fresh on every keystroke
  // (letter or backspace) — including mid-form — so the whole arrangement
  // smoothly retargets as the word grows/shrinks rather than snapping.
  function formWord() {
    lastKeyTimeRef.current = performance.now()
    const word = wordBufferRef.current
    if (!word) return

    const { width, height } = drawWord(canvasRef.current, word, fontFamilyRef.current)
    const pixels = sampleFilledPixels(canvasRef.current.ctx, width, height)
    const pointCount = pixels.length / 2

    // Diagnostic: if this ever logs a suspiciously low count (a few dozen or
    // fewer) for a normal word, the canvas sampling itself is the problem
    // (font not ready, threshold wrong, glyph clipped) — check this first.
    // eslint-disable-next-line no-console
    console.log(`[Type05] "${word}" sampled ${pointCount} points (${width}x${height} canvas, font: ${fontFamilyRef.current})`)
    if (pointCount === 0) return

    // Even coverage: shuffle the sampled points themselves (not which
    // particle gets which — the point set can be smaller OR LARGER than
    // PARTICLE_COUNT once a word has several letters), then walk particles
    // through that shuffled order, wrapping with modulo. That wrap only
    // matters when pointCount < PARTICLE_COUNT (short words — repeats give
    // every point several particles); when a longer word means pointCount >
    // PARTICLE_COUNT, modulo has no effect and this instead picks a
    // uniformly-random SUBSET of points spanning the whole word, so a
    // particle-starved long word thins out evenly rather than only
    // populating whichever letters were sampled first.
    if (pointIndexScratchRef.current.length < pointCount) {
      pointIndexScratchRef.current = new Int32Array(pointCount)
    }
    const pointIndex = pointIndexScratchRef.current
    for (let p = 0; p < pointCount; p++) pointIndex[p] = p
    for (let p = pointCount - 1; p > 0; p--) {
      const q = Math.floor(Math.random() * (p + 1))
      const tmp = pointIndex[p]
      pointIndex[p] = pointIndex[q]
      pointIndex[q] = tmp
    }

    // CANVAS_HEIGHT (not the word-specific `height`, which is the same
    // value) maps to LETTER_WORLD_HEIGHT; centring on width/2, height/2 here
    // matches how `drawWord` centred the word on the canvas, so the whole
    // word — however wide — lands centred at world x=0.
    const scale = LETTER_WORLD_HEIGHT / CANVAS_HEIGHT
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = pointIndex[i % pointCount]
      const px = pixels[p * 2]
      const py = pixels[p * 2 + 1]
      letterTargets[i * 3] = (px - width / 2) * scale + randRange(-LETTER_JITTER, LETTER_JITTER)
      letterTargets[i * 3 + 1] = -(py - height / 2) * scale + randRange(-LETTER_JITTER, LETTER_JITTER)
      letterTargets[i * 3 + 2] = randRange(...LETTER_DEPTH_RANGE)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const isLetter = event.key.length === 1 && /[a-zA-Z]/.test(event.key)
      const isBackspace = event.key === 'Backspace'
      if (!isLetter && !isBackspace) return

      // If the rolling typing window already elapsed (the previous word has
      // finished dissolving, or would have by now), this keystroke starts a
      // fresh word rather than appending to stale leftovers.
      if (performance.now() - lastKeyTimeRef.current >= TYPING_TIMEOUT_MS) {
        wordBufferRef.current = ''
      }

      if (isBackspace) {
        event.preventDefault()
        wordBufferRef.current = wordBufferRef.current.slice(0, -1)
      } else if (wordBufferRef.current.length < MAX_WORD_LENGTH) {
        wordBufferRef.current += event.key.toUpperCase()
      }

      if (wordBufferRef.current.length > 0) {
        formWord()
      } else {
        // Nothing left to hold — dissolve immediately rather than waiting
        // out the rest of the window with an empty buffer.
        lastKeyTimeRef.current = -Infinity
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime
    const formTarget = performance.now() - lastKeyTimeRef.current < TYPING_TIMEOUT_MS ? 1 : 0

    // Curl field frequencies/speeds — see CURL_FREQ/CURL_TIME_SPEED above.
    const [fa, fb, fc, fd, fe, ff] = CURL_FREQ
    const [wa, wb, wc, wd, we, wf] = CURL_TIME_SPEED

    // Pass 1: bucket every particle's current swirl-target position into the
    // spatial grid, so pass 2's neighbour lookups see a consistent snapshot
    // rather than a mix of already-updated and not-yet-updated positions.
    const grid = gridRef.current
    for (const bucket of grid.values()) bucket.length = 0
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3
      const key = cellKey(
        Math.floor(swirlTargets[ix] / SEPARATION_CELL_SIZE),
        Math.floor(swirlTargets[ix + 1] / SEPARATION_CELL_SIZE),
        Math.floor(swirlTargets[ix + 2] / SEPARATION_CELL_SIZE)
      )
      let bucket = grid.get(key)
      if (!bucket) {
        bucket = []
        grid.set(key, bucket)
      }
      bucket.push(i)
    }

    // Pass 2: curl + containment + separation + easing toward the (possibly
    // letter-blended) target.
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3
      const iy = ix + 1
      const iz = ix + 2

      // --- advect this particle's swirl target through the curl field.
      // Always running (even while mid-letter, so the swirl has somewhere
      // fresh to release back into once it dissolves) but damped by
      // swirlSuppression below the more committed this particle is to
      // forming — otherwise the swirl keeps dragging the blended target
      // around for as long as it has any weight at all, and the letter
      // never quite settles (see SWIRL_FORM_SUPPRESSION_POWER above).
      const prevAmt = formAmounts[i]
      const swirlSuppression = Math.pow(1 - prevAmt, SWIRL_FORM_SUPPRESSION_POWER)

      const sx = swirlTargets[ix]
      const sy = swirlTargets[iy]
      const sz = swirlTargets[iz]

      // curl of vector potential (Fx,Fy,Fz) built from sines — curl is
      // identically divergence-free for any potential, so this can't
      // collapse or blow up particles no matter how the frequencies are tuned.
      let vx = ff * Math.cos(sy * ff + t * wf) - fc * Math.cos(sz * fc + t * wc)
      let vy = fb * Math.cos(sz * fb + t * wb) - fe * Math.cos(sx * fe + t * we)
      let vz = fd * Math.cos(sx * fd + t * wd) - fa * Math.cos(sy * fa + t * wa)

      // Radial (ellipsoidal) soft containment — normalize position by the
      // three half-extents so "1.0" is the nominal boundary regardless of
      // aspect ratio, then pull back along the position vector itself once
      // past SOFT_RADIUS_START. No per-axis clamp, so no flat wall to slide
      // along and no corners where two walls meet — just a smooth, edgeless
      // spring toward the centre that only engages near the outer boundary.
      const nx = sx / SWIRL_HALF_WIDTH
      const ny = sy / SWIRL_HALF_HEIGHT
      const nz = sz / SWIRL_HALF_DEPTH
      const r = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (r > SOFT_RADIUS_START) {
        const pull = (r - SOFT_RADIUS_START) * CONTAIN_STRENGTH
        vx -= sx * pull
        vy -= sy * pull
        vz -= sz * pull
      }

      // Short-range separation from nearby swirl targets, via the grid
      // bucketed in pass 1 above — this is what actually stops the cloud
      // collapsing into a clump (containment alone only pushes inward at
      // the edges; nothing was pushing particles apart). Capped both in
      // candidates examined and in resulting force, so a dense cluster
      // can't spike into a huge single-frame push.
      const gx = Math.floor(sx / SEPARATION_CELL_SIZE)
      const gy = Math.floor(sy / SEPARATION_CELL_SIZE)
      const gz = Math.floor(sz / SEPARATION_CELL_SIZE)
      let sepX = 0
      let sepY = 0
      let sepZ = 0
      let checked = 0
      for (let oi = 0; oi < CELL_OFFSETS.length && checked < MAX_NEIGHBOR_CHECKS; oi++) {
        const [ox, oy, oz] = CELL_OFFSETS[oi]
        const bucket = grid.get(cellKey(gx + ox, gy + oy, gz + oz))
        if (!bucket) continue
        for (let bi = 0; bi < bucket.length && checked < MAX_NEIGHBOR_CHECKS; bi++) {
          const j = bucket[bi]
          if (j === i) continue
          checked++
          const jx = j * 3
          const ddx = sx - swirlTargets[jx]
          const ddy = sy - swirlTargets[jx + 1]
          const ddz = sz - swirlTargets[jx + 2]
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
      if (sepLenSq > SEPARATION_MAX_FORCE * SEPARATION_MAX_FORCE) {
        const s = SEPARATION_MAX_FORCE / Math.sqrt(sepLenSq)
        sepX *= s
        sepY *= s
        sepZ *= s
      }
      vx += sepX
      vy += sepY
      vz += sepZ

      swirlTargets[ix] = sx + vx * SWIRL_SPEED * swirlSuppression * delta
      swirlTargets[iy] = sy + vy * SWIRL_SPEED * swirlSuppression * delta
      swirlTargets[iz] = sz + vz * SWIRL_SPEED * swirlSuppression * delta

      // --- ease this particle's own form amount toward the shared target.
      const amt = prevAmt + (formTarget - prevAmt) * formRates[i]
      formAmounts[i] = amt

      // --- blend swirl vs. letter target, then ease position toward it.
      const tx = swirlTargets[ix] + (letterTargets[ix] - swirlTargets[ix]) * amt
      const ty = swirlTargets[iy] + (letterTargets[iy] - swirlTargets[iy]) * amt
      const tz = swirlTargets[iz] + (letterTargets[iz] - swirlTargets[iz]) * amt

      const posRate = posRates[i]
      positions[ix] += (tx - positions[ix]) * posRate
      positions[iy] += (ty - positions[iy]) * posRate
      positions[iz] += (tz - positions[iz]) * posRate
    }

    geometry.attributes.position.needsUpdate = true
  })

  return (
    <points frustumCulled={false}>
      <primitive object={geometry} attach="geometry" />
      <primitive object={material} attach="material" />
    </points>
  )
}

export default function Type05() {
  return (
    <>
      <SceneCanvas cameraPosition={[0, 0, 9]} fov={45} orbitControls={false}>
        <ParticleCloud />
      </SceneCanvas>
      <Hint text="type something" dismissOn={['keydown']} />
    </>
  )
}
