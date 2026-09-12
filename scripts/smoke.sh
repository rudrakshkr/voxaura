#!/usr/bin/env bash
# End-to-end API smoke test (AI_DEBUG mode, no external keys needed).
set -e
BASE=http://localhost:3210

echo "=== health: GET /api/scenarios"
SCEN=$(curl -sf $BASE/api/scenarios)
echo "$SCEN" | head -c 200; echo
SID=$(echo "$SCEN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d).scenarios;console.log(s[0].id)})")
echo "scenario_id=$SID"

echo "=== POST /api/attempts (creates attempt + debug agent)"
ATT=$(curl -sf -X POST $BASE/api/attempts -H 'Content-Type: application/json' -d "{\"scenario_id\":\"$SID\"}")
echo "$ATT"
AID=$(echo "$ATT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).attempt_id))")
MODE=$(echo "$ATT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).agent_mode))")
echo "attempt_id=$AID mode=$MODE"

echo "=== POST /api/attempts/$AID/events (batch of 2)"
curl -sf -X POST $BASE/api/attempts/$AID/events -H 'Content-Type: application/json' -d '{
  "session_id": "sess_smoke_1",
  "events": [
    {"type":"user_offer","actor":"user","source":"tool","payload":{"amount":165000},"at_ms":42000},
    {"type":"opponent_offer","actor":"opponent","source":"tool","payload":{"package":{"base":148000,"sign_on":10000}},"at_ms":61000}
  ]
}'; echo

echo "=== POST /api/attempts/$AID/complete"
curl -sf -X POST $BASE/api/attempts/$AID/complete -H 'Content-Type: application/json' -d '{
  "transcript": [
    {"role":"agent","text":"Thanks for making time. We would like to offer 132000 base.","interrupted":false},
    {"role":"user","text":"I was targeting 165000 based on my experience and market data.","interrupted":false},
    {"role":"agent","text":"I can go to 148000 and 10000 sign-on. That is our best.","interrupted":false},
    {"role":"user","text":"If you can do 152000 base plus the sign-on, we have a deal.","interrupted":false}
  ],
  "outcome": "accepted"
}'; echo

echo "=== GET /api/attempts/$AID/report"
curl -sf $BASE/api/attempts/$AID/report | head -c 600; echo

echo "=== GET /api/history"
curl -sf $BASE/api/history | head -c 400; echo

echo "=== hidden-state leak check (public scenario must not contain hidden numbers)"
HIDDEN=$(psql -d voxaura_dev -tAc "select budget || ' ' || reservation || ' ' || target from scenarios where id='$SID'")
echo "hidden in DB: $HIDDEN"
PUB=$(curl -sf $BASE/api/scenarios/$SID)
for n in $HIDDEN; do
  if echo "$PUB" | grep -q "$n"; then echo "LEAK: $n found in public payload"; exit 1; fi
done
echo "no hidden numbers in public payload ✓"
echo "ALL SMOKE TESTS PASSED"
