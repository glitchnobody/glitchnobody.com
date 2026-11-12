import { useEffect } from 'react'
import { toggleTheme } from './theme'

// Alt/Option + D flips between light (the default) and dark; so does clicking the TV in the
// scene. The init script in __root.tsx applies the stored choice before the page paints.
export default function ThemeToggle() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // e.code, because Option+D types "∂" on macOS
      if (!e.altKey || e.code !== 'KeyD') return
      e.preventDefault()
      toggleTheme()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return null
}
