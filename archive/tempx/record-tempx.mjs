// Films /tempx in headless Chrome and writes MP4s for social posts into exports/.
//   node scripts/record-tempx.mjs [reels|x|linkedin ...]   (default: all three; needs `npm run dev`)
// Frame by frame: the scene's clock is stepped exactly 1/60 s, then that frame is screenshotted,
// so the video is perfectly even however slow the capture is. Raw CDP, no extra dependency.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FORMATS = {
  reels: [1080, 1920], // Instagram Reels, 9:16
  x: [1920, 1080], // X, 16:9
  linkedin: [1080, 1350], // LinkedIn feed, 4:5
}
const URL = process.env.URL ?? 'http://localhost:3000/tempx'
const FPS = 60
const SECONDS = 16 // one loop of the scene (LOOP in scene.ts): the clip repeats seamlessly
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function record(name, [w, h]) {
  const profile = mkdtempSync(join(tmpdir(), 'tempx-chrome-'))
  const frames = mkdtempSync(join(tmpdir(), 'tempx-frames-'))
  const port = 9400 + Math.floor(Math.random() * 400)
  const chrome = spawn('google-chrome-stable', [
    '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--hide-scrollbars',
    '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
    `--user-data-dir=${profile}`, `--window-size=${w},${h}`, 'about:blank',
  ], { stdio: 'ignore' })
  try {
    let target
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200)
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
    }
    if (!target) throw new Error('Chrome did not start')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async (expr) => {
      const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'page error')
      return m.result?.result?.value
    }

    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: URL })
    for (let i = 0; !(await evaluate(`document.documentElement.hasAttribute('data-ready') && !!window.__tempxStep`)); i++) {
      if (i > 600) throw new Error('the scene never got ready; is the dev server running?')
      await sleep(100)
    }
    await sleep(600) // the canvas fades in over 300 ms

    const total = SECONDS * FPS
    // play one loop unfilmed first, so the camera's easing and the theme are already where the
    // loop leaves them: the last frame then flows into the first
    for (let i = 0; i < total; i++) await evaluate(`window.__tempxStep(${1000 / FPS})`)
    for (let i = 0; i < total; i++) {
      // one exact frame, then wait for it to reach the screen before the screenshot
      await evaluate(`window.__tempxStep(${1000 / FPS}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 95 })
      writeFileSync(join(frames, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'))
      if (i % FPS === 0) process.stdout.write(`\r${name}: ${i / FPS}/${SECONDS} s`)
    }
    process.stdout.write('\n')
    ws.close()

    mkdirSync('exports', { recursive: true })
    const out = join('exports', `tempx-${name}-${w}x${h}.mp4`)
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'),
      '-vf', `scale=${w}:${h}:flags=lanczos:in_range=pc:out_range=tv,format=yuv420p`, '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-movflags', '+faststart', '-an', out,
    ])
    console.log(out)
  } finally {
    const exited = new Promise((r) => chrome.once('exit', r))
    chrome.kill()
    await exited // it is still writing its profile until then
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
    rmSync(frames, { recursive: true, force: true })
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FORMATS)
for (const name of names) {
  if (!FORMATS[name]) throw new Error(`unknown format "${name}"; use ${Object.keys(FORMATS).join(', ')}`)
  await record(name, FORMATS[name]) // one at a time: parallel tabs starve the GPU
}
