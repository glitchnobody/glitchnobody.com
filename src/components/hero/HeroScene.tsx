import { useEffect, useRef, useState } from 'react'

export type Stage = 'loading' | 'wire' | 'reveal' | 'done'

// three.js is imported inside the effect so it stays out of the SSR bundle and the
// first-paint chunk.
//
// Sequence: the count runs 0-75% while the scene loads. At 75% the wireframe fades in under the
// count (stage 'wire'); the count then follows the intro clock to 100% and disappears just
// before the colour wipe starts. The heading sweeps in as the wipe reaches the sky.
export default function HeroScene({ onStage, scroll }: { onStage: (stage: Stage) => void; scroll: { smooth: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const counter = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState<'loading' | 'wire' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let dead = false
    let handle: { start: () => void; count: () => number; dispose: () => void } | null = null
    let target = 0 // real loading progress, mapped onto 0-75
    let shown = 0 // what the counter shows: it trails the real progress
    let started = false
    let done = false
    let last = performance.now()

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!started) {
        // at most 60% a second, so the count can be read even when everything is cached
        shown = Math.min(target, shown + 60 * dt)
        if (shown >= 75 && handle) {
          started = true
          setState('wire')
          handle.start()
        }
      } else {
        shown = handle!.count()
        if (shown >= 100 && !done) {
          done = true
          setState('ready')
        }
      }
      if (counter.current) counter.current.textContent = `${Math.floor(shown)}%`
    }
    let raf = requestAnimationFrame(tick)

    // The SSR branch is constant-folded away, which keeps three.js out of the Worker bundle.
    ;(import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./scene'))
      .then((m) => {
        target = 7.5
        return m.createHero(canvas.current!, {
          onProgress: (p) => (target = Math.max(target, 75 * (0.1 + 0.9 * p))),
          onStage: (s) => onStage(s),
          scroll,
        })
      })
      .then((h) => (dead ? h.dispose() : (handle = h)))
      .catch((err) => {
        console.error('Hero scene failed, showing the poster instead', err)
        setState('failed')
        onStage('done')
      })
    return () => {
      dead = true
      cancelAnimationFrame(raf)
      handle?.dispose()
    }
  }, [onStage, scroll])

  return (
    <div
      className="hero"
      data-state={state}
      role="img"
      aria-label="A stack of old computer monitors on a black desk in a grassy valley. The screens read: make products feel amazing."
    >
      <canvas ref={canvas} aria-hidden="true" />
      {/* Server-rendered, so it paints before any script loads. */}
      <div className="hero-loader" role="status">
        <span className="hero-loader-count" ref={counter} aria-hidden="true">
          0%
        </span>
        <span className="sr-only">Loading</span>
      </div>
    </div>
  )
}
