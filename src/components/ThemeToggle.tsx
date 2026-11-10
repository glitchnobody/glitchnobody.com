import { useEffect } from 'react'

// Alt/Option + D flips between light and dark. Until pressed, the theme follows
// the system (the init script in __root.tsx applies the stored choice).
export default function ThemeToggle() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // e.code, because Option+D types "∂" on macOS
      if (!e.altKey || e.code !== 'KeyD') return
      e.preventDefault()
      const root = document.documentElement
      const next = root.classList.contains('dark') ? 'light' : 'dark'
      root.classList.remove('light', 'dark')
      root.classList.add(next)
      root.setAttribute('data-theme', next)
      root.style.colorScheme = next
      try {
        window.localStorage.setItem('theme', next)
      } catch {}
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return null
}
