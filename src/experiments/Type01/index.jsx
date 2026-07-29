import { useMemo } from 'react'
import { Instances, Instance } from '@react-three/drei'
import SceneCanvas from '../../shared/SceneCanvas'
import { useFont, useTextGeometries } from '../../shared/useTypographyGeometries'
import fontUrl from '../../assets/fonts/SpaceGrotesk-Bold.ttf?url'

const PHRASE = 'everything moves'
const INSTANCE_COUNT_RANGE = [300, 500]
const VOLUME = { x: 6, y: 4, z: 6 }
const GLYPH_SIZE = 1
const EXTRUDE_DEPTH = 0.15
const BEVEL_THICKNESS = 0.02
const BEVEL_SIZE = 0.015
const BASE_COLOR = '#fcfcfa'
const ACCENT_COLOR = '#7fff00'
const ACCENT_RATIO = 0.125

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

function TypographyScatter() {
  const font = useFont(fontUrl)
  const chars = useMemo(() => [...new Set(PHRASE.replace(/\s/g, '').split(''))], [])
  const geometries = useTextGeometries(font, chars, {
    size: GLYPH_SIZE,
    height: EXTRUDE_DEPTH,
    bevelThickness: BEVEL_THICKNESS,
    bevelSize: BEVEL_SIZE,
  })

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
        color: Math.random() < ACCENT_RATIO ? ACCENT_COLOR : BASE_COLOR,
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
            <meshStandardMaterial color="#ffffff" roughness={0.85} metalness={0} />
            {instances.map((inst, i) => (
              <Instance
                key={i}
                position={inst.position}
                rotation={inst.rotation}
                scale={inst.scale}
                color={inst.color}
              />
            ))}
          </Instances>
        )
      })}
    </>
  )
}

export default function Type01() {
  return (
    <SceneCanvas>
      <TypographyScatter />
    </SceneCanvas>
  )
}
