import { useEffect, useRef, useState } from 'react'

// three.js is imported inside the effect so it stays out of the SSR bundle and the
// first-paint chunk.
export default function HeroScene() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let dispose: (() => void) | undefined
    let dead = false
    // The SSR branch is constant-folded away, which keeps three.js out of the Worker bundle.
    ;(import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./scene'))
      .then((m) => m.createHero(canvas.current!, () => setState('ready')))
      .then((d) => (dead ? d() : (dispose = d)))
      .catch((err) => {
        console.error('Hero scene failed, showing the poster instead', err)
        setState('failed')
      })
    return () => {
      dead = true
      dispose?.()
    }
  }, [])

  return (
    <div
      className="hero"
      data-state={state}
      role="img"
      aria-label="A retro computer on a wooden table in a flower meadow, under a large pink cloud"
    >
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  )
}
