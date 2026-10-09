// Daytona probe v3. Usage: npx tsx probe.ts [sandboxId]
import { Daytona } from "@daytonaio/sdk"

const E = process.env
const PW = E.PW_VERSION ?? "1.49.1"
const TAG = "holocene-room-test"
const daytona = new Daytona()
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
async function sh(sb: any, cmd: string, env?: Record<string, string>, timeout = 900) {
  const r = await sb.process.executeCommand(`bash -c ${q(cmd)}`, undefined, env, timeout)
  return String(r.result ?? "").trim()
}

const APP = (E.ROOM_TEST_BASE_URL ?? "").replace(/\/$/, "")
const APP_HOST = APP.replace(/^https?:\/\//, "").split("/")[0]

const PREP = `set -e; mkdir -p /tmp/run && cd /tmp/run
[ -d node_modules/playwright ] || { npm init -y >/dev/null; npm i playwright@${PW} --no-audit --no-fund >/dev/null; }
command -v google-chrome >/dev/null || npx playwright install --with-deps chrome >/dev/null 2>&1 || sudo -n npx playwright install --with-deps chrome >/dev/null
google-chrome --version`

const NET = `
check() { printf "%-50s " "$1"; curl -sS -o /dev/null -m 15 -w "HTTP %{http_code}  %{time_total}s  ip=%{remote_ip}\\n" "$1" 2>&1 | tail -1; }
for h in ${APP_HOST} peerjs.holocene.club films.holocene.club turn.cloudflare.com stun.cloudflare.com www.google.com; do
  r=$(getent hosts $h | head -1); printf "DNS  %-28s %s\\n" $h "\${r:-FAILED}"; done
check ${APP}/
check https://peerjs.holocene.club/peerjs/peerjs/id
check https://films.holocene.club/
check https://rtc.live.cloudflare.com/
check https://www.google.com/
check https://registry.npmjs.org/
for t in "turn.cloudflare.com 443" "turn.cloudflare.com 3478" "turn.cloudflare.com 80" "peerjs.holocene.club 443"; do
  set -- $t; if timeout 6 bash -c "</dev/tcp/$1/$2" 2>/dev/null; then echo "TCP  $1:$2 open"; else echo "TCP  $1:$2 BLOCKED or timeout"; fi; done
`

const PROBE = `
import http from "node:http"
import { chromium } from "playwright"
const srv = http.createServer((_, s) => { s.setHeader("content-type", "text/html"); s.end("<!doctype html><title>probe</title>") }).listen(8123, "127.0.0.1")
const b = await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-dev-shm-usage"] })
const ctx = await b.newContext({ permissions: ["camera", "microphone"] })
const step = async (name, fn) => { try { console.log(name, JSON.stringify(await fn(), null, 2)) } catch (e) { console.log(name, "FAILED:", String(e.message).split("\\n")[0]) } }
const local = await ctx.newPage()
await local.goto("http://127.0.0.1:8123/")
await step("CAMERA", () => local.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true })
  window.__s = s; const vt = s.getVideoTracks()[0]
  return { label: vt.label, state: vt.readyState, enabled: vt.enabled }
}))
await step("LOOPBACK_WEBRTC", () => local.evaluate(async () => {
  const s = window.__s, vt = s.getVideoTracks()[0], a = new RTCPeerConnection(), z = new RTCPeerConnection()
  a.onicecandidate = (e) => e.candidate && z.addIceCandidate(e.candidate); z.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate)
  a.addTrack(vt, s); await a.setLocalDescription(await a.createOffer()); await z.setRemoteDescription(a.localDescription)
  await z.setLocalDescription(await z.createAnswer()); await a.setRemoteDescription(z.localDescription)
  await new Promise((r) => setTimeout(r, 6000)); const o = {}
  ;(await z.getStats()).forEach((x) => { if (x.type === "inbound-rtp" && x.kind === "video") Object.assign(o, { framesDecoded: x.framesDecoded, size: x.frameWidth + "x" + x.frameHeight }) })
  return o
}))
await step("STUN_UDP", () => local.evaluate(async () => {
  const g = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }), c = new Set()
  g.addTransceiver("video"); g.onicecandidate = (e) => { if (e.candidate) { const p = e.candidate.candidate.split(" "); c.add(p[2] + "/" + p[7]) } }
  await g.setLocalDescription(await g.createOffer()); await new Promise((r) => setTimeout(r, 8000)); return [...c]
}))
await step("CODECS", () => local.evaluate(() => ({ mseH264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"') })))
await step("PEERJS_WS", () => local.evaluate(() => new Promise((res) => {
  const id = "probe" + Math.random().toString(36).slice(2)
  const ws = new WebSocket("wss://peerjs.holocene.club/peerjs/peerjs?key=peerjs&id=" + id + "&token=" + id)
  const t = setTimeout(() => res("timeout"), 10000)
  ws.onmessage = (m) => { clearTimeout(t); ws.close(); res("open: " + String(m.data).slice(0, 40)) }
  ws.onerror = () => { clearTimeout(t); res("error") }
})))
const app = await ctx.newPage()
await step("APP_LOAD", async () => {
  const t0 = Date.now()
  const r = await app.goto(process.env.ROOM_TEST_BASE_URL, { timeout: 60000, waitUntil: "domcontentloaded" })
  return { status: r?.status(), ms: Date.now() - t0, finalUrl: app.url(), title: await app.title() }
})
await b.close(); srv.close()
`

async function findSandbox(id?: string): Promise<any | null> {
  if (id) return daytona.get(id)
  let found: any = null
  for await (const s of daytona.list()) {
    const l = (s as any).labels ?? {}
    if (l.purpose === TAG && l.slot === "1") found = s
  }
  return found
}

async function main() {
  if (!APP) throw new Error("set ROOM_TEST_BASE_URL")
  let sb = await findSandbox(process.argv[2])
  if (!sb) {
    console.log("no slot-1 sandbox found; creating one (4 vCPU / 4 GB / 8 GB disk)…")
    sb = await daytona.create({
      image: `mcr.microsoft.com/playwright:v${PW}-noble`,
      resources: { cpu: 4, memory: 4, disk: 8 },
      labels: { purpose: TAG, slot: "1" },
      autoStopInterval: 30,
    } as any, { timeout: 1200 })
  } else if (sb.state && sb.state !== "started") {
    console.log(`starting sandbox ${sb.id}…`); await sb.start()
  }
  console.log(`using sandbox ${sb.id} (cpu=${sb.cpu}, mem=${sb.memory}GB, disk=${sb.disk}GB)`)

  console.log("preparing (Playwright + Chrome)…")
  console.log(await sh(sb, PREP))

  console.log("\n== Network (DNS, HTTPS, TCP) ==")
  console.log(await sh(sb, NET))

  console.log("\n== Browser ==")
  await sh(sb, `echo ${Buffer.from(PROBE).toString("base64")} | base64 -d > /tmp/run/probe2.mjs`)
  console.log(await sh(sb, "cd /tmp/run && node probe2.mjs 2>&1", { ROOM_TEST_BASE_URL: APP }, 300))
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })