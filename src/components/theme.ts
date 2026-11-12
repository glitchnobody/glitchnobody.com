/**
 * Flip between light (the default) and dark, and remember the choice.
 *
 * Site-wide, the switch plays as a sweep from the bottom of the screen to the top with a
 * blue/coral/amber band on its edge (a View Transition). The 3D scene is left out of that
 * sweep: it plays its own depth-ordered version of the same wipe.
 */
export function toggleTheme() {
  const root = document.documentElement
  const apply = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    root.style.colorScheme = next
    try {
      localStorage.setItem('theme', next)
    } catch {}
  }
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return apply()
  const band = document.createElement('div')
  band.className = 'theme-band'
  document.body.append(band)
  document.startViewTransition(apply).finished.finally(() => band.remove())
}
