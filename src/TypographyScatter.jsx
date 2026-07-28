import { useMemo } from 'react'
import { useLoader } from '@react-three/fiber'
import { Instances, Instance } from '@react-three/drei'
import { FileLoader } from 'three'
import { FontLoader, TTFLoader, TextGeometry } from 'three-stdlib'
import fontUrl from './assets/fonts/SpaceGrotesk-Bold.ttf?url'

const PHRASE = 'everything moves'
const INSTANCE_COUNT_RANGE = [300, 500]
const VOLUME = { x: 6, y: 4, z: 6 }
const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

export default function TypographyScatter() {
  // TTFLoader.load() (used by useLoader for URL fetches) skips its own convert() step
  // and returns the raw opentype.js Font object, so we fetch the buffer ourselves and
  // call TTFLoader.parse() directly to get the converted glyph data.
  const buffer = useLoader(FileLoader, fontUrl, (loader) => loader.setResponseType('arraybuffer'))
  const font = useMemo(() => {
    const ttfData = new TTFLoader().parse(buffer)
    return new FontLoader().parse(ttfData)
  }, [buffer])

  const chars = useMemo(() => [...new Set(PHRASE.replace(/\s/g, '').split(''))], [])

  const geometries = useMemo(() => {
    const map = {}
    for (const char of chars) {
      const geometry = new TextGeometry(char, {
        font,
        size: GLYPH_SIZE,
        height: EXTRUDE_DEPTH,
        curveSegments: 8,
        bevelEnabled: true,
        bevelThickness: BEVEL_THICKNESS,
        bevelSize: BEVEL_SIZE,
        bevelSegments: 3,
      })
      geometry.center()
      map[char] = geometry
    }
    return map
  }, [font, chars])

  const grouped = useMemo(() => {
    const count = Math.round(randRange(...INSTANCE_COUNT_RANGE))
    const groups = {}
    for (const char of chars) groups[char] = []
    for (let i = 0; i < count; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)]
      groups[char].push({
        position: [
          randRange(-VOLUME.x, VOLUME.x),
          randRange(-VOLUME.y, VOLUME.y),
          randRange(-VOLUME.z, VOLUME.z),
        ],
        rotation: [randRange(0, Math.PI * 2), randRange(0, Math.PI * 2), randRange(0, Math.PI * 2)],
        scale: randRange(0.85, 1.15),
      })
    }
    return groups
  }, [chars])

  return (
    <>
      {chars.map((char) => {
        const instances = grouped[char]
        if (!instances.length) return null
        return (
          <Instances key={char} limit={instances.length}>
            <primitive object={geometries[char]} attach="geometry" />
            <meshStandardMaterial color="#ffffff" roughness={1} metalness={0} />
            {instances.map((inst, i) => (
              <Instance key={i} position={inst.position} rotation={inst.rotation} scale={inst.scale} />
            ))}
          </Instances>
        )
      })}
    </>
  )
}
