import { Link, useLocation } from 'react-router-dom'

// Routes with an inverted (black background) scene — the nav switches to
// light text on these so it stays readable over both themes.
const DARK_ROUTES = ['/type-05', '/type-06', '/type-07']

const EXPERIMENT_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/type-01', label: '01' },
  { to: '/type-02', label: '02' },
  { to: '/type-03', label: '03' },
  { to: '/type-04', label: '04' },
  { to: '/type-05', label: '05' },
  { to: '/type-06', label: '06' },
  { to: '/type-07', label: '07' },
]

export default function Nav() {
  const location = useLocation()
  const isDark = DARK_ROUTES.includes(location.pathname)

  const linkStyle = {
    color: isDark ? '#f4f4f0' : '#333',
    textDecoration: 'none',
    fontSize: '0.8rem',
    letterSpacing: '0.02em',
    pointerEvents: 'auto',
  }

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
