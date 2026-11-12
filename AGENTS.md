# glitchnobody.com

Portfolio site of Siddhant Vij (GlitchNobody). TanStack Start + React 19, Tailwind v4,
three.js for the hero, deployed to Cloudflare Workers.

## Commands

- `npm run dev` — dev server on http://localhost:3000
- `npm run build` — production build (client + Worker)
- `npx tsc --noEmit` — type check (`noUnusedLocals` is on)
- `npm run deploy` — build and `wrangler deploy`

After adding a dependency, restart the dev server (Vite re-optimises deps).

## Layout

- `src/routes/__root.tsx` — document shell: SEO/OG meta, favicons, theme init script
- `src/routes/index.tsx` — the page: notch header, scroll story, card, "Featured Work"
- `src/components/hero/scene.ts` — the three.js scene: terrain, grass, trees, desk and
  monitors, cables, in-scene heading, scroll camera, cat and TV screens
- `src/components/hero/intro.ts` — intro timeline and the depth colour-wipe compositor
  (reused for theme switches)
- `src/components/hero/cables.ts` — wires between floating parts (shaped in the vertex shader)
- `src/components/hero/HeroScene.tsx` — loader count and handoff to the scene
- `src/components/theme.ts` — light/dark toggle (site-wide View Transition sweep)
- `public/hero/scene.glb` — the model, exported from `blender/hero.blend` and compressed with
  `npx @gltf-transform/cli meshopt`

## Rules

- three.js must stay out of the SSR/Worker bundle: it is only reached through the dynamic
  `import('./scene')` in `HeroScene.tsx`. Don't import `scene.ts`, `intro.ts` or `three`
  from route or shared files.
- Light is the default theme; dark is `data-theme="dark"` on `<html>`, stored in
  `localStorage.theme`. There is no system/auto mode.
- Theme colours are CSS variables in `src/styles.css`; scene colours are `tc(day, night)`
  pairs in `scene.ts`.
- Respect `prefers-reduced-motion`: no intro animation, no scroll story, instant theme switch.
- Node names in the GLB are part of the contract (`Float_*` float on scroll, `Ground_*` and
  `Desk` stay, `Cypress1/2` are cloned as trees; `port` extras are cable anchors).
