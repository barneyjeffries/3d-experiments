import { useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import { FileLoader } from 'three'
import { FontLoader, TTFLoader, TextGeometry } from 'three-stdlib'

// TTFLoader.load() (used by useLoader for URL fetches) skips its own convert() step
// and returns the raw opentype.js Font object, so we fetch the buffer ourselves and
// call TTFLoader.parse() directly to get the converted glyph data.
export function useFont(fontUrl) {
  const buffer = useLoader(FileLoader, fontUrl, (loader) => loader.setResponseType('arraybuffer'))
  return useMemo(() => {
    const ttfData = new TTFLoader().parse(buffer)
    return new FontLoader().parse(ttfData)
  }, [buffer])
}

const GEOMETRY_DEFAULTS = {
  size: 1,
  height: 0.15,
  curveSegments: 8,
  bevelEnabled: true,
  bevelThickness: 0.02,
  bevelSize: 0.015,
  bevelSegments: 3,
}

// Builds one centered TextGeometry per entry in `texts` (each entry can be a
// single glyph or a whole phrase) and returns them keyed by that text.
export function useTextGeometries(font, texts, options) {
  const opts = { ...GEOMETRY_DEFAULTS, ...options }
  return useMemo(() => {
    const map = {}
    for (const text of texts) {
      const geometry = new TextGeometry(text, { font, ...opts })
      geometry.center()
      map[text] = geometry
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font, texts, JSON.stringify(opts)])
}
