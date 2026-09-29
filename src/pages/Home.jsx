import { Link } from 'react-router-dom'

const EXPERIMENTS = [
  { path: '/type-01', label: 'Type 01', description: 'Scattered typography, instanced glyphs' },
  { path: '/type-02', label: 'Type 02', description: 'Scroll-driven scatter with per-letter lag' },
  { path: '/type-03', label: 'Type 03', description: 'Physics-based falling letters, scroll drops the floor' },
  { path: '/type-04', label: 'Type 04', description: 'Physics pile duplicate — base for the scroll-driven word rise' },
  { path: '/type-05', label: 'Type 05', description: 'GPU particle cloud that forms typed letters' },
  { path: '/type-06', label: 'Type 06', description: 'Ocean surface swell — points or lines' },
  { path: '/type-07', label: 'Type 07', description: 'Portfolio prototype — projects surface from the sea' },
]

export default function Home() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        background: '#F4F4F0',
        color: '#333',
      }}
    >
      <h1 style={{ fontSize: '1rem', fontWeight: 600, letterSpacing: '0.02em', marginBottom: '2rem' }}>
        Barney Jeffries / experiments
      </h1>
      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {EXPERIMENTS.map((exp) => (
          <li key={exp.path}>
            <Link to={exp.path} style={{ color: '#333', fontSize: '1.1rem', textDecoration: 'none' }}>
              {exp.label} <span style={{ opacity: 0.5 }}>— {exp.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
