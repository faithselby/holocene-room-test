import fs from "node:fs"
const dir = process.argv[2]
const count = (a) => Object.entries(a.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 8)
for (const p of fs.readdirSync(dir).filter((d) => /^p\d+$/.test(d))) {
  const s = fs.readFileSync(`${dir}/${p}/samples.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const last = s.at(-1), f = JSON.parse(fs.readFileSync(`${dir}/${p}/final.json`, "utf8"))
  console.log(`\n== ${p} ==`)
  console.log("last check:", JSON.stringify(last.a))
  console.log("header:", last.here, "| local camera:", JSON.stringify(last.local))
  console.log("peers:", JSON.stringify((last.rows ?? []).map((r) => ({ name: r.name, status: r.status, verified: r.verified, video: r.video }))))
  console.log("CPU limiting video?", [...new Set(s.flatMap((x) => (x.video ?? []).map((v) => v.qlr)))].join(","),
    "| out/in:", (last.video ?? []).map((v) => `${v.outFps}fps@${v.outRes} / ${v.inFps}fps@${v.inRes}`).join(" "))
  console.log("top console errors:", count(f.errors.map((e) => e.slice(0, 120))))
  console.log("top failed requests:", count(f.failed.map((e) => e.replace(/\/[\w-]{20,}/g, "/<id>").slice(0, 120))))
}