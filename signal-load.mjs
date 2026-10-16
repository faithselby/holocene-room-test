// signal-load.mjs — fake PeerJS clients. Signalling load ONLY: no WebRTC, no app, no Supabase, no film.
import fs from "node:fs";
const E = process.env;
const URL0 = `wss://${E.HOST || "peerjs.holocene.club"}/peerjs/peerjs?key=peerjs`;
const STAGES = (E.STAGES || "10,30,60,120").split(",").map(Number);
const SIZE = 9, CANDS = 6;
const STAGE_S = +(E.STAGE_S || 180), BURST_S = +(E.BURST_S || 30);
const PLATEAU_S = +(E.PLATEAU_S || 0), CHURN = +(E.CHURN || 0.1);
const RUN = E.RUN || Date.now().toString(36), T0 = Date.now();
if (Math.max(...STAGES) * SIZE > 1500) { console.error("refusing: over 1500 fake peers (server cap is 2000)"); process.exit(1) }

const evs = fs.createWriteStream("load-events.jsonl");
const log = (o) => evs.write(JSON.stringify({ t: +((Date.now() - T0) / 1000).toFixed(1), ...o }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
let S;
const stage = (name) => (S = { stage: name, open: [], openFail: {}, pair: [], pairTimeout: 0, expire: 0, probe: [], probeTimeout: 0, unplanned: 0, reconnOk: 0, reconnFail: 0 });
const addFail = (why) => (S.openFail[why] = (S.openFail[why] || 0) + 1);
const pending = new Map(); let seq = 0;
const rooms = [];

class Peer {
  constructor(r, i) { this.r = r; this.i = i; this.id = `loadtest-${RUN}-${r}-${i}`; this.ok = false }
  connect() {
    return new Promise((res) => {
      const t0 = now(); let done = false;
      const ws = new WebSocket(`${URL0}&id=${this.id}&token=${Math.random().toString(36).slice(2)}&version=1.5.4`);
      this.ws = ws; this.planned = false;
      const finish = (ok, why) => { if (done) return; done = true; clearTimeout(to); this.ok = ok; res({ ok, why, ms: now() - t0 }) };
      const to = setTimeout(() => { finish(false, "open-timeout"); try { ws.close() } catch {} }, 15000);
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        let m; try { m = JSON.parse(e.data) } catch { return }
        if (m.type === "OPEN") { finish(true); this.hb = setInterval(() => this.send({ type: "HEARTBEAT" }), 5000) }
        else if (["ID-TAKEN", "ERROR", "INVALID-KEY"].includes(m.type)) { log({ ev: m.type, id: this.id, msg: m.payload?.msg }); finish(false, m.type) }
        else relay(this, m);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws !== ws) return;
        clearInterval(this.hb); const was = this.ok; this.ok = false;
        if (!done) return finish(false, "closed-before-open");
        if (was && !this.planned) { S.unplanned++; log({ ev: "unplanned-close", id: this.id }); setTimeout(() => this.reconnect(), 3000) }
      };
    });
  }
  async reconnect() { const x = await this.connect(); x.ok ? S.reconnOk++ : S.reconnFail++; log({ ev: "reconnect", id: this.id, ok: x.ok, why: x.why, ms: Math.round(x.ms) }); if (x.ok) meet(this) }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)) }
  close() { this.planned = true; this.ok = false; clearInterval(this.hb); try { this.ws.close() } catch {} }
}

function relay(p, m) {
  if (m.type === "OFFER") { p.send({ type: "ANSWER", dst: m.src, payload: m.payload }); for (let k = 0; k < CANDS; k++) p.send({ type: "CANDIDATE", dst: m.src, payload: { k } }) }
  else if (m.type === "ANSWER") { const x = pending.get(m.payload?.key); if (x) { pending.delete(m.payload.key); (x.kind === "probe" ? S.probe : S.pair).push(now() - x.t) } }
  else if (m.type === "EXPIRE") S.expire++;
}
function exchange(a, b, kind) {
  const key = `${kind}${++seq}`; pending.set(key, { t: now(), kind });
  a.send({ type: "OFFER", dst: b.id, payload: { key } });
  for (let k = 0; k < CANDS; k++) a.send({ type: "CANDIDATE", dst: b.id, payload: { k } });
  setTimeout(() => { if (pending.delete(key)) kind === "probe" ? S.probeTimeout++ : S.pairTimeout++ }, 15000);
}
const meet = (p) => rooms[p.r].forEach((q) => q !== p && q.ok && exchange(p, q, "pair"));
async function joinRoom(r) {
  await Promise.all(rooms[r].map(async (p) => { await sleep(Math.random() * 5000); const x = await p.connect(); x.ok ? S.open.push(x.ms) : addFail(x.why) }));
  const P = rooms[r].filter((p) => p.ok);
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) exchange(P[a], P[b], "pair");
}
const probeAll = () => rooms.forEach((R) => R && R[0].ok && R[1].ok && exchange(R[0], R[1], "probe"));
const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))]) };
const trio = (a) => [q(a, 0.5), q(a, 0.95), q(a, 1)];
const summary = [];
function report() {
  const line = { stage: S.stage, peersLive: rooms.flat().filter((p) => p.ok).length, opened: S.open.length, openFail: S.openFail,
    openMs_p50_p95_max: trio(S.open), pairs: S.pair.length, pairMs_p50_p95_max: trio(S.pair), pairTimeout: S.pairTimeout, expire: S.expire,
    probeMs_p50_p95_max: trio(S.probe), probeTimeout: S.probeTimeout, unplanned: S.unplanned, reconnOk: S.reconnOk, reconnFail: S.reconnFail };
  console.log(JSON.stringify(line)); summary.push(line);
}

let made = 0;
for (const n of STAGES) {
  stage(`${n} rooms`); const t = Date.now(), joins = [];
  for (; made < n; made++) { const r = made; rooms[r] = Array.from({ length: SIZE }, (_, i) => new Peer(r, i)); joins.push(sleep(Math.random() * BURST_S * 1000).then(() => joinRoom(r))) }
  await Promise.all(joins);
  while (Date.now() - t < STAGE_S * 1000) { probeAll(); await sleep(30000) }
  report();
}
if (PLATEAU_S > 0) {
  stage("peak + churn"); const t = Date.now();
  while (Date.now() - t < PLATEAU_S * 1000) {
    probeAll();
    const live = rooms.flat().filter((p) => p.ok), k = Math.floor(live.length * CHURN);
    for (const p of live.sort(() => Math.random() - 0.5).slice(0, k)) (async () => { p.close(); await sleep(2000); const x = await p.connect(); x.ok ? S.open.push(x.ms) : addFail(x.why); if (x.ok) meet(p) })();
    await sleep(60000);
  }
  report();
}
rooms.flat().forEach((p) => p.close()); await sleep(2000);
fs.writeFileSync("load-summary.json", JSON.stringify({ run: RUN, size: SIZE, stages: STAGES, stageS: STAGE_S, burstS: BURST_S, plateauS: PLATEAU_S, churn: CHURN, summary }, null, 2));
evs.end(); process.exit(0);