#!/usr/bin/env bash
# Usage: ./run-test.sh <screening_id> [size=9] [hold_s=180] [scenario=none] [stagger_s=0]
set -u
R=faithselby/holocene-room-test
ID=${1:?usage: ./run-test.sh <screening_id> [size] [hold_s] [scenario] [stagger_s]}
SIZE=${2:-9}; HOLD=${3:-180}; SCEN=${4:-none}; STAG=${5:-0}

gh workflow run room-test.yml -R $R -f screening_id=$ID -f size=$SIZE -f hold_s=$HOLD -f scenario=$SCEN  || exit 1
sleep 15
RUN=$(gh run list -R $R --workflow=room-test.yml -L 1 --json databaseId -q '.[0].databaseId')
D=results/run-$RUN
echo "run $RUN started; results will go to $D"
until [ "$(gh run view $RUN -R $R --json status -q .status 2>/dev/null)" = "completed" ]; do
  echo "$(date +%H:%M:%S) still running…"; sleep 30
done
gh run download $RUN -R $R -D $D || { echo "download failed; retry: gh run download $RUN -R $R -D $D"; exit 1; }
node summarize.mjs $D
grep -l "never verified" $D/p*/final.json 2>/dev/null | sed 's/^/Fix B repaired a stuck pair in: /'
grep -o 'FROZEN@[0-9]*s' -r $D/summary.json 2>/dev/null | sed 's/^/Frozen film: /'
echo "done: $D"