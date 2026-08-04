import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

// Delay before the hint fades in — a beat after the scene has had a moment
// to render, so it reads as a gentle appearance rather than part of the
// initial load.
const FADE_IN_DELAY_MS = 1000
const FADE_DURATION_MS = 700

// Keyed by route AND text in sessionStorage, so a dismissed hint doesn't
// reappear on revisiting the same experiment within the same tab/session —
// but does on a fresh visit. Including the text (not just the path) matters
// whenever a route's experiment gets swapped or its wording edited: without
// it, a dismissal recorded against the OLD content at that path would
// silently suppress a completely different hint that later ends up at the
// same URL (this bit us once already — a route renumbering left a stale
// dismissed-by-scrolling flag that hid the new "type something" prompt).
const STORAGE_PREFIX = 'hint-dismissed:'

// Small, muted on-screen prompt overlaid on top of a scene's canvas (an HTML
// overlay like Nav, not text inside the 3D scene). Fades in shortly after
// mount, then fades out for good once the user does whatever `dismissOn`
// listens for — e.g. dismissOn={['wheel', 'touchmove']} for a scroll-driven
// experiment, dismissOn={['keydown']} for a typing one.
export default function Hint({ text, dismissOn = [] }) {
  const location = useLocation()
  const storageKey = `${STORAGE_PREFIX}${location.pathname}:${text}`
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem(storageKey) === '1') return

    const showTimer = setTimeout(() => setVisible(true), FADE_IN_DELAY_MS)

    const dismiss = () => {
      setVisible(false)
      sessionStorage.setItem(storageKey, '1')
      dismissOn.forEach((eventName) => window.removeEventListener(eventName, dismiss))
    }
    dismissOn.forEach((eventName) => window.addEventListener(eventName, dismiss, { passive: true }))

    return () => {
      clearTimeout(showTimer)
      dismissOn.forEach((eventName) => window.removeEventListener(eventName, dismiss))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.75rem',
        left: '50%',
        transform: 'translateX(-50%)',
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: '0.75rem',
        letterSpacing: '0.04em',
        color: 'rgba(20, 20, 18, 0.38)',
        pointerEvents: 'none',
        zIndex: 10,
        opacity: visible ? 1 : 0,
        transition: `opacity ${FADE_DURATION_MS}ms ease`,
      }}
    >
      {text}
    </div>
  )
}
