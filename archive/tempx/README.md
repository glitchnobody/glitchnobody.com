# /tempx — social video recording page (archived)

Made to film the hero for Instagram Reels, X and LinkedIn. Not part of the site build.

- `tempx.tsx` — the route: the scene alone, no UI, a 16 s loop (a virtual cursor ruffles the
  grass and clicks the TV to switch light/dark with the intro's colour wipe).
- `record-tempx.mjs` — headless Chrome over raw CDP; steps the scene one exact 1/60 s frame at a
  time, screenshots each, and encodes 60 fps H.264 with ffmpeg (1080×1920, 1920×1080, 1080×1350).
- `scene.ts`, `intro.ts`, `HeroScene.tsx` — the hero as it was with the `record` option
  (scripted cursor, animated monitor graphics, looping wind, render-texture theme wipe,
  `window.__tempxStep`). The live versions in `src/components/hero/` have that removed.

To bring it back: copy these files over their `src/` counterparts (`tempx.tsx` into
`src/routes/`, `record-tempx.mjs` into `scripts/`), re-add the `.tempx` styles (fixed, full
screen, `.tempx .hero-loader { display: none }`) and hide the TanStack devtools on `/tempx` in
`__root.tsx`, then run `npm run dev` and `node scripts/record-tempx.mjs`.
