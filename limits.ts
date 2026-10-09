import { Daytona } from "@daytonaio/sdk"

const daytona = new Daytona()
const IMAGE = `mcr.microsoft.com/playwright:v${process.env.PW_VERSION ?? "1.49.1"}-noble`

async function main() {
  const res: any = await daytona.list()
  console.log("list() returned:", Array.isArray(res) ? `array of ${res.length}` : typeof res,
    res && !Array.isArray(res) ? `keys=${Object.keys(res).join(",")}` : "",
    res?.[Symbol.asyncIterator] ? "(async iterable)" : "")

  const tries: Array<[string, { cpu: number; memory: number; disk: number }]> = [
    ["cpu", { cpu: 64, memory: 1, disk: 3 }],
    ["disk", { cpu: 1, memory: 1, disk: 1000 }],
  ]
  for (const [what, resources] of tries) {
    try {
      const sb: any = await daytona.create({ image: IMAGE, resources, labels: { purpose: "holocene-room-test", slot: "limit-probe" }, autoStopInterval: 5 } as any, { timeout: 300 })
      console.log(`${what}: unexpectedly allowed (${sb.id}), deleting`); await sb.delete()
    } catch (e: any) {
      console.log(`${what} limit: ${String(e?.message ?? e).split("\n")[0]}`)
    }
  }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })