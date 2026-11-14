import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import HeroScene from '../components/hero/HeroScene'
import type { Stage } from '../components/hero/HeroScene'

// A recording page for social clips: the hero scene alone, looping (see LOOP in scene.ts): a virtual
// cursor ruffles the grass and clicks the TV to switch light/dark with the intro's colour wipe.
// scripts/record-tempx.mjs films it; `data-ready` on <html> is its cue to start.
export const Route = createFileRoute('/tempx')({
  head: () => ({ meta: [{ title: 'tempx' }, { name: 'robots', content: 'noindex' }] }),
  component: TempX,
})

const STILL = { smooth: 0 } // no scroll story here

const setTheme = (dark: boolean) => {
  const root = document.documentElement
  if (dark) root.dataset.theme = 'dark'
  else delete root.dataset.theme
  root.style.colorScheme = dark ? 'dark' : 'light'
}

function TempX() {
  // always starts light; localStorage (the visitor's site choice) is left alone
  useEffect(() => setTheme(false), [])

  const onStage = useCallback((s: Stage) => {
    if (s !== 'done') return
    const root = document.documentElement
    root.dataset.ready = ''
  }, [])

  return (
    <div className="tempx">
      <HeroScene record onStage={onStage} scroll={STILL} />
    </div>
  )
}
