// One Holocene participant (one browser) on its own runner. Test-only; no app changes.
import { chromium } from "playwright"
import fs from "node:fs"
import os from "node:os"
import { execSync } from "node:child_process"

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
const PRINT = E.ROOM_TEST_PRINT === "1"
const OUT = `/tmp/run/out/p${G}`
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)])
const raceValue = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), sleep(ms).then(() => fallback)])
const log = (msg) => { if (PRINT) console.log(new Date().toISOString().slice(11, 19), msg) }
const redact = (s) => String(s)
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
  .replace(/\/v\/\d+\/[\w-]+\//g, "/v/<exp>/<sig>/")
  .replace(/([?&][\w-]*(token|signature|key|secret|credential)[\w-]*=)[^&\s"']+/gi, "$1<redacted>")
  .slice(0, 300)
const status = (o) => fs.writeFileSync(`${OUT}/status.json`, JSON.stringify({ g: G, room: ROOM, at: Date.now(), ...o }))
const append = (o) => fs.appendFileSync(`${OUT}/samples.jsonl`, JSON.stringify(o) + "\n")
const read = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } }

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

// Injected before app scripts: enables built-in debug hooks; records PCs and the local camera stream
const INIT = () => {
  try { localStorage.setItem("holocene:debug", "1"); localStorage.removeItem("holocene:relay") } catch {}
  const Orig = window.RTCPeerConnection; let seq = 0
  window.__holoPcs = []
  window.RTCPeerConnection = class extends Orig {
    constructor(...a) { super(...a); this.__holoId = ++seq; window.__holoPcs.push(this);
      const id = this.__holoId
      const kind = () => { try { return this.getTransceivers().length ? "video" : "data" } catch { return "?" } }
      const log = (what) => console.info(`[holo-net] pc${id} ${kind()} ${what}`)
      this.addEventListener("iceconnectionstatechange", () => log("ice=" + this.iceConnectionState))
      this.addEventListener("connectionstatechange", () => log("conn=" + this.connectionState)) }
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
    notes: ps.filter((t) => ["joining", "camera off", "connecting video", "no camera"].includes(t)),
    offline: ps.filter((t) => t === "not here yet").length,
    here: ps.find((t) => / of \d+ here$/.test(t)) ?? null,
    film: film ? { paused: film.paused, t: film.currentTime, rs: film.readyState, ns: film.networkState, seeking: film.seeking, err: film.error?.code ?? null,
      buf: Array.from({ length: film.buffered.length }, (_, i) => `${film.buffered.start(i).toFixed(0)}-${film.buffered.end(i).toFixed(0)}`).join(",") } : null,
    chatTokens: [...new Set(document.body.textContent.match(/room-test-chat-r\d+-\d+/g) ?? [])],
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

const errors = [], failed = [], filmLog = [], timing = { t0: Date.now() }
const machine = { cores: os.availableParallelism?.() ?? os.cpus().length, memMB: Math.round(os.totalmem() / 1048576) }
let seated = false, finished = false
const cap = (arr, s) => { if (arr.length < 200) arr.push(redact(s)) }
const isFilm = (u) => { try { return new URL(u).host === "films.holocene.club" } catch { return false } }
const wire = (p) => {
  p.on("console", (m) => {
    const t = m.text()
    if (m.type() === "error") cap(errors, t)
    if (/^\[holo-net\]|💔|Connection closed with|PeerJS disconnected|Reconnection attempt|Max reconnection|Connection error with/i.test(t))
      fs.appendFileSync(`${OUT}/net.jsonl`, JSON.stringify({ at: new Date().toISOString().slice(11, 23), type: m.type(), text: redact(t) }) + "\n")
  })
  p.on("pageerror", (e) => cap(errors, e.message))
  p.on("requestfailed", (r) => { const u = new URL(r.url()); cap(failed, `${r.failure()?.errorText} ${u.host}${u.pathname}`) })
  p.on("response", (r) => { if (r.status() >= 400) { const u = new URL(r.url()); cap(failed, `${r.status()} ${u.host}${u.pathname}`) } })
  p.on("request", (r) => { if (isFilm(r.url()) && filmLog.length < 600) filmLog.push({ at: Date.now(), req: r.headers()["range"] ?? null }) })
  p.on("response", (r) => { if (isFilm(r.url()) && filmLog.length < 600) filmLog.push({ at: Date.now(), s: r.status(), cr: r.headers()["content-range"] ?? null }) })
}

const LAUNCH = { channel: E.ROOM_TEST_CHANNEL || "chrome", headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-dev-shm-usage"] }
let browser = null, ctx = null, page = null

async function openBrowser() {
  browser = await chromium.launch(LAUNCH)
  ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 900 } })
  await ctx.addInitScript(INIT)
  page = await ctx.newPage(); wire(page)
}
async function login() {
  await page.goto(`${BASE}/auth/signin?returnTo=/rooms/${SCREENING}`, { timeout: 60_000 })
  const pw = page.locator('input[type="password"]').first()
  await page.locator('input[type="email"]').first().fill(EMAIL, { timeout: 30_000 })
  await pw.fill(PASSWORD, { timeout: 30_000 })
  await pw.press("Enter")
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/signin"), { timeout: 30_000 })
}
async function enter() {
  await page.goto(`${BASE}/rooms/${SCREENING}`, { timeout: 60_000 })
  await page.waitForFunction(() => "holoceneRoom" in window, null, { timeout: 45_000 })
  if (E.ROOM_TEST_SEAT !== "0")
    await page.getByRole("button", { name: /take your seat/i }).click({ timeout: 15_000 }).then(() => (seated = true), () => {})
}
async function openChat() {
  await page.getByRole("button", { name: /discussion/i }).click({ timeout: 10_000 }).catch(() => {})
}
function writeFinal(extra = {}) {
  fs.writeFileSync(`${OUT}/final.json`, JSON.stringify({ g: G, room: ROOM, machine, timing, seated, errors, failed, filmLog, ...extra }))
}

// Watchdog: never outlive the scheduled end by more than 2 minutes.
const watchdog = setTimeout(() => {
  if (finished) return
  try { writeFinal({ fatal: "watchdog: participant did not finish in time" }); status({ phase: "error", error: "watchdog" }) } catch {}
  try { execSync('pkill -9 -f "[g]oogle/chrome"') } catch {}
  process.exit(3)
}, Math.max(60_000, END_AT - Date.now() + 120_000))

async function leaveAndRejoin() {
  timing.leftAt = Date.now(); status({ phase: "away", mode: LEAVE_MODE })
  if (LEAVE_MODE === "crash") {
    // Hard crash: kill Chrome at OS level (no goodbye, all connections drop), then a fresh browser signs in again.
    try { execSync('pkill -9 -f "[g]oogle/chrome"') } catch {}
    await withTimeout(browser?.close(), 5_000)
    log(`LEFT (crash: Chrome killed); rejoining in ${REJOIN_MS / 1000}s`)
    await sleep(REJOIN_MS)
    await openBrowser(); await login()
  } else {
    await withTimeout(page.close({ runBeforeUnload: true }), 10_000)
    log(`LEFT (normal close); rejoining in ${REJOIN_MS / 1000}s`)
    await sleep(REJOIN_MS)
    page = await ctx.newPage(); wire(page)
  }
  await enter(); timing.rejoinedAt = Date.now(); await openChat()
  log("REJOINED")
}

status({ phase: "launching" })
const JOIN_DELAY_MS = Number(E.ROOM_TEST_JOIN_DELAY_S ?? 0) * 1000
if (JOIN_DELAY_MS > 0) { log(`joining late on purpose: waiting ${JOIN_DELAY_MS / 1000}s`); await sleep(JOIN_DELAY_MS) }
try {
  if (!PASSWORD) throw new Error("no password provided")
  await openBrowser()
  status({ phase: "login" }); await login(); timing.loggedIn = Date.now()
  status({ phase: "entering" }); await enter(); timing.roomOpen = Date.now(); await openChat()
  let prev = null, prevCpu = cpuSnap(), prevAt = Date.now(), left = false, chatted = false
  while (Date.now() < END_AT) {
    if (LEAVE_AT && !left && Date.now() >= LEAVE_AT) { left = true; await leaveAndRejoin(); prev = null; continue }
    if (CHATTER && CHAT_AT && !chatted && Date.now() >= CHAT_AT) {
      chatted = true; await withTimeout(page.evaluate((t) => window.holoceneRoom?.say(t), CHAT_TOKEN), 5_000)
    }
    const cur = await raceValue(page.evaluate(SAMPLE).catch((e) => ({ error: redact(e.message) })), 15_000, { error: "sample timed out" })
    const now = Date.now(), cpu = cpuSnap(), dt = (now - prevAt) / 1000
    const a = cur.error ? { healthy: false, error: cur.error } : assess(prev, cur, dt)
    if (a.healthy && !timing.firstHealthy) timing.firstHealthy = now
    if (a.healthy && timing.rejoinedAt && !timing.healthyAfterRejoin) timing.healthyAfterRejoin = now
    append({ at: now, a, cpu: cpuUse(prevCpu, cpu, dt), memMB: memMB(), here: cur.here, offline: cur.offline, film: cur.film,
      local: cur.local, rows: cur.rows, video: cur.video })
    status({ phase: "in-room", ...a })
    log(a.error ? `sample error: ${a.error}` : `${a.healthy ? "HEALTHY" : "waiting"} verified=${a.verified} connected=${a.videoConnected} out=${a.outFlowing} in=${a.inFlowing} rendering=${a.rendering} placeholders=${a.placeholders} kbpsOut=${a.kbpsOut} kbpsIn=${a.kbpsIn}`)
    prev = cur.error ? null : cur; prevCpu = cpu; prevAt = now
    await sleep(SAMPLE_MS)
  }
  const eventLog = await raceValue(page.evaluate(() => window.holoceneRoom?.eventLog() ?? []), 10_000, [])
  writeFinal({ eventLog })
  await withTimeout(page.close({ runBeforeUnload: true }), 10_000)
  status({ phase: "done" })
  if (!timing.firstHealthy) process.exitCode = 2
} catch (e) {
  const alerts = page ? await raceValue(page.locator('[role="alert"]').allInnerTexts(), 5_000, []) : []
  writeFinal({ fatal: redact(e.message), url: page ? redact(page.url()) : null, alerts: alerts.map(redact) })
  status({ phase: "error", error: redact(e.message) })
  process.exitCode = 1
} finally {
  finished = true
  clearTimeout(watchdog)
  await withTimeout(browser?.close(), 10_000)
  process.exit(process.exitCode ?? 0)
}