import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import TypographyScatter from './TypographyScatter'
import ErrorBoundary from './ErrorBoundary'

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

function App() {
  return (
    <ErrorBoundary fallback={SceneErrorNotice}>
      <Canvas style={{ width: '100vw', height: '100vh' }} camera={{ position: [10, 8, 10], fov: 50 }}>
        <color attach="background" args={['#f5f5f5']} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[5, 10, 5]} intensity={0.5} />
        <Suspense fallback={null}>
          <TypographyScatter />
        </Suspense>
        <OrbitControls />
      </Canvas>
    </ErrorBoundary>
  )
}

export default App
