// Local orchestrator. Never prints secrets; passwords travel only via the API's env parameter.
import { Daytona } from "@daytonaio/sdk"
import fs from "node:fs"
import { execSync } from "node:child_process"

const E = process.env
const PW = E.PW_VERSION ?? "1.49.1"
const IMAGE = `mcr.microsoft.com/playwright:v${PW}-noble`
const RES = { cpu: +(E.SANDBOX_CPU ?? 4), memory: +(E.SANDBOX_MEM_GB ?? 8), disk: +(E.SANDBOX_DISK_GB ?? 10) }
const PER = +(E.PER_SANDBOX ?? 1)
const CONVERGE_S = +(E.ROOM_TEST_CONVERGE_S ?? 120)
const TAG = "holocene-room-test"
const daytona = new Daytona() // reads DAYTONA_API_KEY
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const slotOf = (s: any) => Number(s.labels?.slot)
const read = (p: string) => { try { return fs.readFileSync(p, "utf8") } catch { return null } }

async function sh(sb: any, cmd: string, env?: Record<string, string>, timeout = 900) {
  const r = await sb.process.executeCommand(`bash -c ${q(cmd)}`, undefined, env, timeout)
  return { code: r.exitCode as number, out: String(r.result ?? "") }
}
const put = (sb: any, path: string, content: string) =>
  sh(sb, `mkdir -p $(dirname ${path}) && echo ${Buffer.from(content).toString("base64")} | base64 -d > ${path}`)

async function mine(): Promise<any[]> {
  const out: any[] = []
  for await (const s of daytona.list({ labels: { purpose: TAG } }))
    if ((s as any).labels?.purpose === TAG) out.push(s) // safety: never touch anything else
  return out.sort((a, b) => slotOf(a) - slotOf(b))
}

const PREP = `set -e; mkdir -p /tmp/run && cd /tmp/run
[ -d node_modules/playwright ] || { npm init -y >/dev/null; npm i playwright@${PW} --no-audit --no-fund >/dev/null; }
command -v google-chrome >/dev/null || npx playwright install --with-deps chrome >/dev/null 2>&1 || sudo -n npx playwright install --with-deps chrome >/dev/null
google-chrome --version`

const create = (i: number) => daytona.create(
  { image: IMAGE, resources: RES, labels: { purpose: TAG, slot: String(i) }, autoStopInterval: 30 } as any, { timeout: 1200 })

async function up(n: number) {
  let have = await mine()
  const missing = Array.from({ length: n }, (_, k) => k + 1).filter((i) => !have.some((s) => slotOf(s) === i))
  if (missing.length) {
    console.log(`creating sandboxes ${missing.join(",")} (${RES.cpu} vCPU / ${RES.memory} GB each)`)
    await create(missing[0]) // first build caches the image
    await Promise.all(missing.slice(1).map(create))
    have = await mine()
  }
  const sbs = have.filter((s) => slotOf(s) <= n)
  const participant = fs.readFileSync("participant.mjs", "utf8")
  await Promise.all(sbs.map(async (sb) => {
    if (sb.state && sb.state !== "started") await sb.start()
    const r = await sh(sb, PREP)
    if (r.code !== 0) throw new Error(`prep failed on sandbox ${slotOf(sb)}: ${r.out.slice(-500)}`)
    await put(sb, "/tmp/run/participant.mjs", participant)
  }))
  console.log(`${sbs.length} sandboxes ready`)
  return sbs
}

const PROBE = `
import { chromium } from "playwright"
const b = await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"] })
const page = await (await b.newContext({ permissions: ["camera","microphone"] })).newPage()
const r = await page.goto(process.env.ROOM_TEST_BASE_URL, { timeout: 30000 }).catch(() => null)
console.log("APP_HTTP", r ? r.status() : "unreachable")
console.log("PROBE", JSON.stringify(await page.evaluate(async () => {
  const o = {}, wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true })
  const vt = s.getVideoTracks()[0]; o.camera = { label: vt.label, state: vt.readyState, enabled: vt.enabled }
  const g = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }), c = new Set()
  g.addTransceiver("video"); g.onicecandidate = (e) => { if (e.candidate) { const p = e.candidate.candidate.split(" "); c.add(p[2] + "/" + p[7]) } }
  await g.setLocalDescription(await g.createOffer()); await wait(8000); o.stun = [...c]
  const a = new RTCPeerConnection(), z = new RTCPeerConnection()
  a.onicecandidate = (e) => e.candidate && z.addIceCandidate(e.candidate); z.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate)
  a.addTrack(vt, s); await a.setLocalDescription(await a.createOffer()); await z.setRemoteDescription(a.localDescription)
  await z.setLocalDescription(await z.createAnswer()); await a.setRemoteDescription(z.localDescription); await wait(6000)
  ;(await z.getStats()).forEach((x) => { if (x.type === "inbound-rtp" && x.kind === "video") o.loopbackFramesDecoded = x.framesDecoded })
  o.mseH264 = MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"')
  const reach = (u) => fetch(u, { mode: "no-cors" }).then(() => "reachable", (e) => String(e))
  o.peerjsHttp = await reach("https://peerjs.holocene.club/peerjs/peerjs/id"); o.filmsHost = await reach("https://films.holocene.club/")
  const id = "probe" + Math.random().toString(36).slice(2)
  o.peerjsWs = await new Promise((res) => {
    const ws = new WebSocket("wss://peerjs.holocene.club/peerjs/peerjs?key=peerjs&id=" + id + "&token=" + id)
    const t = setTimeout(() => res("timeout"), 10000)
    ws.onmessage = (m) => { clearTimeout(t); ws.close(); res("open: " + String(m.data).slice(0, 40)) }
    ws.onerror = () => { clearTimeout(t); res("error") }
  })
  return o
}), null, 2)); await b.close()`

async function probe() {
  const [sb] = await up(1)
  for (const c of ["nproc", "free -m", "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max 2>/dev/null"])
    console.log(`$ ${c}\n${(await sh(sb, c)).out}`)
  await put(sb, "/tmp/run/probe.mjs", PROBE)
  console.log((await sh(sb, "cd /tmp/run && node probe.mjs", { ROOM_TEST_BASE_URL: E.ROOM_TEST_BASE_URL ?? "" }, 300)).out)
}

type Seat = { g: number; room: number; member: number; slot: number }
function plan(rooms: number, size: number) {
  const total = rooms * size, nsb = Math.ceil(total / PER)
  // Round-robin: each room spans as many sandboxes as possible
  const seats: Seat[] = Array.from({ length: total }, (_, k) =>
    ({ g: k + 1, room: Math.floor(k / size) + 1, member: (k % size) + 1, slot: (k % nsb) + 1 }))
  return { nsb, seats }
}
const pwKey = (g: number) => (E[`ROOM_TEST_PASSWORD_${g}`] ? `ROOM_TEST_PASSWORD_${g}` : "ROOM_TEST_PASSWORD")

type Extra = (s: Seat, start: number) => Record<string, string | number>
async function run(o: { rooms: number; size: number; holdS: number; label: string; extra?: Extra }) {
  for (const k of ["ROOM_TEST_BASE_URL", "ROOM_TEST_SCREENING_ID"]) if (!E[k]) throw new Error(`set ${k}`)
  const { nsb, seats } = plan(o.rooms, o.size)
  for (const s of seats) if (!E[pwKey(s.g)]) throw new Error(`no password for roomtest${s.g} (set ROOM_TEST_PASSWORD)`)
  const sbs = await up(nsb)
  const start = Date.now(), endAt = start + (CONVERGE_S + o.holdS) * 1000
  const common = { ROOM_TEST_BASE_URL: E.ROOM_TEST_BASE_URL!, ROOM_TEST_SCREENING_ID: E.ROOM_TEST_SCREENING_ID!,
    ROOM_TEST_END_AT: String(endAt), ROOM_TEST_CHAT_AT: String(start + CONVERGE_S * 1000),
    ...(E.ROOM_TEST_EMAIL_PATTERN ? { ROOM_TEST_EMAIL_PATTERN: E.ROOM_TEST_EMAIL_PATTERN } : {}) }

  await Promise.all(sbs.map((sb) => {
    const here = seats.filter((s) => s.slot === slotOf(sb))
    const secrets = Object.fromEntries(here.map((s) => [pwKey(s.g), E[pwKey(s.g)]!]))
    const launches = here.map((s) => {
      const v = { ROOM_TEST_G: s.g, ROOM_TEST_ROOM: s.room, ROOM_TEST_EXPECTED: o.size, ROOM_TEST_CHATTER: s.member === 1 ? 1 : 0,
        ROOM_TEST_CHAT_TOKEN: `room-test-chat-r${s.room}-${start}`, ...(o.extra?.(s, start) ?? {}) }
      const vars = Object.entries(v).map(([k, x]) => `${k}=${q(String(x))}`).join(" ")
      return `${vars} setsid nohup node participant.mjs > /tmp/run/p${s.g}.log 2>&1 &`
    }).join("\n")
    return sh(sb, `pkill -f participant.mjs || true; rm -rf /tmp/run/out /tmp/run/p*.log; cd /tmp/run\n${launches}`, { ...common, ...secrets })
  }))
  console.log(`${o.label}: ${seats.length} participants in ${o.rooms} room(s) on ${nsb} sandbox(es); converge ${CONVERGE_S}s + hold ${o.holdS}s`)
  console.log(`legend per seat: # healthy  . in room, not yet healthy  l login  e entering  a away  E error  D done  ? no status`)

  let stop = false
  const onInt = () => { stop = true; console.log("stopping…") }
  process.once("SIGINT", onInt)
  const code: Record<string, string> = { login: "l", entering: "e", away: "a", error: "E", done: "D", launching: "l" }
  while (!stop && Date.now() < endAt + 90_000) {
    const st = new Map<number, any>()
    await Promise.all(sbs.map(async (sb) => {
      const r = await sh(sb, "for f in /tmp/run/out/*/status.json; do cat $f 2>/dev/null; echo; done", undefined, 60).catch(() => ({ out: "" }))
      for (const l of r.out.split("\n")) { try { const j = JSON.parse(l); st.set(j.g, j) } catch {} }
    }))
    const line = Array.from({ length: o.rooms }, (_, r) => `R${r + 1} ` + seats.filter((s) => s.room === r + 1).map((s) => {
      const j = st.get(s.g); if (!j) return "?"
      return j.phase === "in-room" ? (j.healthy ? "#" : ".") : code[j.phase] ?? "?"
    }).join("")).join("  ")
    console.log(new Date().toISOString().slice(11, 19), line)
    if (seats.every((s) => ["done", "error"].includes(st.get(s.g)?.phase))) break
    await sleep(15_000)
  }
  process.off("SIGINT", onInt)
  if (stop) await Promise.all(sbs.map((sb) => sh(sb, "pkill -f participant.mjs || true")))

  const dir = `results/${o.label}-${new Date(start).toISOString().replace(/[:.]/g, "-")}`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/plan.json`, JSON.stringify({ ...o, extra: undefined, start, endAt, PER, RES, seats }, null, 2))
  await Promise.all(sbs.map(async (sb) => {
    const s = slotOf(sb)
    const b64 = (await sh(sb, "cd /tmp/run && tar czf - out p*.log 2>/dev/null | base64 -w0", undefined, 300)).out.trim()
    if (!b64) return
    fs.writeFileSync(`${dir}/s${s}.tgz`, Buffer.from(b64, "base64"))
    fs.mkdirSync(`${dir}/s${s}`, { recursive: true })
    try { execSync(`tar xzf s${s}.tgz -C s${s}`, { cwd: dir }) } catch { console.log(`could not extract results from sandbox ${s}`) }
  }))
  summarize(dir, seats, o.rooms, start)
}

function summarize(dir: string, seats: Seat[], rooms: number, start: number) {
  const fin = (a: number[]) => a.filter((x) => Number.isFinite(x))
  const med = (a: number[]) => { const s = fin(a).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null }
  const mx = (a: number[]) => { const s = fin(a); return s.length ? +Math.max(...s).toFixed(1) : null }
  const secs = (a?: number, b?: number) => (a && b ? +((b - a) / 1000).toFixed(1) : null)
  const data = seats.map((s) => {
    const base = `${dir}/s${s.slot}/out/p${s.g}`
    const samples = (read(`${base}/samples.jsonl`) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    return { s, samples, final: JSON.parse(read(`${base}/final.json`) ?? "{}") }
  })
  const table: any[] = [], roomLines: string[] = []
  for (let r = 1; r <= rooms; r++) {
    const room = data.filter((d) => d.s.room === r)
    const firsts = room.map((d) => d.final.timing?.firstHealthy)
    const converged = firsts.every(Boolean) ? Math.max(...firsts) : null
    for (const d of room) {
      const t = d.final.timing ?? {}, sm = d.samples, last = sm.at(-1)
      const after = converged ? sm.filter((x: any) => x.at >= converged) : []
      const lost = (last?.video ?? []).reduce((a: number, v: any) => a + (v.lost ?? 0), 0)
      const recv = (last?.video ?? []).reduce((a: number, v: any) => a + (v.recv ?? 0), 0)
      table.push({
        room: r, acct: `roomtest${d.s.g}`, sbx: d.s.slot,
        joinS: secs(t.t0, t.roomOpen), healthyS: secs(t.t0, t.firstHealthy),
        okPct: after.length ? Math.round((100 * after.filter((x: any) => x.a.healthy).length) / after.length) : null,
        in: last?.a?.inFlowing ?? null, rend: last?.a?.rendering ?? null,
        kbOut: med(sm.map((x: any) => x.a.kbpsOut)), kbIn: med(sm.map((x: any) => x.a.kbpsIn)),
        lossPct: recv ? +((100 * lost) / (lost + recv)).toFixed(2) : null,
        jitMs: mx(sm.flatMap((x: any) => (x.video ?? []).map((v: any) => (v.jitter ?? NaN) * 1000))),
        rttMs: med(sm.flatMap((x: any) => (x.video ?? []).map((v: any) => (v.rtt ?? NaN) * 1000))),
        cpu: mx(sm.map((x: any) => x.cpu?.cores ?? x.cpu?.hostPct)), memMB: mx(sm.map((x: any) => x.memMB)),
        restarts: mx(sm.flatMap((x: any) => (x.rows ?? []).map((w: any) => w.restarts ?? 0))),
        routes: [...new Set((last?.video ?? []).map((v: any) => v.route))].join(" "),
        chat: last?.a ? (last.a.chatOwn ? "ok" : "MISSING") + (last.a.chatForeign ? ` FOREIGN:${last.a.chatForeign}` : "") : null,
        rejected: (d.final.eventLog ?? []).filter((e: any) => /rejected/.test(e.event)).length,
        rejoinS: secs(t.rejoinedAt, t.healthyAfterRejoin),
        errs: d.final.errors?.length ?? 0, failedReq: d.final.failed?.length ?? 0, fatal: d.final.fatal ?? "",
      })
    }
    const seen = new Map<number, Set<number>>(), ok = new Map<number, Set<number>>()
    for (const d of room) for (const x of d.samples) {
      const b = Math.floor((x.at - start) / 10_000)
      if (!seen.has(b)) { seen.set(b, new Set()); ok.set(b, new Set()) }
      seen.get(b)!.add(d.s.g); if (x.a.healthy) ok.get(b)!.add(d.s.g)
    }
    const maxB = Math.max(0, ...seen.keys())
    let tl = ""; for (let b = 0; b <= maxB; b++) tl += seen.has(b) ? String(Math.min(9, ok.get(b)!.size)) : " "
    roomLines.push(`R${r} converged: ${converged ? secs(start, converged) + "s" : "NEVER"}  timeline (healthy seats per 10s): ${tl}`)
  }
  console.table(table)
  roomLines.forEach((l) => console.log(l))
  fs.writeFileSync(`${dir}/summary.json`, JSON.stringify({ table, roomLines }, null, 2))
  console.log(`results: ${dir}`)
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2)
  switch (cmd) {
    case "probe": return probe()
    case "up": return void (await up(+(a ?? 1)))
    case "ls": {
      const all = await mine()
      console.log(all.length ? all.map((s) => `slot ${slotOf(s)}  ${s.id}  ${s.state ?? ""}`).join("\n") : "no holocene-room-test sandboxes")
      return
    }
    case "stage": return run({ rooms: 1, size: +a, holdS: +(b ?? 120), label: `stage-${a}` })
    case "soak": {
      const min = +(a ?? 15), hold = min * 60
      const extra: Extra = (s, start) => {
        const out: Record<string, string | number> = {}
        if (s.member === 9) {
          out.ROOM_TEST_LEAVE_AT = start + (CONVERGE_S + hold * 0.5) * 1000
          out.ROOM_TEST_LEAVE_MODE = "close"
        } else if (s.member === 5) {
          out.ROOM_TEST_LEAVE_AT = start + (CONVERGE_S + hold * 0.75) * 1000
          out.ROOM_TEST_LEAVE_MODE = "crash"
        }
        return out
      }
      return run({ rooms: 1, size: 9, holdS: hold, label: `soak-9-${min}m`, extra })
    }
    case "rooms": return run({ rooms: +a, size: +(c ?? 9), holdS: +(b ?? 600), label: `rooms-${a}x${c ?? 9}` })
    case "stop": return void (await Promise.all((await mine()).map((sb) => sh(sb, "pkill -f participant.mjs || true"))))
    case "down": {
      const all = await mine()
      await Promise.all(all.map((sb) => (sb.delete ? sb.delete() : (daytona as any).delete(sb))))
      return console.log(`deleted ${all.length} sandboxes`)
    }
    default:
      console.log("usage: probe | up N | stage N [holdS] | soak [minutes] | rooms R [holdS] [size] | stop | down")
  }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })