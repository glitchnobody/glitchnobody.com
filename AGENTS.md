# glitchnobody.com

Portfolio site of Siddhant Vij (GlitchNobody). TanStack Start + React 19, Tailwind v4,
PixiJS 3D (`@pixi/3d` on `pixi.js` v8, WebGL) for the hero, deployed to Cloudflare Workers.

## Commands

- `npm run dev` — dev server on http://localhost:3000
- `npm run build` — production build (client + Worker)
- `npx tsc --noEmit` — type check (`noUnusedLocals` is on)
- `npm run deploy` — build and `wrangler deploy`

After adding a dependency, restart the dev server (Vite re-optimises deps).

## Layout

- `src/routes/__root.tsx` — document shell: SEO/OG meta, favicons, theme init script, 404 page
- `src/routes/index.tsx` — the page: notch header, scroll story, card, "Featured Work"
- `src/components/hero/scene.ts` — the PixiJS 3D scene: terrain, grass, trees, desk and
  monitors, cables, in-scene heading, scroll camera, cat and TV screens. Custom looks are
  GLSL shader bits on `FlatMaterial` (no WGSL halves, so the app is pinned to WebGL)
- `src/components/hero/intro.ts` — intro timeline, the shared GLSL helpers, the colour-wipe
  bit every material carries, and the wireframe material
- `src/components/hero/cables.ts` — wires between floating parts (shaped in the vertex shader)
- `src/components/hero/HeroScene.tsx` — loader count and handoff to the scene
- `src/components/theme.ts` — light/dark toggle (site-wide View Transition sweep)
- `public/robots.txt`, `public/sitemap.xml`, `public/og.png` — SEO; the sitemap lists `/` only
- `public/hero/scene.glb` — the model, exported from `blender/hero.blend` and compressed with
  `npx @gltf-transform/cli meshopt`
- `archive/` — retired code, not built or type-checked (excluded in `tsconfig.json`).
  `archive/tempx/` is the social-video recording page and its recorder; see its README

## Rules

- pixi.js must stay out of the SSR/Worker bundle: it is only reached through the dynamic
  `import('./scene')` in `HeroScene.tsx`. Don't import `scene.ts`, `intro.ts`, `cables.ts`,
  `pixi.js` or `@pixi/3d` from route or shared files.
- Light is the default theme; dark is `data-theme="dark"` on `<html>`, stored in
  `localStorage.theme`. There is no system/auto mode.
- Theme colours are CSS variables in `src/styles.css`; scene colours are `tc(day, night)`
  pairs in `scene.ts`, written to `material.data` by `bind()`.
- Respect `prefers-reduced-motion`: no intro animation, no scroll story, instant theme switch.
- Outlines are inverted hulls (a child mesh per outlined part); in dev, StrictMode mounts the
  hero twice, so each scene draws on its own canvas (two pixi apps can't share a context).
- Node names in the GLB are part of the contract (`Float_*` float on scroll, `Ground_*` and
  `Desk` stay, `Cypress1/2` are cloned as trees; `port` extras are cable anchors, read from
  the GLB's JSON by `scene.ts` because the loader drops node extras).
