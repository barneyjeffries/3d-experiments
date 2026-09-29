import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BoxGeometry, BufferAttribute, BufferGeometry, EdgesGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'

// Open-ocean surface (a rolling swell, not a breaking wave), rendered two ways
// from the exact same wave function so they can be compared side by side:
// a dense field of points, or rows of lines running across the view. Click /
// tap the water to raise a cube through it (tap the cube to sink it); the
// controls top right set how rough the sea is and switch points / lines.
//
// All motion happens in the vertex shader — the geometry is a flat, static
// grid uploaded once, and the only per-frame CPU work is bumping a couple of
// uniforms. Lines are the cheaper mode: fewer vertices, and each one draws a
// 1px segment, whereas every point is an alpha-blended sprite several pixels
// across (fill rate is the real ceiling here, as in Type05).

const BACKGROUND_COLOR = '#05090d'
const TROUGH_COLOR = [0.09, 0.19, 0.27] // raw RGB, same convention as Type05's COLOR_CYCLE
const CREST_COLOR = [0.9, 0.95, 0.96]
const TROUGH_ALPHA = 0.35 // troughs recede, crests catch the light
const HEIGHT_RANGE = 0.8 // world-space height mapped onto the trough -> crest colour ramp

// Surface extent — trimmed to what the camera can actually see. The near edge
// sits just past the bottom of the frame (the camera looks down at ~35° at the
// bottom edge, meeting the water around z = 7; the margin covers bob, parallax
// and wave height), and the far edge just past where the distance fade below
// has already dissolved it. The first cut of this spanned z = -45..45, so over
// half its vertices were behind the camera or fully faded.
const SURFACE_HALF_WIDTH = 34
const SURFACE_NEAR_Z = 10
const SURFACE_FAR_Z = -30
const EDGE_FADE_START = 0.75 // fraction of the half-width where the side fade begins
const DISTANCE_FADE_NEAR = 12 // camera distance where the far fade begins...
const DISTANCE_FADE_FAR = 36 // ...and where the surface has fully dissolved into the background

// Grid densities per mode, at the same world-space spacing as before the trim.
// Points want a roughly even grid; lines want few rows but many samples along
// each row, so the curves stay smooth.
const POINT_GRID = { cols: 272, rows: 151 }
const LINE_GRID = { cols: 408, rows: 67 }
const POINT_SIZE = 38 // gl_PointSize numerator before the /distance falloff

// Gerstner waves: [dirX, dirZ, wavelength, calmSteepness, roughSteepness].
// Each wave moves points in small circles (not just up and down), which
// sharpens crests and flattens troughs the way real swell does. Positive Z
// travels toward the camera. A long dominant swell, a secondary cross-swell,
// then shorter chop.
//
// Turbulence blends every wave between its calm and rough steepness. The
// short chop gains proportionally far more than the long swell, since that's
// what wind does to a sea — it roughens the surface more than it raises the
// swell. Even fully rough, the steepnesses sum below 1: at 1 the crests would
// pinch into loops, which is exactly the "breaking wave" look to avoid.
const WAVES = [
  [0.15, 1, 18, 0.1, 0.22],
  [-0.45, 1, 11, 0.07, 0.18],
  [0.7, 0.7, 6.5, 0.03, 0.17],
  [-0.9, 0.45, 4.2, 0.02, 0.14],
  [0.35, -0.6, 2.7, 0.01, 0.12],
  [1, 0.15, 1.8, 0.005, 0.1],
]
const TURBULENCE_DEFAULT = 0.4 // roughly the sea state of the first cut of this experiment
const TURBULENCE_SMOOTHING = 0.06 // per-frame ease toward the slider value, so dragging it never jumps the surface

// Deep-water dispersion (speed = sqrt(g / k)) is computed per wave in the
// shader, so longer waves naturally outrun the chop. This just slows the whole
// sea down to a calmer pace than real-world metres-per-second would give.
const TIME_SCALE = 0.55

// CPU copy of the swell, for the cube to float on (see swellHeight). Mirrors
// the vertex shader's height term exactly, with the per-wave constants
// precomputed.
const WAVE_TERMS = WAVES.map(([dx, dz, wavelength, calm, rough]) => {
  const len = Math.hypot(dx, dz)
  const k = (Math.PI * 2) / wavelength
  return { dx: dx / len, dz: dz / len, k, speed: Math.sqrt(9.8 / k), calm, rough }
})

// The cube. A spring pulls it toward a floating height, so it pops up,
// overshoots (its bottom briefly clears the water), splashes back, and
// settles into bobbing on the swell.
const CUBE_SIZE = 1.4
const CUBE_FLOAT_OFFSET = 0.3 // centre height above the local swell when floating — about 70% rides above the water
const CUBE_SUNK_Y = -4 // resting depth when sunk, well below the deepest trough
const CUBE_RESPAWN_BELOW = -3 // sinking past this, it's out of sight and free to move to the next spot
const SPRING_STIFFNESS = 4
const SPRING_DAMPING = 1.8 // damping ratio ~0.45 with the stiffness above: a lively overshoot, a couple of bobs, then settled
const TILT_FOLLOW = 0.8 // how far the cube tilts to match the swell's slope (1 = fully)
const TILT_LERP = 0.08
const SLOPE_SAMPLE = 0.6 // finite-difference half-step for the slope estimate
const FIRST_RISE_DELAY = 1.2 // seconds after load before the cube first surfaces
const FIRST_RISE_AT = [0, -2]
const CUBE_FILL_COLOR = '#0b1117'
const CUBE_EDGE_COLOR = '#e6f0f2'
const CUBE_EDGE_FADE = [-2.5, 0.3] // edge opacity ramps in as the cube's top rises through this range (relative to the surface)
const CLICK_BOUNDS = { x: 9, zNear: 5, zFar: -14 } // clicks are clamped here, keeping the cube well within frame

// Water displaced by the cube, added on top of the swell in the shader.
// Dome: water lifted over (and shouldered around) a rising cube, or dragged
// down after a sinking one. Scaled by vertical speed, so a cube at rest
// leaves the surface alone.
const DOME_PEAK = 0.55
const DOME_RADIUS = 1.5
const DOME_DEPTH = 1.6 // how far below the surface the cube's top starts lifting the water
const DOME_REFERENCE_SPEED = 3 // vertical speed at which the dome reaches full height
// Ripples: a ring train sent out each time a face of the cube crosses the
// surface fast enough — the breach, the splash back after the overshoot, and
// the plunge when it sinks.
const RIPPLE_COUNT = 4 // ring buffer; the oldest ring is recycled
const RIPPLE_SPEED = 3.5
// Kept well above the grid spacing (~0.25): shorter ripples are undersampled
// by the points and break up into scattered specks rather than reading as rings.
const RIPPLE_WAVELENGTH = 1.6
const RIPPLE_WIDTH = 1.8 // width of the ring train's envelope
const RIPPLE_SPREAD = 0.35 // amplitude falls off as 1 / (1 + spread * distance travelled), like a real ring losing height as it widens
const RIPPLE_DECAY = 0.55 // amplitude falloff per second
const RIPPLE_GAIN = 0.07 // ring amplitude per unit of crossing speed
const RIPPLE_MAX = 0.3
const RIPPLE_MIN_SPEED = 0.8 // slower crossings (gentle bobbing) don't ripple
const RIPPLE_COOLDOWN = 0.25

// Canvas cost — see SceneCanvas. The AO pass is off entirely: it has nothing
// to shade, since these materials don't write depth. DPR is capped per mode:
// points are fill-rate bound, so 1.5 cuts their pixel count ~44% on a 2x
// screen for little visible softening. Lines are NOT capped — they're cheap,
// and a 1px line on a canvas the browser then upscales to fit the screen
// breaks up into dashes.
const DPR_BY_MODE = { points: [1, 1.5], lines: [1, 2] }

// Camera — low over the water, looking out toward the horizon, with a slow
// bob (as if floating) and a little pointer parallax.
const CAMERA_POSITION = [0, 3.2, 12]
const LOOK_AT = [0, 0, -6]
const BOB_AMPLITUDE = 0.12
const BOB_SPEED = 0.45
const PARALLAX_X = 1.2
const PARALLAX_Y = 0.5
const PARALLAX_LERP = 0.03

// Points vs lines is a #define, so each mode gets its own shader program.
// (A shared program with a uniform branch was tried and broke the lines: the
// GPU evaluates gl_PointCoord even in the untaken branch, and for lines it's
// undefined, knocking dashes out of them.) Both programs are compiled up
// front — see OceanSurface — so a mode switch never stalls on a compile.
const VERTEX_SHADER = /* glsl */ `
  #define WAVE_COUNT ${WAVES.length}
  #define RIPPLE_COUNT ${RIPPLE_COUNT}
  uniform float uTime;
  uniform float uTurbulence;
  uniform vec4 uWaves[WAVE_COUNT]; // xy = direction, z = wavelength, w = calm steepness
  uniform float uRoughSteepness[WAVE_COUNT];
  uniform float uHalfWidth;
  uniform float uEdgeFadeStart;
  uniform float uFadeNear;
  uniform float uFadeFar;
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uClock;
  uniform vec2 uObjXZ;
  uniform float uDome;
  uniform float uDomeRadius;
  uniform vec4 uRipples[RIPPLE_COUNT]; // xy = origin, z = start clock, w = strength (0 = unused)
  uniform float uRippleSpeed;
  uniform float uRippleK;
  uniform float uRippleWidth;
  uniform float uRippleDecay;
  uniform float uRippleSpread;
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

    // Cube interaction (see Cube): a dome of displaced water around it, plus
    // any ripple rings still spreading from earlier surface crossings.
    float r = distance(xz, uObjXZ);
    p.y += uDome * exp(-(r * r) / (uDomeRadius * uDomeRadius));
    for (int i = 0; i < RIPPLE_COUNT; i++) {
      vec4 ripple = uRipples[i];
      float age = uClock - ripple.z;
      if (ripple.w <= 0.0 || age < 0.0) continue;
      float d = distance(xz, ripple.xy) - uRippleSpeed * age;
      float travelled = uRippleSpeed * age;
      float envelope = exp(-(d * d) / (uRippleWidth * uRippleWidth)) * exp(-age * uRippleDecay)
        / (1.0 + uRippleSpread * travelled);
      p.y += ripple.w * envelope * cos(d * uRippleK);
    }
    vHeight = p.y;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float dist = -mvPosition.z;

    // Side fade on the undisplaced grid position (so the rim doesn't shimmer
    // with the waves); distance fade so the far edge reads as a horizon.
    float edgeFade = 1.0 - smoothstep(uEdgeFadeStart, 1.0, abs(xz.x) / uHalfWidth);
    vAlpha = edgeFade * (1.0 - smoothstep(uFadeNear, uFadeFar, dist));

    #ifdef WAVE_POINTS
      gl_PointSize = uPointSize * uPixelRatio / dist;
    #endif
  }
`

const FRAGMENT_SHADER = /* glsl */ `
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

    #ifdef WAVE_POINTS
      float d = length(gl_PointCoord - vec2(0.5));
      alpha *= smoothstep(0.5, 0.3, d);
    #endif

    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

// Flat grid on the XZ plane, row-major. With `lineIndex`, also builds an
// index of segment pairs joining neighbours along each row, for LineSegments.
function buildGrid({ cols, rows }, lineIndex) {
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

  if (lineIndex) {
    const index = new Uint32Array(rows * (cols - 1) * 2)
    let k = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        index[k++] = r * cols + c
        index[k++] = r * cols + c + 1
      }
    }
    geometry.setIndex(new BufferAttribute(index, 1))
  }
  return geometry
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// Swell height at (x, z) — the shader's Gerstner sum, height term only. It
// ignores the waves' horizontal shift, which is close enough to float on.
function swellHeight(x, z, time, turbulence) {
  let y = 0
  for (const w of WAVE_TERMS) {
    const steepness = w.calm + (w.rough - w.calm) * turbulence
    y += (steepness / w.k) * Math.sin(w.k * (w.dx * x + w.dz * z - w.speed * time))
  }
  return y
}

// `water` holds the uniforms shared with Cube (turbulence, clock, dome,
// ripples): Cube writes them, the surface's shader reads them.
function OceanSurface({ mode, turbulenceRef, water }) {
  const { gl, scene, camera } = useThree()
  const pointsRef = useRef(null)
  const linesRef = useRef(null)

  // Uniform objects shared by both materials, so the single per-frame update
  // below drives whichever mode is on screen (and a switch never jumps).
  const sharedUniforms = useMemo(
    () => ({
      ...water,
      uTime: { value: 0 },
      uWaves: { value: WAVES.map(([dx, dz, wavelength, calm]) => new Vector4(dx, dz, wavelength, calm)) },
      uRoughSteepness: { value: WAVES.map((w) => w[4]) },
      uHalfWidth: { value: SURFACE_HALF_WIDTH },
      uEdgeFadeStart: { value: EDGE_FADE_START },
      uFadeNear: { value: DISTANCE_FADE_NEAR },
      uFadeFar: { value: DISTANCE_FADE_FAR },
      uPointSize: { value: POINT_SIZE },
      uPixelRatio: { value: gl.getPixelRatio() },
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gl]
  )

  const pointGeometry = useMemo(() => buildGrid(POINT_GRID, false), [])
  const lineGeometry = useMemo(() => buildGrid(LINE_GRID, true), [])

  const [pointMaterial, lineMaterial] = useMemo(() => {
    const make = (defines) =>
      new ShaderMaterial({
        uniforms: sharedUniforms,
        defines,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
      })
    return [make({ WAVE_POINTS: '' }), make({})]
  }, [sharedUniforms])

  useEffect(
    () => () => {
      pointGeometry.dispose()
      lineGeometry.dispose()
      pointMaterial.dispose()
      lineMaterial.dispose()
    },
    [pointGeometry, lineGeometry, pointMaterial, lineMaterial]
  )

  // Pre-compile both programs on mount. renderer.compile() skips invisible
  // objects, so both are briefly made visible for it, then put back.
  useEffect(() => {
    const points = pointsRef.current
    const lines = linesRef.current
    const wasVisible = [points.visible, lines.visible]
    points.visible = lines.visible = true
    gl.compile(scene, camera)
    ;[points.visible, lines.visible] = wasVisible
  }, [gl, scene, camera])

  useFrame((state) => {
    sharedUniforms.uTime.value = state.clock.elapsedTime * TIME_SCALE
    sharedUniforms.uClock.value = state.clock.elapsedTime
    // Read live, not once at mount — the DPR changes when the mode does.
    sharedUniforms.uPixelRatio.value = state.gl.getPixelRatio()
    const turbulence = sharedUniforms.uTurbulence
    turbulence.value += (turbulenceRef.current - turbulence.value) * TURBULENCE_SMOOTHING
  })

  // Both stay mounted (see the pre-compile above); the mode just picks which
  // is visible. frustumCulled off: the grid's bounding sphere is computed
  // flat, and the shader displaces vertices outside it.
  return (
    <>
      <points
        ref={pointsRef}
        geometry={pointGeometry}
        material={pointMaterial}
        visible={mode === 'points'}
        frustumCulled={false}
      />
      <lineSegments
        ref={linesRef}
        geometry={lineGeometry}
        material={lineMaterial}
        visible={mode === 'lines'}
        frustumCulled={false}
      />
    </>
  )
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

// The cube, plus an invisible plane at water level that catches clicks on the
// water. Its motion is simulated here each frame and fed to the surface
// shader through `water` (dome + ripple uniforms). A tap on the cube itself
// stops propagation, so it never also counts as a tap on the water behind it.
function Cube({ water }) {
  const tiltRef = useRef(null)
  const yawRef = useRef(null)
  const edgeMaterialRef = useRef(null)
  const boxGeometry = useMemo(() => new BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), [])
  const edgeGeometry = useMemo(() => new EdgesGeometry(boxGeometry), [boxGeometry])

  useEffect(
    () => () => {
      boxGeometry.dispose()
      edgeGeometry.dispose()
    },
    [boxGeometry, edgeGeometry]
  )

  // Mutable sim state, never rendered through React. `target` is where the
  // spring pulls (floating or sunk); `pending` is a spot to surface at next,
  // applied once the cube is deep enough to move there unseen.
  const sim = useRef({
    x: FIRST_RISE_AT[0],
    z: FIRST_RISE_AT[1],
    y: CUBE_SUNK_Y,
    vy: 0,
    target: 'down',
    pending: { x: FIRST_RISE_AT[0], z: FIRST_RISE_AT[1] },
    holdUntil: FIRST_RISE_DELAY,
    tiltX: 0,
    tiltZ: 0,
    prevTop: null,
    prevBottom: null,
    lastRipple: -Infinity,
    nextRipple: 0,
  })

  const raiseAt = (x, z) => {
    const s = sim.current
    s.pending = {
      x: Math.min(CLICK_BOUNDS.x, Math.max(-CLICK_BOUNDS.x, x)),
      z: Math.min(CLICK_BOUNDS.zNear, Math.max(CLICK_BOUNDS.zFar, z)),
    }
    s.target = 'down' // already sunk: resurfaces right away; floating: sinks first
  }

  const sink = () => {
    sim.current.target = 'down'
    sim.current.pending = null
  }

  useFrame((state, delta) => {
    const s = sim.current
    const clock = state.clock.elapsedTime
    const time = clock * TIME_SCALE
    const turbulence = water.uTurbulence.value
    const dt = Math.min(delta, 1 / 30) // a dropped frame shouldn't kick the spring

    if (s.pending && s.y < CUBE_RESPAWN_BELOW && clock >= s.holdUntil) {
      s.x = s.pending.x
      s.z = s.pending.z
      s.pending = null
      s.target = 'up'
      s.prevTop = s.prevBottom = null
      yawRef.current.rotation.y = Math.random() * Math.PI * 0.5
    }

    const surface = swellHeight(s.x, s.z, time, turbulence)
    const targetY = s.target === 'up' ? surface + CUBE_FLOAT_OFFSET : CUBE_SUNK_Y
    s.vy += (SPRING_STIFFNESS * (targetY - s.y) - SPRING_DAMPING * s.vy) * dt
    s.y += s.vy * dt

    // Face heights relative to the water directly around the cube.
    const top = s.y + CUBE_SIZE / 2 - surface
    const bottom = s.y - CUBE_SIZE / 2 - surface

    // A face crossing the surface fast enough sends out a ripple ring.
    if (s.prevTop !== null) {
      const crossed = Math.sign(top) !== Math.sign(s.prevTop) || Math.sign(bottom) !== Math.sign(s.prevBottom)
      const speed = Math.abs(s.vy)
      if (crossed && speed > RIPPLE_MIN_SPEED && clock - s.lastRipple > RIPPLE_COOLDOWN) {
        water.uRipples.value[s.nextRipple].set(s.x, s.z, clock, Math.min(speed * RIPPLE_GAIN, RIPPLE_MAX))
        s.nextRipple = (s.nextRipple + 1) % RIPPLE_COUNT
        s.lastRipple = clock
      }
    }
    s.prevTop = top
    s.prevBottom = bottom

    // Dome: only while the cube is near/through the surface and its bottom is
    // still in the water; its sign follows the direction of travel.
    const proximity = smoothstep(-DOME_DEPTH, 0, top) * (1 - smoothstep(-0.2, 0.4, bottom))
    const push = Math.min(1, Math.max(-0.6, s.vy / DOME_REFERENCE_SPEED))
    water.uDome.value = DOME_PEAK * proximity * push
    water.uObjXZ.value.set(s.x, s.z)

    // Tilt with the swell's slope — the surface normal is (-dh/dx, 1, -dh/dz).
    const e = SLOPE_SAMPLE
    const dhdx = (swellHeight(s.x + e, s.z, time, turbulence) - swellHeight(s.x - e, s.z, time, turbulence)) / (2 * e)
    const dhdz = (swellHeight(s.x, s.z + e, time, turbulence) - swellHeight(s.x, s.z - e, time, turbulence)) / (2 * e)
    const floating = smoothstep(-DOME_DEPTH, 0, top)
    s.tiltX += (-Math.atan(dhdz) * TILT_FOLLOW * floating - s.tiltX) * TILT_LERP
    s.tiltZ += (Math.atan(dhdx) * TILT_FOLLOW * floating - s.tiltZ) * TILT_LERP

    tiltRef.current.position.set(s.x, s.y, s.z)
    tiltRef.current.rotation.set(s.tiltX, 0, s.tiltZ)
    edgeMaterialRef.current.opacity = smoothstep(CUBE_EDGE_FADE[0], CUBE_EDGE_FADE[1], top)
  })

  return (
    <>
      <mesh
        rotation-x={-Math.PI / 2}
        onPointerDown={(event) => raiseAt(event.point.x, event.point.z)}
      >
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <group ref={tiltRef} position={[FIRST_RISE_AT[0], CUBE_SUNK_Y, FIRST_RISE_AT[1]]}>
        <group ref={yawRef}>
          <mesh
            geometry={boxGeometry}
            onPointerDown={(event) => {
              event.stopPropagation()
              sink()
            }}
          >
            <meshStandardMaterial color={CUBE_FILL_COLOR} roughness={0.6} metalness={0} />
          </mesh>
          <lineSegments geometry={edgeGeometry}>
            <lineBasicMaterial ref={edgeMaterialRef} color={CUBE_EDGE_COLOR} transparent opacity={0} />
          </lineSegments>
        </group>
      </group>
    </>
  )
}

// HTML overlay (like Nav/Hint), styled to match Hint's muted monospace. The
// slider writes straight into a ref rather than React state, so dragging never
// re-renders the canvas — the frame loop picks the new value up and eases
// toward it.
function Controls({ turbulenceRef, mode, onToggleMode }) {
  return (
    <div
      style={{
        position: 'fixed',
        // Tucked under the nav's links rather than at the bottom, where it
        // would collide with the centred Hint on a phone-width screen.
        top: '3.25rem',
        right: '1.5rem',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '0.6rem',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: '0.75rem',
        letterSpacing: '0.04em',
        color: 'rgba(244, 244, 240, 0.55)',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        turbulence
        <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        defaultValue={turbulenceRef.current}
        onInput={(event) => (turbulenceRef.current = Number(event.currentTarget.value))}
        style={{ width: '8rem', accentColor: '#e6f0f2' }}
        />
      </label>
      <button type="button" onClick={onToggleMode} style={{ all: 'unset', cursor: 'pointer' }}>
        <span style={{ color: mode === 'points' ? '#f4f4f0' : undefined }}>points</span>
        {' / '}
        <span style={{ color: mode === 'lines' ? '#f4f4f0' : undefined }}>lines</span>
      </button>
    </div>
  )
}

export default function Type06() {
  const [mode, setMode] = useState('points')
  const toggleMode = useMemo(() => () => setMode((m) => (m === 'points' ? 'lines' : 'points')), [])
  const turbulenceRef = useRef(TURBULENCE_DEFAULT)
  const water = useMemo(
    () => ({
      uTurbulence: { value: TURBULENCE_DEFAULT },
      uClock: { value: 0 },
      uObjXZ: { value: new Vector2() },
      uDome: { value: 0 },
      uRipples: { value: Array.from({ length: RIPPLE_COUNT }, () => new Vector4()) },
    }),
    []
  )

  return (
    <>
      <SceneCanvas
        cameraPosition={CAMERA_POSITION}
        fov={50}
        orbitControls={false}
        background={BACKGROUND_COLOR}
        dpr={DPR_BY_MODE[mode]}
        ambientOcclusion={false}
      >
        <OceanSurface mode={mode} turbulenceRef={turbulenceRef} water={water} />
        <Cube water={water} />
        <CameraRig />
      </SceneCanvas>
      <Controls turbulenceRef={turbulenceRef} mode={mode} onToggleMode={toggleMode} />
      <Hint text="click the water" dismissOn={['pointerdown']} dark />
    </>
  )
}
