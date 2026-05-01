#!/usr/bin/env bash
#
# Live E2E for experimental non-OpenClaw harness adapters.
#
# This is intentionally separate from test/e2e.sh. The default E2E verifies
# the OpenClaw-backed product path. This script verifies that Codex and Claude
# Agent SDK can run through the same managed Agent -> Session -> Event API,
# including a second same-session turn that proves context/native resume.
#
# Prerequisites when a harness is enabled:
#   - docker compose up -d (orchestrator on localhost:8080 by default)
#   - provider credentials exported before compose starts, so the orchestrator
#     can forward them into spawned adapter containers.
#
# Defaults:
#   - codex requires OPENAI_API_KEY and uses openai/gpt-5.5
#   - claude-agent-sdk requires ANTHROPIC_API_KEY and uses
#     anthropic/claude-sonnet-4-6
#
# Useful overrides:
#   BASE_URL=http://localhost:8080 ./test/e2e-harnesses.sh
#   OMA_LIVE_HARNESSES=codex ./test/e2e-harnesses.sh
#   OMA_LIVE_CODEX_MODEL=openai/gpt-5.4 ./test/e2e-harnesses.sh
#   OMA_LIVE_CLAUDE_AGENT_SDK_MODEL=anthropic/claude-opus-4.7 ./test/e2e-harnesses.sh
#   OMA_LIVE_REQUIRE=1 ./test/e2e-harnesses.sh
#
# If no required provider key is present, the script exits 0 after reporting
# skips. Set OMA_LIVE_REQUIRE=1 to make missing keys a failure.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
HARNESSES="${OMA_LIVE_HARNESSES:-codex claude-agent-sdk}"
HARNESSES="${HARNESSES//,/ }"
POLL_INTERVAL_SEC="${OMA_LIVE_POLL_INTERVAL_SEC:-2}"
MAX_POLL_SEC="${OMA_LIVE_MAX_POLL_SEC:-360}"
REQUIRE="${OMA_LIVE_REQUIRE:-0}"

CREATED_SESSIONS=()
CREATED_AGENTS=()

say() { echo "[e2e-harnesses] $*"; }
die() { echo "[e2e-harnesses] FATAL: $*" >&2; exit 1; }

cleanup() {
  local ec=$?
  local session_id agent_id
  set +u
  for session_id in "${CREATED_SESSIONS[@]}"; do
    delete_resource "/v1/sessions/${session_id}" || true
  done
  for agent_id in "${CREATED_AGENTS[@]}"; do
    delete_resource "/v1/agents/${agent_id}" || true
  done
  exit "${ec}"
}
trap cleanup EXIT

delete_resource() {
  local path="$1"
  if [[ -n "${OPENCLAW_API_TOKEN:-}" ]]; then
    curl --silent -X DELETE \
      -H "Authorization: Bearer ${OPENCLAW_API_TOKEN}" \
      "${BASE_URL}${path}" >/dev/null 2>&1
  else
    curl --silent -X DELETE "${BASE_URL}${path}" >/dev/null 2>&1
  fi
}

api() {
  local method="$1"
  local path="$2"
  shift 2
  if [[ -n "${OPENCLAW_API_TOKEN:-}" ]]; then
    curl --silent --show-error --fail \
      -X "${method}" \
      -H "Authorization: Bearer ${OPENCLAW_API_TOKEN}" \
      -H "Content-Type: application/json" \
      "${BASE_URL}${path}" \
      "$@"
  else
    curl --silent --show-error --fail \
      -X "${method}" \
      -H "Content-Type: application/json" \
      "${BASE_URL}${path}" \
      "$@"
  fi
}

required_key_for_harness() {
  case "$1" in
    codex) echo "OPENAI_API_KEY" ;;
    claude-agent-sdk) echo "ANTHROPIC_API_KEY" ;;
    *) return 1 ;;
  esac
}

model_for_harness() {
  case "$1" in
    codex) echo "${OMA_LIVE_CODEX_MODEL:-openai/gpt-5.5}" ;;
    claude-agent-sdk) echo "${OMA_LIVE_CLAUDE_AGENT_SDK_MODEL:-anthropic/claude-sonnet-4-6}" ;;
    *) return 1 ;;
  esac
}

poll_session() {
  local session_id="$1"
  local label="$2"
  local elapsed=0
  local status=""
  local session_json=""

  while [[ "${elapsed}" -lt "${MAX_POLL_SEC}" ]]; do
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
    session_json="$(api GET "/v1/sessions/${session_id}")"
    status="$(echo "${session_json}" | jq -r '.status')"
    say "${label} t=${elapsed}s status=${status}"
    case "${status}" in
      idle)
        echo "${session_json}"
        return 0
        ;;
      failed)
        echo "${session_json}" | jq . >&2
        return 1
        ;;
    esac
  done

  say "${label} timed out after ${MAX_POLL_SEC}s; last status=${status}"
  if [[ -n "${session_json}" ]]; then
    echo "${session_json}" | jq . >&2 || true
  fi
  return 1
}

latest_agent_message() {
  local session_id="$1"
  api GET "/v1/sessions/${session_id}/events" \
    | jq -r '[.events[] | select(.type=="agent.message")] | last | .content // ""'
}

assert_harness_registered() {
  local catalog="$1"
  local harness="$2"
  echo "${catalog}" \
    | jq -e --arg h "${harness}" '.harnesses[]? | select(.harness_id == $h)' >/dev/null \
    || die "harness ${harness} is not registered by /v1/harnesses"
}

post_turn_and_wait() {
  local session_id="$1"
  local label="$2"
  local content="$3"
  local event_body
  event_body="$(jq -n --arg c "${content}" '{type: "user.message", content: $c}')"
  api POST "/v1/sessions/${session_id}/events" -d "${event_body}" >/dev/null
  poll_session "${session_id}" "${label}" >/dev/null
}

assert_message_contains() {
  local harness="$1"
  local session_id="$2"
  local output="$3"
  local expected="$4"

  if ! echo "${output}" | grep -Fq "${expected}"; then
    say "${harness}: expected latest message to contain ${expected}"
    api GET "/v1/sessions/${session_id}/events" | jq . >&2 || true
    return 1
  fi
}

run_harness() {
  local harness="$1"
  local model="$2"
  local safe_harness="${harness//-/_}"
  local run_id
  run_id="$(date +%s)"
  local ack_marker="OMA_LIVE_${safe_harness}_ACK_${run_id}"
  local memory_marker="OMA_LIVE_${safe_harness}_MEMORY_${run_id}"
  local recall_marker="OMA_LIVE_${safe_harness}_RECALL_${run_id}"

  say "creating ${harness} agent with model ${model}"
  local create_body
  create_body="$(jq -n \
    --arg name "live-${harness}" \
    --arg harnessId "${harness}" \
    --arg model "${model}" \
    --arg instructions "You are a live adapter test agent. Follow exact-output instructions." \
    '{
      name: $name,
      harnessId: $harnessId,
      model: $model,
      tools: [],
      instructions: $instructions,
      permissionPolicy: {type: "always_allow"},
      thinkingLevel: "off"
    }')"

  local agent_response agent_id
  agent_response="$(api POST /v1/agents -d "${create_body}")"
  agent_id="$(echo "${agent_response}" | jq -r '.agent_id')"
  [[ -n "${agent_id}" && "${agent_id}" != "null" ]] \
    || die "failed to create ${harness} agent: ${agent_response}"
  CREATED_AGENTS+=("${agent_id}")

  say "creating ${harness} session"
  local session_response session_id
  session_response="$(api POST /v1/sessions -d "{\"agentId\":\"${agent_id}\"}")"
  session_id="$(echo "${session_response}" | jq -r '.session_id')"
  [[ -n "${session_id}" && "${session_id}" != "null" ]] \
    || die "failed to create ${harness} session: ${session_response}"
  CREATED_SESSIONS+=("${session_id}")

  say "${harness}: turn 1 remember ${memory_marker}"
  post_turn_and_wait \
    "${session_id}" \
    "${harness}:turn1" \
    "Remember this token for the next turn: ${memory_marker}. Reply with exactly this token and no other text: ${ack_marker}" || {
    say "${harness}: failed; events follow"
    api GET "/v1/sessions/${session_id}/events" | jq . >&2 || true
    return 1
  }

  local turn1_output
  turn1_output="$(latest_agent_message "${session_id}")"
  say "${harness}: turn1 output=${turn1_output}"
  assert_message_contains "${harness}" "${session_id}" "${turn1_output}" "${ack_marker}" || return 1

  say "${harness}: turn 2 recall ${memory_marker}"
  post_turn_and_wait \
    "${session_id}" \
    "${harness}:turn2" \
    "Using the prior turn in this same managed session, reply with exactly two space-separated tokens and no other text. First token: ${recall_marker}. Second token: the token I asked you to remember in the prior turn." || {
    say "${harness}: failed during recall; events follow"
    api GET "/v1/sessions/${session_id}/events" | jq . >&2 || true
    return 1
  }

  local turn2_output
  turn2_output="$(latest_agent_message "${session_id}")"
  say "${harness}: turn2 output=${turn2_output}"
  assert_message_contains "${harness}" "${session_id}" "${turn2_output}" "${recall_marker}" || return 1
  assert_message_contains "${harness}" "${session_id}" "${turn2_output}" "${memory_marker}" || return 1

  local events_json bad_session_count user_count agent_count convo_count ordered
  events_json="$(api GET "/v1/sessions/${session_id}/events")"
  bad_session_count="$(echo "${events_json}" | jq --arg sid "${session_id}" '[.events[] | select(.session_id != $sid)] | length')"
  user_count="$(echo "${events_json}" | jq '[.events[] | select(.type == "user.message")] | length')"
  agent_count="$(echo "${events_json}" | jq '[.events[] | select(.type == "agent.message")] | length')"
  convo_count="$(echo "${events_json}" | jq '[.events[] | select(.type == "user.message" or .type == "agent.message")] | length')"
  ordered="$(echo "${events_json}" | jq -r '[.events[].created_at] as $ts | ($ts == ($ts | sort))')"
  [[ "${bad_session_count}" == "0" ]] \
    || die "${harness}: events contain wrong session_id"
  [[ "${user_count}" -ge "2" ]] \
    || die "${harness}: expected at least two user.message events"
  [[ "${agent_count}" -ge "2" ]] \
    || die "${harness}: expected at least two agent.message events"
  [[ "${convo_count}" -ge "4" ]] \
    || die "${harness}: expected at least two managed conversation turns"
  [[ "${ordered}" == "true" ]] \
    || die "${harness}: events are not chronologically ordered"

  say "${harness}: PASS two-turn managed session"
}

RUNNABLE=()
for harness in ${HARNESSES}; do
  key_var="$(required_key_for_harness "${harness}")" \
    || die "unknown live harness ${harness}; expected codex or claude-agent-sdk"
  key_value="${!key_var-}"
  if [[ -n "${key_value}" ]]; then
    RUNNABLE+=("${harness}")
  else
    say "skip ${harness}: ${key_var} is not set"
  fi
done

if [[ "${#RUNNABLE[@]}" -eq 0 ]]; then
  if [[ "${REQUIRE}" == "1" ]]; then
    die "no live harnesses runnable; set OPENAI_API_KEY and/or ANTHROPIC_API_KEY"
  fi
  say "no live harnesses runnable; exiting 0"
  exit 0
fi

say "checking orchestrator health at ${BASE_URL}/healthz"
api GET /healthz >/dev/null \
  || die "orchestrator is not healthy; run docker compose up -d first"

CATALOG="$(api GET /v1/harnesses)"
for harness in "${RUNNABLE[@]}"; do
  assert_harness_registered "${CATALOG}" "${harness}"
done

for harness in "${RUNNABLE[@]}"; do
  run_harness "${harness}" "$(model_for_harness "${harness}")"
done

say "SUCCESS: live harness E2E passed for ${RUNNABLE[*]}"
