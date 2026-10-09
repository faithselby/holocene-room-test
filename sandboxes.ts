import { Daytona } from "@daytonaio/sdk"

const TAG = "holocene-room-test"
const daytona = new Daytona()

async function main() {
  const all: any[] = []
  for await (const s of daytona.list()) all.push(s)
  const [cmd, id] = process.argv.slice(2)

  if (cmd === "delete") {
    const sb = all.find((s) => s.id === id)
    if (!sb) throw new Error(`sandbox ${id} not found`)
    if (sb.labels?.purpose !== TAG) throw new Error(`refusing: ${id} is not a ${TAG} sandbox`)
    await sb.delete()
    return console.log(`deleted ${id}`)
  }
  for (const s of all)
    console.log([s.id, s.state, `cpu=${s.cpu}`, `mem=${s.memory}GB`, `disk=${s.disk}GB`, `labels=${JSON.stringify(s.labels ?? {})}`].join("  "))
  console.log(`${all.length} sandbox(es) visible`)
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })