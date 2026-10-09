// One Holocene participant (one browser) inside a Daytona sandbox. Test-only; no app changes.
import { chromium } from "playwright"
import fs from "node:fs"

const E = process.env
const G = Number(E.ROOM_TEST_G), ROOM = Number(E.ROOM_TEST_ROOM ?? 1), EXPECTED = Number(E.ROOM_TEST_EXPECTED)
const BASE = E.ROOM_TEST_BASE_URL, SCREENING = E.ROOM_TEST_SCREENING_ID
const EMAIL = (E.ROOM_TEST_EMAIL_PATTERN ?? "roomtest{n}@holocene.club").replace("{n}", String(G))
const PASSWORD = E[`ROOM_TEST_PASSWORD_${G}`] ?? E.ROOM_TEST_PASSWORD
const END_AT = Number(E.ROOM_TEST_END_AT), SAMPLE_MS = Number(E.ROOM_TEST_SAMPLE_S ?? 10) * 1000
const LEAVE_AT = Number(E.ROOM_TEST_LEAVE_AT ?? 0), LEAVE_MODE = E.ROOM_TEST_LEAVE_MODE ?? "close"
const REJOIN_MS = Number(E.ROOM_TEST_REJOIN_AFTER_S ?? 30) * 1000
const CHATTER = E.ROOM_TEST_CHATTER === "1", CHAT_AT = Number(E.ROOM_TEST_CHAT_AT ?? 0)
const CHAT_TOKEN = E.ROOM_TEST_CHAT_TOKEN ?? ""
const OUT = `/tmp/run/out/p${G}`
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const redact = (s) => String(s)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
  .replace(/\/v\/\d+\/[\w-]+\//g, "/v/<exp>/<sig>/")
  .replace(/([?&][\w-]*(token|signature|key|secret|credential)[\w-]*=)[^&\s"']+/gi, "$1<redacted>")
  .slice(0, 300)
const status = (o) => fs.writeFileSync(`${OUT}/status.json`, JSON.stringify({ g: G, room: ROOM, at: Date.now(), ...o }))
const append = (o) => fs.appendFileSync(`${OUT}/samples.jsonl`, JSON.stringify(o) + "\n")
const read = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } }

// Container-aware CPU and memory (whole sandbox; shared if PER_SANDBOX > 1)
function cpuSnap() {
  const m = read("/sys/fs/cgroup/cpu.stat")?.match(/usage_usec (\d+)/)
  if (m) return { cg: Number(m[1]) }
  const f = read("/proc/stat").split("\n")[0].trim().split(/\s+/).slice(1).map(Number)
  const total = f.reduce((a, b) => a + b, 0)
  return { busy: total - f[3] - (f[4] || 0), total }
}
const cpuUse = (a, b, dt) => a.cg != null
  ? { cores: +((b.cg - a.cg) / 1e6 / dt).toFixed(2) }
  : { hostPct: Math.round((100 * (b.busy - a.busy)) / Math.max(1, b.total - a.total)) }
function memMB() {
  const c = read("/sys/fs/cgroup/memory.current"); if (c) return Math.round(Number(c) / 1048576)
  const mi = read("/proc/meminfo"); const g = (k) => Number(mi.match(new RegExp(k + ":\\s+(\\d+)"))[1])
  return Math.round((g("MemTotal") - g("MemAvailable")) / 1024)
}

// Injected before app scripts: enables built-in debug hooks and records PCs + local camera stream
const INIT = () => {
  try { localStorage.setItem("holocene:debug", "1"); localStorage.removeItem("holocene:relay") } catch {}
  const Orig = window.RTCPeerConnection; let seq = 0
  window.__holoPcs = []
  window.RTCPeerConnection = class extends Orig {
    constructor(...a) { super(...a); this.__holoId = ++seq; window.__holoPcs.push(this) }
  }
  const md = navigator.mediaDevices
  if (md) {
    const gum = md.getUserMedia.bind(md)
    md.getUserMedia = async (c) => { const s = await gum(c); if (s.getVideoTracks().length) window.__holoLocal = s; return s }
  }
}

const SAMPLE = async () => {
  const rows = window.holoceneRoom ? await window.holoceneRoom.dump(true) : null
  const vt = window.__holoLocal?.getVideoTracks()[0]
  const video = []
  for (const pc of window.__holoPcs ?? []) {
    if (pc.connectionState === "closed" || pc.getTransceivers().length === 0) continue // skip PeerJS data PCs
    const st = await pc.getStats(); const o = { id: pc.__holoId, state: pc.connectionState }; let pair
    st.forEach((r) => {
      if (r.type === "outbound-rtp" && r.kind === "video") Object.assign(o, { framesEncoded: r.framesEncoded, bytesSent: r.bytesSent,
        outFps: r.framesPerSecond, outRes: `${r.frameWidth}x${r.frameHeight}`, qlr: r.qualityLimitationReason })
      if (r.type === "inbound-rtp" && r.kind === "video") Object.assign(o, { framesDecoded: r.framesDecoded, bytesRecv: r.bytesReceived,
        inFps: r.framesPerSecond, inRes: `${r.frameWidth}x${r.frameHeight}`, lost: r.packetsLost, recv: r.packetsReceived,
        jitter: r.jitter, freezes: r.freezeCount })
      if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId)
    })
    if (pair) {
      const l = st.get(pair.localCandidateId), rm = st.get(pair.remoteCandidateId)
      o.route = `${l?.candidateType}/${l?.protocol}>${rm?.candidateType}`; o.rtt = pair.currentRoundTripTime
    }
    video.push(o)
  }
  const tiles = [...document.querySelectorAll("video")]
    .filter((v) => !v.hasAttribute("crossorigin") && v.srcObject && !v.style.transform.includes("scaleX(-1)"))
    .map((v) => {
      if (!v.__holoId) {
        v.__holoId = window.__holoVid = (window.__holoVid ?? 0) + 1; v.__f = 0
        const cb = () => { v.__f++; v.requestVideoFrameCallback(cb) }; v.requestVideoFrameCallback(cb)
      }
      return { id: v.__holoId, w: v.videoWidth, paused: v.paused, muted: v.muted, t: v.currentTime, frames: v.__f,
        live: v.srcObject.getVideoTracks().filter((t) => t.readyState === "live").length }
    })
  const ps = [...document.querySelectorAll("p")].map((p) => (p.textContent ?? "").trim())
  const film = document.querySelector("video[crossorigin]")
  return {
    rows, video, tiles,
    local: vt ? { state: vt.readyState, enabled: vt.enabled, label: vt.label } : null,
    notes: ps.filter((t) => ["not here yet", "joining", "camera off", "connecting video", "no camera"].includes(t)),
    here: ps.find((t) => / of \d+ here$/.test(t)) ?? null,
    film: film ? { paused: film.paused, t: film.currentTime, rs: film.readyState, err: film.error?.code ?? null } : null,
    chatTokens: [...new Set(document.body.innerText.match(/room-test-chat-r\d+-\d+/g) ?? [])],
  }
}

function assess(prev, cur, dt) {
  const need = EXPECTED - 1, rows = cur.rows ?? []
  const pv = new Map((prev?.video ?? []).map((v) => [v.id, v]))
  const pt = new Map((prev?.tiles ?? []).map((t) => [t.id, t]))
  let out = 0, inn = 0, kOut = 0, kIn = 0
  for (const v of cur.video) {
    const q = pv.get(v.id); if (!q) continue
    if (v.framesEncoded > q.framesEncoded) out++
    if (v.framesDecoded > q.framesDecoded) inn++
    kOut += (((v.bytesSent ?? 0) - (q.bytesSent ?? 0)) * 8) / 1000 / dt
    kIn += (((v.bytesRecv ?? 0) - (q.bytesRecv ?? 0)) * 8) / 1000 / dt
  }
  const rendering = cur.tiles.filter((t) => {
    const q = pt.get(t.id)
    return q && t.w > 0 && !t.paused && t.live > 0 && (t.frames > q.frames || t.t > q.t)
  }).length
  const a = {
    verified: rows.filter((r) => r.verified).length, videoConnected: rows.filter((r) => r.video === "connected").length,
    rowsCount: rows.length, outFlowing: out, inFlowing: inn, rendering,
    localOk: cur.local?.state === "live" && cur.local?.enabled === true, placeholders: cur.notes.length,
    kbpsOut: Math.round(kOut), kbpsIn: Math.round(kIn),
    chatOwn: cur.chatTokens.includes(CHAT_TOKEN), chatForeign: cur.chatTokens.filter((t) => t !== CHAT_TOKEN).length,
  }
  a.healthy = a.localOk && a.verified >= need && a.videoConnected >= need && out >= need && inn >= need &&
    rendering >= need && a.placeholders === 0
  return a
}

const errors = [], failed = [], timing = { t0: Date.now() }
const cap = (arr, s) => { if (arr.length < 200) arr.push(redact(s)) }
const wire = (p) => {
  p.on("console", (m) => m.type() === "error" && cap(errors, m.text()))
  p.on("pageerror", (e) => cap(errors, e.message))
  p.on("requestfailed", (r) => { const u = new URL(r.url()); cap(failed, `${r.failure()?.errorText} ${u.host}${u.pathname}`) })
  p.on("response", (r) => { if (r.status() >= 400) { const u = new URL(r.url()); cap(failed, `${r.status()} ${u.host}${u.pathname}`) } })
}

async function login(page) {
  await page.goto(`${BASE}/auth/signin?returnTo=/rooms/${SCREENING}`, { timeout: 60_000 })
  const pw = page.locator('input[type="password"]').first()
  await page.locator('input[type="email"]').first().fill(EMAIL)
  await pw.fill(PASSWORD)
  await pw.press("Enter")
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/signin"), { timeout: 30_000 })
}
let seated = false
async function enter(page) {
  await page.goto(`${BASE}/rooms/${SCREENING}`, { timeout: 60_000 })
  await page.waitForFunction(() => "holoceneRoom" in window, null, { timeout: 45_000 })
  if (E.ROOM_TEST_SEAT !== "0")
    await page.getByRole("button", { name: /take your seat/i }).click({ timeout: 15_000 }).then(() => (seated = true), () => {})
}

status({ phase: "launching" })
const browser = await chromium.launch({
  channel: E.ROOM_TEST_CHANNEL || "chrome", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-dev-shm-usage"],
})
const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 900 } })
await ctx.addInitScript(INIT)
let page = await ctx.newPage(); wire(page)
try {
  if (!PASSWORD) throw new Error("no password provided")
  status({ phase: "login" }); await login(page); timing.loggedIn = Date.now()
  status({ phase: "entering" }); await enter(page); timing.roomOpen = Date.now()
  let prev = null, prevCpu = cpuSnap(), prevAt = Date.now(), left = false, chatted = false
  while (Date.now() < END_AT) {
    if (LEAVE_AT && !left && Date.now() >= LEAVE_AT) {
      left = true; timing.leftAt = Date.now(); status({ phase: "away", mode: LEAVE_MODE })
      if (LEAVE_MODE === "crash") await (await ctx.newCDPSession(page)).send("Page.crash").catch(() => {})
      else await page.close({ runBeforeUnload: true }).catch(() => {})
      await page.close().catch(() => {}); await sleep(REJOIN_MS)
      page = await ctx.newPage(); wire(page); await enter(page); timing.rejoinedAt = Date.now(); prev = null
      continue
    }
    if (CHATTER && CHAT_AT && !chatted && Date.now() >= CHAT_AT) {
      chatted = true; await page.evaluate((t) => window.holoceneRoom?.say(t), CHAT_TOKEN).catch(() => {})
    }
    const cur = await page.evaluate(SAMPLE).catch((e) => ({ error: redact(e.message) }))
    const now = Date.now(), cpu = cpuSnap(), dt = (now - prevAt) / 1000
    const a = cur.error ? { healthy: false, error: cur.error } : assess(prev, cur, dt)
    if (a.healthy && !timing.firstHealthy) timing.firstHealthy = now
    if (a.healthy && timing.rejoinedAt && !timing.healthyAfterRejoin) timing.healthyAfterRejoin = now
    append({ at: now, a, cpu: cpuUse(prevCpu, cpu, dt), memMB: memMB(), here: cur.here, film: cur.film,
      local: cur.local, rows: cur.rows, video: cur.video })
    status({ phase: "in-room", ...a })
    if (E.ROOM_TEST_PRINT === "1") console.log(new Date().toISOString().slice(11, 19),
      `${a.healthy ? "HEALTHY" : "waiting"} verified=${a.verified} connected=${a.videoConnected} out=${a.outFlowing} in=${a.inFlowing} rendering=${a.rendering} placeholders=${a.placeholders} kbpsOut=${a.kbpsOut} kbpsIn=${a.kbpsIn}`)
    prev = cur.error ? null : cur; prevCpu = cpu; prevAt = now
    await sleep(SAMPLE_MS)
  }
  const eventLog = await page.evaluate(() => window.holoceneRoom?.eventLog() ?? []).catch(() => [])
  fs.writeFileSync(`${OUT}/final.json`, JSON.stringify({ g: G, room: ROOM, timing, seated, errors, failed, eventLog }))
  await page.close({ runBeforeUnload: true }).catch(() => {})
  status({ phase: "done" })
} catch (e) {
  const alerts = await page.locator('[role="alert"]').allInnerTexts().catch(() => [])
  fs.writeFileSync(`${OUT}/final.json`, JSON.stringify({ g: G, room: ROOM, timing, seated, errors, failed,
    fatal: redact(e.message), url: redact(page.url()), alerts: alerts.map(redact) }))
  status({ phase: "error", error: redact(e.message) })
} finally {
  await browser.close().catch(() => {})
}