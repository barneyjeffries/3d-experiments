import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DynamicDrawUsage, ShaderMaterial } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

// GPU points-based particle system — a single THREE.Points draw call, not
// instanced meshes or physics bodies. Position updates are still CPU-side
// (a flat typed-array loop, same cost class as Type02's instanced particles)
// but rendering is one draw call regardless of count.
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

// Letter formation — sample a typed character from an offscreen canvas into
// a point cloud, then assign every particle an evenly-shuffled sample point
// to converge on (see `formLetter` — a shuffled round-robin, not independent
// random draws, so every sampled point is guaranteed coverage).
const CANVAS_SIZE = 320
const CANVAS_FONT_PX = 240 // large relative to CANVAS_SIZE for a high-resolution, non-clipped sample
const SAMPLE_STRIDE = 3 // pixel step when scanning the canvas for filled pixels — lower = more sample points, denser shape
const ALPHA_THRESHOLD = 128
const LETTER_WORLD_HEIGHT = 6.2 // world-space size the canvas maps onto
const LETTER_JITTER = 0.05 // small per-particle scatter around its sampled point, so it doesn't read as a grid
const LETTER_DEPTH_RANGE = [-0.5, 0.5] // slight parallax — letters stay mostly flat, facing the camera

// How long, after the last keystroke, particles keep pursuing the letter
// target before releasing. This has to comfortably exceed the time it takes
// the SLOWEST particle to actually reach its target (see FORM_RATE_RANGE/
// POS_RATE_RANGE below) — otherwise the hold ends while particles are still
// mid-transit and the letter never reads as fully resolved, just a rough
// swarm. With the rates below, worst-case transit is ~700-900ms, so this
// leaves a genuine ~700ms+ of clearly-held, readable letter before dissolve.
const FORM_HOLD_MS = 1600
// Two-stage easing per particle: formAmount (how "letter" vs "swirl" this
// particle's target is) eases toward 0/1 first, then position eases toward
// that blended target — kept fast/tight (rather than the slower spread this
// used to have) so both stages resolve well within FORM_HOLD_MS, with just
// enough per-particle spread left for an organic (non-lockstep) arrival.
const FORM_RATE_RANGE = [0.06, 0.12]
const POS_RATE_RANGE = [0.18, 0.3]

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

// Renders `char` into the shared canvas and returns its filled pixels as a
// flat [x0, y0, x1, y1, ...] array in canvas pixel space.
function sampleLetterPixels(ctx, char, fontFamily) {
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${CANVAS_FONT_PX}px ${fontFamily}`
  ctx.fillText(char, CANVAS_SIZE / 2, CANVAS_SIZE / 2)

  const { data } = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  const points = []
  for (let y = 0; y < CANVAS_SIZE; y += SAMPLE_STRIDE) {
    const row = y * CANVAS_SIZE
    for (let x = 0; x < CANVAS_SIZE; x += SAMPLE_STRIDE) {
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
  // Offscreen canvas used to rasterize typed letters — created once, reused
  // for every keystroke.
  const canvasRef = useRef(null)
  if (!canvasRef.current) {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_SIZE
    canvas.height = CANVAS_SIZE
    canvasRef.current = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) }
  }
  const fontFamilyRef = useRef('sans-serif')

  useEffect(() => {
    const face = new FontFace('Type06GlyphFont', `url(${fontUrl})`)
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded)
        fontFamilyRef.current = 'Type06GlyphFont'
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
  // Scratch buffer for the shuffled point-index assignment computed in
  // `formLetter` on every keystroke — reused rather than reallocated.
  const assignmentScratch = useMemo(() => new Int32Array(PARTICLE_COUNT), [])
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

  // Regenerates the current letter's target points and reassigns every
  // particle a sample point to converge on. Called fresh on every keystroke,
  // including while a previous letter is still mid-form — targets just
  // smoothly retarget since only the destination changes, not how particles
  // get there.
  function formLetter(char) {
    lastKeyTimeRef.current = performance.now()
    const { ctx } = canvasRef.current
    const pixels = sampleLetterPixels(ctx, char, fontFamilyRef.current)
    const pointCount = pixels.length / 2

    // Diagnostic: if this ever logs a suspiciously low count (a few dozen or
    // fewer) for a normal letter, the canvas sampling itself is the problem
    // (font not ready, threshold wrong, glyph clipped) — check this first.
    // eslint-disable-next-line no-console
    console.log(`[Type06] "${char}" sampled ${pointCount} letter points (font: ${fontFamilyRef.current})`)
    if (pointCount === 0) return

    // Even coverage: cycle through every sampled point (repeating as needed
    // to cover all particles) and shuffle the assignment, rather than having
    // each particle pick an independent random point. Independent random
    // draws leave some points under- or un-covered by chance; this
    // guarantees every sampled point gets at least one particle.
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      assignmentScratch[i] = i % pointCount
    }
    for (let i = PARTICLE_COUNT - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = assignmentScratch[i]
      assignmentScratch[i] = assignmentScratch[j]
      assignmentScratch[j] = tmp
    }

    const scale = LETTER_WORLD_HEIGHT / CANVAS_SIZE
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = assignmentScratch[i]
      const px = pixels[p * 2]
      const py = pixels[p * 2 + 1]
      letterTargets[i * 3] = (px - CANVAS_SIZE / 2) * scale + randRange(-LETTER_JITTER, LETTER_JITTER)
      letterTargets[i * 3 + 1] = -(py - CANVAS_SIZE / 2) * scale + randRange(-LETTER_JITTER, LETTER_JITTER)
      letterTargets[i * 3 + 2] = randRange(...LETTER_DEPTH_RANGE)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key
      if (key.length === 1 && /[a-zA-Z]/.test(key)) {
        formLetter(key.toUpperCase())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime
    const formTarget = performance.now() - lastKeyTimeRef.current < FORM_HOLD_MS ? 1 : 0

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

export default function Type06() {
  return (
    <SceneCanvas cameraPosition={[0, 0, 9]} fov={45} orbitControls={false}>
      <ParticleCloud />
    </SceneCanvas>
  )
}
