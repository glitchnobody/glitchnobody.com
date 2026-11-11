import { createFileRoute } from '@tanstack/react-router'
import HeroScene from '../components/hero/HeroScene'
import ThemeToggle from '../components/ThemeToggle'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <main className="relative h-dvh overflow-hidden">
      <ThemeToggle />
      <HeroScene />
      <p className="absolute inset-x-0 top-[10vh] text-center text-[28px] font-medium tracking-tight">
        Coming soon
      </p>
    </main>
  )
}
