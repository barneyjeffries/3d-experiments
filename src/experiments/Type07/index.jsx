import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  EdgesGeometry,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Plane,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three'
import SceneCanvas from '../../shared/SceneCanvas'

// Portfolio prototype built on Type06's ocean (lines mode). The project index
// is a real HTML list — accessible, crawlable, usable without the 3D — and the
// sea is the stage that responds to it: each project is a card floating with
// just a sliver showing above the water. Hovering a title (or the card
// itself) makes its card rise further out; selecting one lifts it clear of the water,
// glides the camera in, calms the sea and swaps the list for a detail panel.
// Back (button or Esc) reverses all of it.
//
// Self-contained on purpose, like the other experiments — the ocean here is a
// copy of Type06's, extended from one displacing object to several. For the
// real site it would be worth extracting as a shared component.

// Placeholder content — swap for real projects. `position` is the card's spot
// on the water [x, z]; the camera looks toward -z, so larger negative z is
// further away.
const PROJECTS = [
  {
    id: 'tidal-index',
    title: 'Tidal Index',
    discipline: 'Brand identity',
    year: 2025,
    hue: 200,
    position: [-3, -8],
    description: 'Placeholder — a line or two on the brief, then what you made and why it mattered.',
  },
  {
    id: 'north-light',
    title: 'North Light',
    discipline: 'Web design',
    year: 2025,
    hue: 30,
    position: [1.5, -11],
    description: 'Placeholder — a short project summary, with room for a role and a link out.',
  },
  {
    id: 'paper-harbour',
    title: 'Paper Harbour',
    discipline: 'Editorial',
    year: 2024,
    hue: 340,
    position: [4.5, -6.5],
    description: 'Placeholder — the kind of thing a case study page would expand on.',
  },
  {
    id: 'signal-noise',
    title: 'Signal & Noise',
    discipline: 'Creative code',
    year: 2024,
    hue: 150,
    position: [8, -10.5],
    description: 'Placeholder — could link back to experiments like this one.',
  },
  {
    id: 'lowland',
    title: 'Lowland',
    discipline: 'Art direction',
    year: 2023,
    hue: 260,
    position: [-0.5, -15.5],
    description: 'Placeholder — a line or two on the brief, then what you made and why it mattered.',
  },
  {
    id: 'afterglow',
    title: 'Afterglow',
    discipline: 'Motion',
    year: 2023,
    hue: 10,
    position: [5, -16],
    description: 'Placeholder — a short project summary, with room for a role and a link out.',
  },
].map((project, i) => ({ ...project, number: String(i + 1).padStart(2, '0') }))

const BACKGROUND_COLOR = '#05090d'
const TROUGH_COLOR = [0.09, 0.19, 0.27] // raw RGB, same convention as Type05/06
const CREST_COLOR = [0.9, 0.95, 0.96]
const TROUGH_ALPHA = 0.35
const HEIGHT_RANGE = 0.8

// Surface extent — deeper and wider than Type06's, since the camera here
// travels out over the water to frame a selected card, and the far/side
// edges must still sit beyond the fades from wherever it ends up.
const SURFACE_HALF_WIDTH = 44
const SURFACE_NEAR_Z = 10
const SURFACE_FAR_Z = -48
const EDGE_FADE_START = 0.75
const DISTANCE_FADE_NEAR = 12
const DISTANCE_FADE_FAR = 36
const LINE_GRID = { cols: 528, rows: 97 } // same spacing as Type06's lines

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
// The sea calms while a project is open, so attention settles on the card.
const TURBULENCE_BROWSING = 0.35
const TURBULENCE_FOCUSED = 0.1
const TURBULENCE_SMOOTHING = 0.03

// Cards — upright, facing the camera, with the project cover on the front.
const CARD_WIDTH = 2.4
const CARD_HEIGHT = 3
const CARD_DEPTH = 0.12
const CARD_FILL_COLOR = '#0b1117'
const CARD_EDGE_COLOR = '#e6f0f2'
const CARD_TEXTURE_SIZE = [480, 600] // same 4:5 aspect as the card face
// Resting heights per state — the card's TOP relative to the local swell,
// except `selected`, which is an absolute height clear of the water.
// Everything below the waterline is clipped away (see Card), since the line
// water is see-through and wouldn't hide a submerged card on its own.
const TOP_IDLE = 0.35 // a sliver showing, like a marker
const TOP_HOVER = 1.6 // rises about half out
const TOP_HIDDEN = -1.2 // sunk out of sight while another project is open
const SELECTED_CENTER_Y = CARD_HEIGHT / 2 + 0.5 // bottom edge lifted clear of the water
const SELECTED_BOB = 0.05
const SPRING_STIFFNESS = 4
const SPRING_DAMPING = 1.8 // damping ratio ~0.45, as Type06's cube
// The select rise runs at twice the frequency (4x stiffness, 2x damping —
// same ~0.45 ratio, so the same bounce, just quicker), keeping pace with the
// camera's glide in.
const SELECTED_SPRING_STIFFNESS = 16
const SELECTED_SPRING_DAMPING = 3.6
const TILT_FOLLOW = 0.6
const TILT_LERP = 0.08
const YAW_LERP = 0.06
const SLOPE_SAMPLE = 0.6
// On load, each card briefly rises in turn, so it's clear the slivers are
// something before anyone hovers.
const INTRO_START = 1
const INTRO_STAGGER = 0.3
const INTRO_PEEK_DURATION = 1.3

// Water displaced by the cards — Type06's dome + ripples, for several objects.
// Gentler than Type06's cube: several cards can move at once (the intro,
// or sweeping down the list), and their rings stack.
const DOME_PEAK = 0.3
const DOME_RADIUS = 1.4
const DOME_DEPTH = 1.6
const DOME_REFERENCE_SPEED = 3
const RIPPLE_COUNT = 8
const RIPPLE_SPEED = 3.5
const RIPPLE_WAVELENGTH = 1.6
const RIPPLE_WIDTH = 1.8
const RIPPLE_SPREAD = 0.35
const RIPPLE_DECAY = 0.55
const RIPPLE_GAIN = 0.035
const RIPPLE_MAX = 0.14
const RIPPLE_MIN_SPEED = 0.8
const RIPPLE_COOLDOWN = 0.25

// Camera — Type06's floating viewpoint while browsing. When a project is
// open it glides out to the card, framing it off-centre: to the right on a
// landscape screen (the detail panel is on the left), or high on a portrait
// one (the panel is along the bottom).
const CAMERA_POSITION = [0, 3.2, 12]
const LOOK_AT = [0, 0, -6]
const BOB_AMPLITUDE = 0.12
const BOB_SPEED = 0.45
const PARALLAX_X = 1.2
const PARALLAX_Y = 0.5
const CAMERA_EASE = 3.2 // exponential ease rate, per second — higher is snappier
const FOCUS_DISTANCE = 6.5
const FOCUS_DISTANCE_PORTRAIT = 9.5
const FOCUS_HEIGHT = 0.3
const FOCUS_SHIFT_X = 1.8
const FOCUS_SHIFT_Y = 1.6

const VERTEX_SHADER = /* glsl */ `
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

    // Card interaction (see Card): a dome of displaced water around each
    // moving card, plus ripple rings still spreading from surface crossings.
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
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
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

// Rows of line segments across the view, on a flat XZ grid (displaced in the shader).
function buildLineGrid({ cols, rows }) {
  const positions = new Float32Array(cols * rows * 3)
  for (let r = 0; r < rows; r++) {
    const z = SURFACE_FAR_Z + ((SURFACE_NEAR_Z - SURFACE_FAR_Z) * r) / (rows - 1)
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3
      positions[i] = -SURFACE_HALF_WIDTH + (2 * SURFACE_HALF_WIDTH * c) / (cols - 1)
      positions[i + 2] = z
    }
  }
  const index = new Uint32Array(rows * (cols - 1) * 2)
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      index[k++] = r * cols + c
      index[k++] = r * cols + c + 1
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(index, 1))
  return geometry
}

// Placeholder cover: a tinted "image" area (with a few faint rules echoing
// the sea's lines), then the number, title and meta. Swap for real imagery
// by loading a texture instead.
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

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

// `water` holds the uniforms Cards write (object domes, ripples) and the
// surface's shader reads.
function OceanSurface({ water, focused }) {
  // Cards clip themselves at the waterline with per-material clipping planes,
  // which the renderer ignores unless local clipping is switched on.
  const { gl } = useThree()
  useEffect(() => {
    gl.localClippingEnabled = true
    return () => {
      gl.localClippingEnabled = false
    }
  }, [gl])

  const focusedRef = useRef(focused)
  useEffect(() => {
    focusedRef.current = focused
  }, [focused])

  const uniforms = useMemo(
    () => ({
      ...water,
      uTime: { value: 0 },
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
    }),
    [water]
  )

  const geometry = useMemo(() => buildLineGrid(LINE_GRID), [])
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
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
    const target = focusedRef.current ? TURBULENCE_FOCUSED : TURBULENCE_BROWSING
    uniforms.uTurbulence.value += (target - uniforms.uTurbulence.value) * TURBULENCE_SMOOTHING
  })

  // frustumCulled off: the grid's bounding box is computed flat, and the
  // shader displaces vertices outside it.
  return <lineSegments geometry={geometry} material={material} frustumCulled={false} />
}

// One project card. Its state ('idle' | 'hover' | 'selected' | 'hidden')
// comes from the page; the motion (a spring toward that state's height, plus
// tilting with the swell) is simulated here each frame, and the sim state is
// published to `cardStates` so the camera can find a selected card.
function Card({ project, index, state: cardState, water, emitRipple, cardStates, onHover, onUnhover, onSelect }) {
  const stateRef = useRef(cardState)
  useEffect(() => {
    stateRef.current = cardState
  }, [cardState])

  const groupRef = useRef(null)
  const [x, z] = project.position
  // At rest, each card turns to face the browsing camera.
  const restYaw = Math.atan2(CAMERA_POSITION[0] - x, CAMERA_POSITION[2] - z)

  // `waterline` is this card's clipping plane: it keeps only what's above the
  // water, and is re-fitted to the local swell (height, slope and dome) every
  // frame, so the card reads as rising out of the sea rather than sitting
  // behind see-through water.
  const { boxGeometry, edgeGeometry, waterline, texture, materials, edgeMaterial } = useMemo(() => {
    const box = new BoxGeometry(CARD_WIDTH, CARD_HEIGHT, CARD_DEPTH)
    const plane = new Plane()
    const cover = drawCoverTexture(project)
    const side = new MeshStandardMaterial({
      color: CARD_FILL_COLOR,
      roughness: 0.6,
      metalness: 0,
      clippingPlanes: [plane],
    })
    const front = new MeshBasicMaterial({ map: cover, toneMapped: false, clippingPlanes: [plane] })
    return {
      boxGeometry: box,
      edgeGeometry: new EdgesGeometry(box),
      waterline: plane,
      texture: cover,
      // BoxGeometry face order: +x, -x, +y, -y, +z (front, toward the camera), -z.
      materials: [side, side, side, side, front, side],
      edgeMaterial: new LineBasicMaterial({ color: CARD_EDGE_COLOR, clippingPlanes: [plane] }),
    }
  }, [project])

  useEffect(
    () => () => {
      boxGeometry.dispose()
      edgeGeometry.dispose()
      texture.dispose()
      materials[0].dispose()
      materials[4].dispose()
      edgeMaterial.dispose()
    },
    [boxGeometry, edgeGeometry, texture, materials, edgeMaterial]
  )
  const waterNormal = useMemo(() => new Vector3(), [])
  const waterPoint = useMemo(() => new Vector3(), [])

  const sim = useRef({
    x,
    z,
    y: -CARD_HEIGHT / 2 + TOP_HIDDEN,
    vy: 0,
    tiltX: 0,
    tiltZ: 0,
    yaw: restYaw,
    prevTop: null,
    prevBottom: null,
    lastRipple: -Infinity,
  })

  useEffect(() => {
    cardStates.current[index] = sim.current
  }, [cardStates, index])

  useFrame((frame, delta) => {
    const s = sim.current
    const clock = frame.clock.elapsedTime
    const time = clock * TIME_SCALE
    const turbulence = water.uTurbulence.value
    const dt = Math.min(delta, 1 / 30)

    let mode = stateRef.current
    const introAt = INTRO_START + index * INTRO_STAGGER
    if (mode === 'idle' && clock > introAt && clock < introAt + INTRO_PEEK_DURATION) mode = 'hover'

    const surface = swellHeight(s.x, s.z, time, turbulence)
    let targetY
    if (mode === 'selected') targetY = SELECTED_CENTER_Y + Math.sin(clock * 0.8) * SELECTED_BOB
    else if (mode === 'hover') targetY = surface + TOP_HOVER - CARD_HEIGHT / 2
    else if (mode === 'hidden') targetY = surface + TOP_HIDDEN - CARD_HEIGHT / 2
    else targetY = surface + TOP_IDLE - CARD_HEIGHT / 2
    const selected = mode === 'selected'
    const stiffness = selected ? SELECTED_SPRING_STIFFNESS : SPRING_STIFFNESS
    const damping = selected ? SELECTED_SPRING_DAMPING : SPRING_DAMPING
    s.vy += (stiffness * (targetY - s.y) - damping * s.vy) * dt
    s.y += s.vy * dt

    const top = s.y + CARD_HEIGHT / 2 - surface
    const bottom = s.y - CARD_HEIGHT / 2 - surface

    if (s.prevTop !== null) {
      const crossed = Math.sign(top) !== Math.sign(s.prevTop) || Math.sign(bottom) !== Math.sign(s.prevBottom)
      const speed = Math.abs(s.vy)
      if (crossed && speed > RIPPLE_MIN_SPEED && clock - s.lastRipple > RIPPLE_COOLDOWN) {
        emitRipple(s.x, s.z, clock, Math.min(speed * RIPPLE_GAIN, RIPPLE_MAX))
        s.lastRipple = clock
      }
    }
    s.prevTop = top
    s.prevBottom = bottom

    const proximity = smoothstep(-DOME_DEPTH, 0, top) * (1 - smoothstep(-0.2, 0.4, bottom))
    const push = Math.min(1, Math.max(-0.6, s.vy / DOME_REFERENCE_SPEED))
    const dome = DOME_PEAK * proximity * push
    water.uObjects.value[index].set(s.x, s.z, dome)

    const e = SLOPE_SAMPLE
    const dhdx = (swellHeight(s.x + e, s.z, time, turbulence) - swellHeight(s.x - e, s.z, time, turbulence)) / (2 * e)
    const dhdz = (swellHeight(s.x, s.z + e, time, turbulence) - swellHeight(s.x, s.z - e, time, turbulence)) / (2 * e)

    // Waterline: the local surface as a plane — normal (-dh/dx, 1, -dh/dz),
    // through the swell height plus this card's own dome.
    waterNormal.set(-dhdx, 1, -dhdz).normalize()
    waterPoint.set(s.x, surface + dome, s.z)
    waterline.setFromNormalAndCoplanarPoint(waterNormal, waterPoint)

    // Ride the swell while in the water; hang level once lifted clear.
    const riding = mode === 'selected' ? 0 : smoothstep(-DOME_DEPTH, 0, top)
    s.tiltX += (-Math.atan(dhdz) * TILT_FOLLOW * riding - s.tiltX) * TILT_LERP
    s.tiltZ += (Math.atan(dhdx) * TILT_FOLLOW * riding - s.tiltZ) * TILT_LERP
    s.yaw += ((mode === 'selected' ? 0 : restYaw) - s.yaw) * YAW_LERP

    const group = groupRef.current
    group.position.set(s.x, s.y, s.z)
    group.rotation.set(s.tiltX, s.yaw, s.tiltZ, 'YXZ')
  })

  return (
    <group ref={groupRef}>
      <mesh
        geometry={boxGeometry}
        material={materials}
        onPointerOver={(event) => {
          event.stopPropagation()
          onHover(project.id)
        }}
        onPointerOut={() => onUnhover(project.id)}
        onPointerDown={(event) => {
          // onPointerDown, not onClick — see Type03: r3f's onClick often
          // never fires on an object that's moving under the pointer.
          event.stopPropagation()
          onSelect(project.id)
        }}
      />
      <lineSegments geometry={edgeGeometry} material={edgeMaterial} />
    </group>
  )
}

function CameraRig({ selectedIndex, cardStates }) {
  const selectedRef = useRef(selectedIndex)
  useEffect(() => {
    selectedRef.current = selectedIndex
  }, [selectedIndex])

  const parallax = useRef(new Vector2())
  const look = useRef(new Vector3(...LOOK_AT))
  const targetPosition = useRef(new Vector3())
  const targetLook = useRef(new Vector3())

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime
    const ease = 1 - Math.exp(-CAMERA_EASE * Math.min(delta, 1 / 30))
    const card = selectedRef.current !== null ? cardStates.current[selectedRef.current] : null

    if (card) {
      const portrait = state.size.width < state.size.height
      const shiftX = portrait ? 0 : -FOCUS_SHIFT_X
      const distance = portrait ? FOCUS_DISTANCE_PORTRAIT : FOCUS_DISTANCE
      targetPosition.current.set(card.x + shiftX, SELECTED_CENTER_Y + FOCUS_HEIGHT, card.z + distance)
      targetLook.current.set(card.x + shiftX, SELECTED_CENTER_Y - (portrait ? FOCUS_SHIFT_Y : 0), card.z)
      parallax.current.set(0, 0)
    } else {
      parallax.current.lerp(state.pointer, 0.03)
      targetPosition.current.set(
        CAMERA_POSITION[0] + parallax.current.x * PARALLAX_X,
        CAMERA_POSITION[1] + parallax.current.y * PARALLAX_Y + Math.sin(t * BOB_SPEED) * BOB_AMPLITUDE,
        CAMERA_POSITION[2]
      )
      targetLook.current.set(...LOOK_AT)
    }

    state.camera.position.lerp(targetPosition.current, ease)
    look.current.lerp(targetLook.current, ease)
    state.camera.lookAt(look.current)
  })

  return null
}

// Page chrome for this experiment only. A <style> block rather than inline
// styles (as elsewhere in this repo) because the layout needs hover/focus
// states and a portrait breakpoint — matching CameraRig's portrait framing.
const STYLES = `
  /* Darkens the sea on the UI's side, so text never sits over bright crests. */
  .t07-scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    background: linear-gradient(to right, rgba(5, 9, 13, 0.85), rgba(5, 9, 13, 0) 42%);
  }
  .t07-list, .t07-detail {
    position: fixed;
    left: 1.5rem;
    top: 50%;
    z-index: 10;
    color: #f4f4f0;
    font-family: system-ui, sans-serif;
    transition: opacity 0.5s ease, transform 0.5s ease;
  }
  .t07-list { transform: translateY(-50%); }
  .t07-list.is-hidden { opacity: 0; pointer-events: none; transform: translate(-1rem, -50%); }
  .t07-kicker, .t07-num, .t07-meta, .t07-back {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
  }
  .t07-kicker { color: rgba(244, 244, 240, 0.45); margin-bottom: 1rem; }
  .t07-list ul { list-style: none; display: flex; flex-direction: column; gap: 0.2rem; }
  .t07-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 0.9rem;
    padding: 0.3rem 0;
    color: rgba(244, 244, 240, 0.5);
    transition: color 0.25s ease, transform 0.25s ease;
  }
  .t07-item.is-active { color: #f4f4f0; transform: translateX(0.4rem); }
  .t07-item:focus-visible, .t07-back:focus-visible { outline: 1px solid rgba(244, 244, 240, 0.5); outline-offset: 4px; }
  .t07-title { font-size: 1.35rem; font-weight: 500; }
  .t07-meta { opacity: 0.6; }
  .t07-detail {
    width: min(22rem, calc(100vw - 3rem));
    opacity: 0;
    pointer-events: none;
    transform: translate(-1rem, -50%);
  }
  .t07-detail.is-open {
    opacity: 1;
    pointer-events: auto;
    transform: translate(0, -50%);
    transition-delay: 0.18s; /* let the camera start moving first */
  }
  .t07-detail h2 { font-size: 2rem; font-weight: 600; margin: 0.6rem 0 0.4rem; }
  .t07-detail .t07-meta { display: block; margin-bottom: 1.2rem; }
  .t07-detail p { font-size: 0.95rem; line-height: 1.55; color: rgba(244, 244, 240, 0.7); }
  .t07-back { all: unset; cursor: pointer; display: inline-block; margin-top: 2rem; color: rgba(244, 244, 240, 0.55); }
  .t07-back:hover { color: #f4f4f0; }

  @media (max-aspect-ratio: 1/1) {
    .t07-scrim { background: linear-gradient(to top, rgba(5, 9, 13, 0.9), rgba(5, 9, 13, 0) 45%); }
    .t07-list, .t07-detail { top: auto; bottom: 1.5rem; right: 1.5rem; }
    .t07-list { transform: none; }
    .t07-list.is-hidden { transform: translateY(1rem); }
    .t07-title { font-size: 1.1rem; }
    .t07-detail { width: auto; transform: translateY(1rem); }
    .t07-detail.is-open { transform: none; }
    .t07-detail h2 { font-size: 1.5rem; }
  }
`

export default function Type07() {
  const [hoveredId, setHoveredId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  // Kept after closing, so the detail panel's content doesn't vanish
  // mid-fade-out.
  const [detailId, setDetailId] = useState(null)

  const water = useMemo(
    () => ({
      uTurbulence: { value: TURBULENCE_BROWSING },
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
  const cardStates = useRef([])

  const select = useCallback((id) => {
    setSelectedId(id)
    setDetailId(id)
    setHoveredId(null)
  }, [])
  const close = useCallback(() => setSelectedId(null), [])
  const hover = useCallback((id) => setHoveredId(id), [])
  const unhover = useCallback((id) => setHoveredId((current) => (current === id ? null : current)), [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Pointer cursor over a card (list items get theirs from CSS).
  useEffect(() => {
    document.body.style.cursor = hoveredId && !selectedId ? 'pointer' : ''
    return () => {
      document.body.style.cursor = ''
    }
  }, [hoveredId, selectedId])

  const selectedIndex = selectedId ? PROJECTS.findIndex((p) => p.id === selectedId) : null
  const detail = PROJECTS.find((p) => p.id === detailId)

  const cardStateFor = (id) => {
    if (selectedId) return id === selectedId ? 'selected' : 'hidden'
    return id === hoveredId ? 'hover' : 'idle'
  }

  return (
    <>
      <style>{STYLES}</style>
      <SceneCanvas
        cameraPosition={CAMERA_POSITION}
        fov={50}
        orbitControls={false}
        background={BACKGROUND_COLOR}
        ambientOcclusion={false}
      >
        <OceanSurface water={water} focused={selectedId !== null} />
        {PROJECTS.map((project, i) => (
          <Card
            key={project.id}
            project={project}
            index={i}
            state={cardStateFor(project.id)}
            water={water}
            emitRipple={emitRipple}
            cardStates={cardStates}
            onHover={selectedId ? () => {} : hover}
            onUnhover={unhover}
            onSelect={selectedId ? () => {} : select}
          />
        ))}
        <CameraRig selectedIndex={selectedIndex} cardStates={cardStates} />
      </SceneCanvas>

      <div className="t07-scrim" />
      <nav className={`t07-list${selectedId ? ' is-hidden' : ''}`} aria-hidden={selectedId ? true : undefined}>
        <p className="t07-kicker">selected work</p>
        <ul>
          {PROJECTS.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={`t07-item${hoveredId === project.id ? ' is-active' : ''}`}
                tabIndex={selectedId ? -1 : 0}
                onMouseEnter={() => hover(project.id)}
                onMouseLeave={() => unhover(project.id)}
                onFocus={() => hover(project.id)}
                onBlur={() => unhover(project.id)}
                onClick={() => select(project.id)}
              >
                <span className="t07-num">{project.number}</span>
                <span className="t07-title">{project.title}</span>
                <span className="t07-meta">{project.year}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <article className={`t07-detail${selectedId ? ' is-open' : ''}`} aria-hidden={selectedId ? undefined : true}>
        {detail && (
          <>
            <span className="t07-num">{detail.number}</span>
            <h2>{detail.title}</h2>
            <span className="t07-meta">
              {detail.discipline} · {detail.year}
            </span>
            <p>{detail.description}</p>
            <button type="button" className="t07-back" tabIndex={selectedId ? 0 : -1} onClick={close}>
              ← all projects
            </button>
          </>
        )}
      </article>
    </>
  )
}
