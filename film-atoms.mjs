const U = process.env.U
if (!U) { console.error("no link given"); process.exit(1) }
let total = null, reqs = 0, handler = ""
async function get(a, n) {
  const b = total ? Math.min(a + n - 1, total - 1) : a + n - 1
  reqs++
  const r = await fetch(U, { headers: { Range: `bytes=${a}-${b}` }, signal: AbortSignal.timeout(30000) })
  if (r.status !== 206) throw new Error(`HTTP ${r.status} (link expired? get a fresh one)`)
  const cr = r.headers.get("content-range"); if (cr && !total) total = Number(cr.split("/")[1])
  return new DataView(await r.arrayBuffer())
}
const cc = (d, o) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3))
const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 3 : 1) + " MB"
const CONT = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"])
async function walk(start, end, depth) {
  let off = start, guard = 0
  while (off + 8 <= end && guard++ < 100) {
    const h = await get(off, 16)
    let size = h.getUint32(0), hdr = 8; const type = cc(h, 4)
    if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16 } else if (size === 0) size = total - off
    if (size < 8) { console.log(" ".repeat(depth * 2) + `bad box at ${off}`); return }
    let x = ""
    if (type === "hdlr") { const d = await get(off + hdr, 12); handler = cc(d, 8); x = "handler=" + handler }
    if (type === "stsd") { const d = await get(off + hdr, Math.min(size - hdr, 512)); x = `codec=${cc(d, 12)}`
      if (handler === "vide" && d.byteLength >= 44) x += ` ${d.getUint16(40)}x${d.getUint16(42)}` }
    if (type === "stsz") { const d = await get(off + hdr, 12); x = `samples=${d.getUint32(8)}` }
    if (type === "stss" || type === "stco" || type === "co64") { const d = await get(off + hdr, 8); x = `entries=${d.getUint32(4)}` }
    console.log(" ".repeat(depth * 2) + `${type} @${off} size ${mb(size)} ${x}`)
    if (CONT.has(type)) await walk(off + hdr, off + size, depth + 1)
    off += size
  }
}
await get(0, 16)
console.log("file size:", total, `(${(total / 1e9).toFixed(1)} GB)`)
await walk(0, total, 0)
console.log("requests:", reqs)
