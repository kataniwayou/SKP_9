#!/usr/bin/env bash
# Fire analyst-monitor exactly once: one-shot cron two minutes ahead, start, wait for the step to
# begin, stop, restore the original workflow row. Usage: fire-once.sh <label>
set -euo pipefail
API=http://localhost:18080/api/v1
WF=208cba76-d635-4721-9aff-a7f22ee09224
DIR=${FIRE_DIR:-${TEMP:-/tmp}/analyst-fire}; mkdir -p "$DIR"
LABEL=${1:-fire}

curl -sf "$API/workflows/$WF" > "$DIR/wf-original-$LABEL.json"
ORIG_CRON=$(python -c "import json,sys;print(json.load(open(sys.argv[1]))['cronExpression'])" "$DIR/wf-original-$LABEL.json")
[ "$ORIG_CRON" = "0 9,39 * * * *" ] || { echo "unexpected original cron: $ORIG_CRON"; exit 1; }

# minute two ahead (UTC), avoiding the original 9/39 minutes
M=$(date -u -d '+2 min' +%-M); H=$(date -u -d '+2 min' +%-H)
CRON="0 $M $H * * *"
python - "$DIR/wf-original-$LABEL.json" "$CRON" > "$DIR/wf-oneshot-$LABEL.json" <<'EOF'
import json,sys
w=json.load(open(sys.argv[1]))
body={k:w[k] for k in ('name','version','description','entryStepIds','assignmentIds','cacheIds')}
body['cronExpression']=sys.argv[2]
print(json.dumps(body))
EOF
NF=$(python -c "import json,sys;print(len(json.load(open(sys.argv[1]))['cronExpression'].split()))" "$DIR/wf-oneshot-$LABEL.json")
[ "$NF" = 6 ] || { echo "cron field count $NF"; exit 1; }
echo "one-shot cron: $CRON"
trap 'echo "ERROR: stopping $WF"; curl -s -X POST "$API/orchestration/stop" -H "Content-Type: application/json" --data "\"$WF\"" -o /dev/null -w "stop %{http_code}\n"' ERR
curl -sf -X PUT "$API/workflows/$WF" -H 'Content-Type: application/json' --data @"$DIR/wf-oneshot-$LABEL.json" -o /dev/null -w "PUT one-shot %{http_code}\n"
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s -X POST "$API/orchestration/start" -H 'Content-Type: application/json' --data "\"$WF\"" -o /dev/null -w "start %{http_code}\n"

# wait (max 6 min) for an analyst pod to log that it is running the step
for i in $(seq 1 72); do
  if kubectl -n skp logs -l app=processor-analyst --tail=-1 --since-time="$SINCE" 2>/dev/null | grep -qi "running the step"; then
    echo "step started at $(date -u +%H:%M:%SZ)"; break
  fi
  sleep 5
done

curl -s -X POST "$API/orchestration/stop" -H 'Content-Type: application/json' --data "\"$WF\"" -o /dev/null -w "stop %{http_code}\n"
python - "$DIR/wf-original-$LABEL.json" > "$DIR/wf-restore-$LABEL.json" <<'EOF'
import json,sys
w=json.load(open(sys.argv[1]))
print(json.dumps({k:w[k] for k in ('name','version','description','entryStepIds','assignmentIds','cacheIds','cronExpression')}))
EOF
curl -sf -X PUT "$API/workflows/$WF" -H 'Content-Type: application/json' --data @"$DIR/wf-restore-$LABEL.json" -o /dev/null -w "PUT restore %{http_code}\n"
curl -sf "$API/workflows/$WF" | python -c "import json,sys;print('cron now:',json.load(sys.stdin)['cronExpression'])"
echo "since=$SINCE"
