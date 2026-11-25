import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import HeroScene from '../components/hero/HeroScene'
import type { Stage } from '../components/hero/HeroScene'
import { Icon } from '@iconify/react'
import ThemeToggle from '../components/ThemeToggle'
import { chevronDown, moon, sun } from '../components/icons'
import { toggleTheme } from '../components/theme'

export const Route = createFileRoute('/')({
  // the 3D model starts downloading with the page, not once the scene's code has loaded
  head: () => ({ links: [{ rel: 'preload', href: '/hero/scene.glb', as: 'fetch', crossOrigin: 'anonymous' }] }),
  component: App,
})

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

function App() {
  const [stage, setStage] = useState<Stage>('loading')
  const mainEl = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLElement>(null)
  const navEl = useRef<HTMLElement>(null)
  const hintEl = useRef<HTMLDivElement>(null)
  // shared with the 3D scene: how far through the scroll story we are, 0-1, damped
  const scroll = useRef({ smooth: 0 }).current

  // The page does not scroll until the intro has played.
  useEffect(() => {
    history.scrollRestoration = 'manual'
    window.scrollTo(0, 0)
  }, [])
  useEffect(() => {
    const html = document.documentElement
    html.style.overflow = stage === 'done' ? '' : 'hidden'
    return () => {
      html.style.overflow = ''
    }
  }, [stage])

  useEffect(() => {
    // touch screens: the hero is a fixed 800px block that simply scrolls away (no pinning, no card),
    // and the float plays out as it goes
    const touch = !matchMedia('(hover: hover) and (pointer: fine)').matches
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let cardKey = ''
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const el = scroller.current
      const main = mainEl.current
      if (!el || !main) return
      const scrolled = stage !== 'done' ? 0 : Math.max(0, -el.getBoundingClientRect().top)
      // one progress value runs the card shrink and the scene's camera and float: 0 to 1 over one screen
      const raw = clamp01(scrolled / (touch ? 320 : innerHeight))
      scroll.smooth += (raw - scroll.smooth) * (1 - Math.exp(-dt * 7))
      if (Math.abs(raw - scroll.smooth) < 0.0004) scroll.smooth = raw
      if (!touch) {
        // the card's final rect: a centred column (16:11, max 1152px) below the notch. The scene is cropped to
        // it, p of the way there; Featured Work starts at its bottom edge (--card-gap).
        const p = still ? 1 : raw
        const w = document.documentElement.clientWidth
        const cw = Math.min(1152, w - 32)
        const top = 72
        const ch = Math.min((cw * 11) / 16, innerHeight - top - 48)
        const bottom = innerHeight - top - ch
        const key = `${p}|${w}|${innerHeight}`
        if (key !== cardKey) {
          cardKey = key
          const s = main.style
          s.setProperty('--p', String(p))
          s.setProperty('--m', `${((w - cw) / 2) * p}px`)
          s.setProperty('--t', `${top * p}px`)
          s.setProperty('--b', `${bottom * p}px`)
          s.setProperty('--r', `${16 * p}px`)
          s.setProperty('--card-gap', `${bottom}px`)
        }
      }
      // the header opens out of the notch as the heading reveals, then stays
      if (navEl.current) navEl.current.dataset.open = String(stage === 'reveal' || stage === 'done')
      // the scroll hint shows once the intro is over, until scrolling starts
      if (hintEl.current) hintEl.current.dataset.show = String(stage === 'done' && scrolled < 40)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [stage, scroll])

  return (
    <main ref={mainEl}>
      <ThemeToggle />
      {/* Header after getuni.co: a black notch that opens out to full width, then its contents fade in. */}
      <nav ref={navEl} data-open="false" aria-label="Main" className="notch glass">
        <a href="/" className="notch-item notch-logo" aria-label="GlitchNobody, home" />
        <div className="notch-item flex items-center gap-3.5 text-[13px] font-medium min-[420px]:gap-5 sm:gap-7">
          <a href="#work">Work</a>
          <a href="#writings">Writings</a>
          <a href="#about">About</a>
        </div>
        <div className="notch-item flex items-center gap-1.5">
          <button type="button" className="notch-theme" onClick={toggleTheme} aria-label="Switch colour mode">
            {/* the icon shown is picked by the theme in CSS, so it never mismatches after a reload */}
            <Icon icon={sun} className="theme-sun" aria-hidden="true" />
            <Icon icon={moon} className="theme-moon" aria-hidden="true" />
          </button>
          <a href="mailto:hello@glitchnobody.com" className="notch-cta">
            Contact
          </a>
        </div>
      </nav>
      <section ref={scroller} className="scroller">
        <div className="stage">
          <div className="card-shadow" />
          <div className="card">
            <HeroScene onStage={setStage} scroll={scroll} />
            <div className="hero-fade" aria-hidden="true" />
            <div ref={hintEl} data-show="false" className="scroll-hint glass" aria-hidden="true">
              Scroll to view
              <Icon icon={chevronDown} className="scroll-hint-icon" />
            </div>
            <header className="title-text">
              <h1>GlitchNobody</h1>
              <p>aka Siddhant Vij</p>
            </header>
          </div>
        </div>
      </section>
      <section id="work" className="work relative h-[1200px] px-4 pt-24 text-center sm:px-[60px]">
        <h2 className="text-[clamp(2.5rem,6vw,5rem)] font-semibold leading-none tracking-tight">Featured Work</h2>
      </section>
    </main>
  )
}
