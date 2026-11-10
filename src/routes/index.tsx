import { createFileRoute } from '@tanstack/react-router'
import ThemeToggle from '../components/ThemeToggle'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <main className="grid min-h-screen place-items-center">
      <ThemeToggle />
      <p className="text-[28px] font-medium tracking-tight">Coming soon</p>
    </main>
  )
}
