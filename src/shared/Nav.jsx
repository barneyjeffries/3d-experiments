import { Link } from 'react-router-dom'

const linkStyle = {
  color: '#333',
  textDecoration: 'none',
  fontSize: '0.8rem',
  letterSpacing: '0.02em',
  pointerEvents: 'auto',
}

const EXPERIMENT_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/type-01', label: '01' },
  { to: '/type-02', label: '02' },
  { to: '/type-03', label: '03' },
  { to: '/type-04', label: '04' },
]

export default function Nav() {
  return (
    <nav
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '1rem 1.5rem',
        fontFamily: 'system-ui, sans-serif',
        // Only the links themselves should catch clicks — the rest of the bar
        // must let mouse/drag events fall through to the canvas underneath.
        pointerEvents: 'none',
      }}
    >
      <Link to="/" style={{ ...linkStyle, fontWeight: 600 }}>
        Barney Jeffries / experiments
      </Link>
      <div style={{ display: 'flex', gap: '1.25rem' }}>
        {EXPERIMENT_LINKS.map((link) => (
          <Link key={link.to} to={link.to} style={linkStyle}>
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
