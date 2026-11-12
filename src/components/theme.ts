/**
 * Flip between light (the default) and dark, and remember the choice.
 *
 * The switch plays as a View Transition: the old page is cut away from the top down, revealing
 * the new colours underneath.
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
  document.startViewTransition(apply)
}
