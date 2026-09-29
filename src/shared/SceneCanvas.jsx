import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom, N8AO, Vignette } from '@react-three/postprocessing'
import ErrorBoundary from './ErrorBoundary'

const BACKGROUND_COLOR = '#F4F4F0'

function SceneErrorNotice(error) {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        color: '#333',
        background: '#f5f5f5',
        textAlign: 'center',
        padding: '2rem',
      }}
    >
      <div>
        Something went wrong loading the scene.
        <pre style={{ marginTop: '1rem', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
          {error?.stack || error?.message || String(error)}
        </pre>
      </div>
    </div>
  )
}

export default function SceneCanvas({
  cameraPosition = [10, 8, 10],
  fov = 50,
  orbitControls = true,
  background = BACKGROUND_COLOR,
  // Device-pixel-ratio range handed to r3f. Its default is [1, 2]; a
  // fill-rate-heavy scene can cap this lower (e.g. [1, 1.5]) for a big win on
  // retina screens with little visible softening.
  dpr = [1, 2],
  // N8AO is the priciest pass in the stack. Scenes whose materials don't write
  // depth (points, lines, transparent shaders) get nothing from it, so they can
  // switch it off.
  ambientOcclusion = true,
  children,
}) {
  return (
    <ErrorBoundary fallback={SceneErrorNotice}>
      <Canvas style={{ width: '100vw', height: '100vh' }} dpr={dpr} camera={{ position: cameraPosition, fov }}>
        {/* Pass background={null} to skip this and set scene.background yourself
            (e.g. to a gradient texture) from a child component instead. */}
        {background && <color attach="background" args={[background]} />}
        <ambientLight intensity={0.7} />
        <hemisphereLight args={['#ffffff', '#e4e4de', 0.6]} />
        <directionalLight position={[5, 10, 5]} intensity={0.45} />
        <Suspense fallback={null}>{children}</Suspense>
        {orbitControls && <OrbitControls />}
        <EffectComposer>
          {ambientOcclusion && (
            <N8AO aoRadius={0.6} intensity={2.5} distanceFalloff={1} quality="medium" color="#000000" />
          )}
          <Bloom mipmapBlur luminanceThreshold={0.7} luminanceSmoothing={0.3} intensity={0.4} />
          <Vignette eskil={false} offset={0.3} darkness={0.3} />
        </EffectComposer>
      </Canvas>
    </ErrorBoundary>
  )
}
