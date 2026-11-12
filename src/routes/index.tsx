import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import HeroScene from '../components/hero/HeroScene'
import type { Stage } from '../components/hero/HeroScene'
import { Icon } from '@iconify/react'
import ThemeToggle from '../components/ThemeToggle'
import { chevronDown, moon, sun } from '../components/icons'
import { toggleTheme } from '../components/theme'

export const Route = createFileRoute('/')({ component: App })

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
// how far the float has got when the card starts to form (keep in step with HEADING_GONE in scene.ts)
const CARD_AT = 0.4

function App() {
  const [stage, setStage] = useState<Stage>('loading')
  const scroller = useRef<HTMLElement>(null)
  const stageEl = useRef<HTMLDivElement>(null)
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
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    // touch screens: the hero is a fixed 600px block that simply scrolls away (no pinning, no card),
    // and the float plays out as it goes
    const touch = !matchMedia('(hover: hover) and (pointer: fine)').matches
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const el = scroller.current
      const st = stageEl.current
      if (!el || !st) return
      const scrolled = stage !== 'done' ? 0 : Math.max(0, -el.getBoundingClientRect().top)
      // Pinned: the first 60% of a screen floats things to 40% and moves the camera, which hides the
      // heading behind the hills. Then the card forms over 100px, and the rest of the float plays
      // out while the card forms and scrolls away.
      const floatPx = innerHeight * 0.6
      const raw = touch
        ? clamp01(scrolled / 320) // done while most of the hero is still on screen
        : scrolled < floatPx
          ? CARD_AT * (scrolled / floatPx)
          : CARD_AT + (1 - CARD_AT) * clamp01((scrolled - floatPx) / (100 + innerHeight * 0.5))
      scroll.smooth += (raw - scroll.smooth) * (1 - Math.exp(-dt * 7))
      if (Math.abs(raw - scroll.smooth) < 0.0004) scroll.smooth = raw
      // the card forms over the 100px after the float; with reduced motion it is simply a card
      const t = touch ? 0 : still ? 1 : clamp01((scrolled - floatPx) / 100)
      st.style.setProperty('--card', String(t * t * (3 - 2 * t)))
      // the header opens out of the notch as the heading reveals, then stays
      if (navEl.current) navEl.current.dataset.open = String(stage === 'reveal' || stage === 'done')
      // the scroll hint shows once the intro is over, until scrolling starts
      if (hintEl.current) hintEl.current.dataset.show = String(stage === 'done' && scrolled < 40)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [stage, scroll])

  return (
    <main>
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
        <div ref={stageEl} className="stage">
          <div className="card-shadow" />
          <div className="card">
            <HeroScene onStage={setStage} scroll={scroll} />
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
      <section id="work" className="relative h-[1200px] px-4 pt-24 text-center sm:px-[60px]">
        <h2 className="text-[clamp(2.5rem,6vw,5rem)] font-semibold leading-none tracking-tight">Featured Work</h2>
      </section>
    </main>
  )
}
