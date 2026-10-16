#!/usr/bin/env bash
set -u
R=faithselby/holocene-room-test
ID=${1:?usage: ./film-probe.sh <screening id> [size] [hold_s]}
SIZE=${2:-2}; HOLD=${3:-300}
if [ "$ID" = "21f2975d-c598-42bc-aaa2-a68b4ab3de66" ]; then echo "That is the old soak screening. Use the new Providence ID."; exit 1; fi

gh workflow run room-test.yml -R $R -f screening_id=$ID -f size=$SIZE -f hold_s=$HOLD || exit 1
sleep 15
RUN=$(gh run list -R $R --workflow=room-test.yml -L 1 --json databaseId -q '.[0].databaseId'); echo "run id: $RUN"
until [ "$(gh run view $RUN -R $R --json status -q .status 2>/dev/null)" = "completed" ]; do sleep 30; done
gh run download $RUN -R $R -D results/run-$RUN || { echo "download failed, rerun: gh run download $RUN -R $R -D results/run-$RUN"; exit 1; }

node summarize.mjs results/run-$RUN
gh run view $RUN -R $R --json jobs -q '.jobs[] | "\(.name) \(.conclusion)"' | sort
for d in results/run-$RUN/p*/; do
  p=$(basename $d)
  echo "== $p film per sample (position s / readyState, P=paused, E=error)"
  node -e 'const L=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);console.log(L.map(x=>x.film?`${Math.round(x.film.t)}/${x.film.rs}${x.film.paused?"P":""}${x.film.err?"E"+x.film.err:""}`:"-").join(" "))' $d/samples.jsonl
  node -e '
const L=JSON.parse(require("fs").readFileSync(process.argv[1])).filmLog??[];
if(!L.length){console.log("   no filmLog");process.exit(0)}
const total=(L.find(x=>x.cr)?.cr??"").split("/")[1];
const got=L.filter(x=>x.cr).map(x=>{const[a,b]=x.cr.split(" ")[1].split("/")[0].split("-").map(Number);return b-a+1});
const bytes=got.reduce((a,b)=>a+b,0),secs=(L.at(-1).at-L[0].at)/1000;
console.log("   file bytes:",total,"| requests:",L.filter(x=>x.req).length,"| non-206:",L.filter(x=>x.s&&x.s!==206).length,
"| MB fetched:",(bytes/1e6).toFixed(0),"| avg Mbps:",(bytes*8/1e6/secs).toFixed(1))' $d/final.json
done
