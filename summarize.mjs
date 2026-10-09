import fs from "node:fs"
const dir = process.argv[2]
if (!dir) { console.error("usage: node summarize.mjs <results-dir>"); process.exit(1) }
const read = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } }
const planText = read(`${dir}/plan/plan.json`)
if (!planText) { console.error(`No plan found in ${dir}. Did you run: gh run download <run-id> -D ${dir}`); process.exit(1) }
const plan = JSON.parse(planText)
const fin = (a) => a.filter((x) => Number.isFinite(x))
const med = (a) => { const s = fin(a).sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null }
const mx = (a) => { const s = fin(a); return s.length ? +Math.max(...s).toFixed(1) : null }
const secs = (a, b) => (a && b ? +((b - a) / 1000).toFixed(1) : null)

const data = plan.seats.map((s) => ({
  s,
  samples: (read(`${dir}/p${s.g}/samples.jsonl`) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  final: JSON.parse(read(`${dir}/p${s.g}/final.json`) ?? "{}"),
}))
const table = [], lines = []
for (let r = 1; r <= plan.R; r++) {
  const room = data.filter((d) => d.s.room === r)
  const firsts = room.map((d) => d.final.timing?.firstHealthy)
  const converged = firsts.every(Boolean) ? Math.max(...firsts) : null
  for (const d of room) {
    const t = d.final.timing ?? {}, sm = d.samples, last = sm.at(-1)
    const after = converged ? sm.filter((x) => x.at >= converged) : []
    const lost = (last?.video ?? []).reduce((a, v) => a + (v.lost ?? 0), 0)
    const recv = (last?.video ?? []).reduce((a, v) => a + (v.recv ?? 0), 0)
    table.push({
      room: r, acct: `roomtest${d.s.g}`,
      cores: d.final.machine?.cores ?? null,
      joinS: secs(t.t0, t.roomOpen), healthyS: secs(t.t0, t.firstHealthy),
      okPct: after.length ? Math.round((100 * after.filter((x) => x.a.healthy).length) / after.length) : null,
      in: last?.a?.inFlowing ?? null, rend: last?.a?.rendering ?? null,
      kbOut: med(sm.map((x) => x.a.kbpsOut)), kbIn: med(sm.map((x) => x.a.kbpsIn)),
      lossPct: recv ? +((100 * lost) / (lost + recv)).toFixed(2) : null,
      jitMs: mx(sm.flatMap((x) => (x.video ?? []).map((v) => (v.jitter ?? NaN) * 1000))),
      rttMs: med(sm.flatMap((x) => (x.video ?? []).map((v) => (v.rtt ?? NaN) * 1000))),
      cpu: mx(sm.map((x) => x.cpu?.cores ?? x.cpu?.hostPct)), memMB: mx(sm.map((x) => x.memMB)),
      restarts: mx(sm.flatMap((x) => (x.rows ?? []).map((w) => w.restarts ?? 0))),
      routes: [...new Set((last?.video ?? []).map((v) => v.route))].join(" "),
      film: last?.film ? (last.film.err ? `ERR${last.film.err}` : last.film.paused ? "paused" : `playing@${Math.round(last.film.t)}s`) : "none",
      chat: last?.a ? (last.a.chatOwn ? "ok" : "MISSING") + (last.a.chatForeign ? ` FOREIGN:${last.a.chatForeign}` : "") : null,
      rejoinS: secs(t.rejoinedAt, t.healthyAfterRejoin),
      errs: d.final.errors?.length ?? 0, failedReq: d.final.failed?.length ?? 0, fatal: d.final.fatal ?? "",
    })
  }
  const seen = new Map(), ok = new Map()
  for (const d of room) for (const x of d.samples) {
    const b = Math.floor((x.at - plan.start) / 10_000)
    if (!seen.has(b)) { seen.set(b, new Set()); ok.set(b, new Set()) }
    seen.get(b).add(d.s.g); if (x.a.healthy) ok.get(b).add(d.s.g)
  }
  let tl = ""; for (let b = 0; b <= Math.max(0, ...seen.keys()); b++) tl += seen.has(b) ? String(Math.min(9, ok.get(b).size)) : " "
  lines.push(`Room ${r}: converged ${converged ? secs(plan.start, converged) + "s after start" : "NEVER"} | healthy people per 10s: ${tl}`)
}
console.table(table)
lines.forEach((l) => console.log(l))
fs.writeFileSync(`${dir}/summary.json`, JSON.stringify({ plan, table, lines }, null, 2))