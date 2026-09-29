import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, ShaderMaterial, Vector2, Vector3, Vector4 } from 'three'
import SceneCanvas from '../../shared/SceneCanvas'
import Hint from '../../shared/Hint'

// Open-ocean surface (a rolling swell, not a breaking wave), rendered two ways
// from the exact same wave function so they can be compared side by side:
// a dense field of points, or rows of lines running across the view. Click /
// tap the canvas to switch between them; the slider sets how rough the sea is.
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

function OceanSurface({ mode, turbulenceRef }) {
  const { gl, scene, camera } = useThree()
  const pointsRef = useRef(null)
  const linesRef = useRef(null)

  // Uniform objects shared by both materials, so the single per-frame update
  // below drives whichever mode is on screen (and a switch never jumps).
  const sharedUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uTurbulence: { value: turbulenceRef.current },
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

// Click / tap on the canvas (not the nav or slider) flips between render modes.
function ModeToggle({ onToggle }) {
  const { gl } = useThree()

  useEffect(() => {
    const el = gl.domElement
    el.addEventListener('pointerdown', onToggle)
    return () => el.removeEventListener('pointerdown', onToggle)
  }, [gl, onToggle])

  return null
}

// HTML overlay (like Nav/Hint), styled to match Hint's muted monospace. Writes
// straight into a ref rather than React state, so dragging never re-renders
// the canvas — the frame loop picks the new value up and eases toward it.
function TurbulenceSlider({ turbulenceRef }) {
  return (
    <label
      style={{
        position: 'fixed',
        // Tucked under the nav's links rather than at the bottom, where it
        // would collide with the centred Hint on a phone-width screen.
        top: '3.25rem',
        right: '1.5rem',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: '0.75rem',
        letterSpacing: '0.04em',
        color: 'rgba(244, 244, 240, 0.55)',
      }}
    >
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
  )
}

export default function Type06() {
  const [mode, setMode] = useState('points')
  const toggleMode = useMemo(() => () => setMode((m) => (m === 'points' ? 'lines' : 'points')), [])
  const turbulenceRef = useRef(TURBULENCE_DEFAULT)

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
        <OceanSurface mode={mode} turbulenceRef={turbulenceRef} />
        <CameraRig />
        <ModeToggle onToggle={toggleMode} />
      </SceneCanvas>
      <TurbulenceSlider turbulenceRef={turbulenceRef} />
      <Hint text="click to switch points / lines" dismissOn={['pointerdown']} dark />
    </>
  )
}
