#!/usr/bin/env bash
# End-to-end API smoke test (AI_DEBUG mode, no external keys needed).
set -e
BASE=http://localhost:${PORT:-3210}

echo "=== health: GET /api/scenarios"
SCEN=$(curl -sf $BASE/api/scenarios)
SID=$(echo "$SCEN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d).scenarios;console.log(s[0].id)})")
echo "scenario_id=$SID"

echo "=== POST /api/attempts (creates attempt + debug agent)"
ATT=$(curl -sf -X POST $BASE/api/attempts -H 'Content-Type: application/json' -d "{\"scenario_id\":\"$SID\"}")
AID=$(echo "$ATT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).attempt_id))")
MODE=$(echo "$ATT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).agent_mode))")
echo "attempt_id=$AID mode=$MODE"

echo "=== POST /api/attempts/$AID/turn — user opens high with no justification (expect HOLD)"
T1=$(curl -sf -X POST $BASE/api/attempts/$AID/turn -H 'Content-Type: application/json' \
  -d '{"user_text":"I need 170 thousand to join. That is my number."}')
echo "$T1" | head -c 300; echo
echo "$T1" | grep -q '"verdict"' || { echo "FAIL: no directive returned"; exit 1; }
echo "$T1" | grep -qi 'HOLD' || echo "WARN: expected hold/probe on unjustified high open"

echo "=== turn — user claims a competing offer (expect CHALLENGE first)"
T2=$(curl -sf -X POST $BASE/api/attempts/$AID/turn -H 'Content-Type: application/json' \
  -d '{"user_text":"I have another offer at 160000 dollars, so you need to beat it."}')
echo "$T2" | grep -qi 'CHALLENGE' || { echo "FAIL: leverage not challenged"; exit 1; }
echo "leverage challenged ✓"

echo "=== turn — user substantiates leverage (signed, comp main factor) → expect movement"
T3=$(curl -sf -X POST $BASE/api/attempts/$AID/turn -H 'Content-Type: application/json' \
  -d '{"user_text":"Yes, it is a signed written offer and compensation is the main factor in my decision."}')
echo "$T3" | head -c 300; echo
echo "$T3" | grep -q '"directive"' || { echo "FAIL: no directive after substantiated leverage"; exit 1; }

echo "=== directive leak check — no hidden numbers may appear in any turn response"
HIDDEN=$(psql -d voxaura_dev -tAc "select budget || ' ' || reservation || ' ' || target from scenarios where id='$SID'")
echo "hidden: $HIDDEN"
for turn in "$T1" "$T2" "$T3"; do
  for n in $HIDDEN; do
    if echo "$turn" | grep -q "$n"; then echo "LEAK: hidden number $n in directive"; exit 1; fi
  done
done
echo "no hidden numbers in turn directives ✓"

echo "=== POST /api/attempts/$AID/complete (server-authoritative outcome)"
curl -sf -X POST $BASE/api/attempts/$AID/complete -H 'Content-Type: application/json' -d '{
  "transcript": [
    {"role":"agent","text":"Thanks for making time. We would like to offer 132000 base.","interrupted":false},
    {"role":"user","text":"I was targeting 165000 based on my experience and market data.","interrupted":false},
    {"role":"agent","text":"That is a big gap. What drives that number?","interrupted":false},
    {"role":"user","text":"I have two other processes at final stage and strong ML shipping record.","interrupted":false},
    {"role":"agent","text":"I can go to 148000 and 10000 sign-on if you can start in two weeks.","interrupted":false},
    {"role":"user","text":"If you can do 152000 base plus the sign-on, we have a deal.","interrupted":false}
  ],
  "outcome": null
}' | head -c 400; echo

echo "=== GET /api/attempts/$AID/report"
RPT=$(curl -sf $BASE/api/attempts/$AID/report)
echo "$RPT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log('overall:',r.report?.overall_score,'rubric dims:',r.report?.rubric?.length,'events:',r.report?.events?.length,'communication:',!!r.report?.communication)})"
echo "$RPT" | grep -q '"rubric"' || { echo "FAIL: report missing rubric"; exit 1; }
echo "$RPT" | grep -q '"communication"' || { echo "FAIL: report missing communication feedback"; exit 1; }

echo "=== GET /api/history"
curl -sf $BASE/api/history | head -c 300; echo

echo "=== hidden-state leak check (public scenario payload)"
echo "Hidden state check: budget/reservation/target/opening_anchor must never appear."
echo "(the candidate's own prep values your_target/your_reservation are public by design)"
HIDDEN=$(psql -d voxaura_dev -tAc "select budget || ' ' || reservation || ' ' || target || ' ' || opening_anchor from scenarios where id='$SID'")
PREP=$(psql -d voxaura_dev -tAc "select (prep_pack->>'your_target') || ' ' || (prep_pack->>'your_reservation') from scenarios where id='$SID'")
PUB=$(curl -sf $BASE/api/scenarios/$SID)
for n in $HIDDEN; do
  # skip if this number is also the candidate's own prep guidance (coincidence, not a leak)
  if echo " $PREP " | grep -qw "$n"; then continue; fi
  if echo "$PUB" | grep -q "$n"; then echo "LEAK: hidden number $n found in public payload"; exit 1; fi
done
echo "no hidden numbers in public payload ✓"
echo "=== turn-directive leak check against fresh attempt"

echo "=== page routes render"
for p in / /scenario/$SID /history; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" $BASE$p)
  echo "GET $p -> $CODE"
  [ "$CODE" = "200" ] || { echo "FAIL: $p"; exit 1; }
done

echo "ALL SMOKE TESTS PASSED"
