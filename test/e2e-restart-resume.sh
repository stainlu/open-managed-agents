#!/usr/bin/env bash
#
# Live restart/respawn E2E for managed harness adapters.
#
# Proves the OMA layer's core durability contract:
#   1. A managed session survives an orderly orchestrator restart.
#   2. The restart adopts the same already-running agent container.
#   3. If the active agent container dies later, the session respawns and
#      resumes through the same managed session id.
#
# Prerequisites:
#   - docker compose up --build -d
#   - provider credentials injected into the orchestrator before compose start
#
# Useful overrides:
#   BASE_URL=http://localhost:8081 ./test/e2e-restart-resume.sh
#   OMA_RESTART_HARNESSES=codex ./test/e2e-restart-resume.sh
#   OMA_RESTART_HARNESSES=openclaw OMA_RESTART_REQUIRE=1 ./test/e2e-restart-resume.sh
#   OMA_RESTART_REQUIRE=1 ./test/e2e-restart-resume.sh
#   OMA_RESTART_CODEX_MODEL=openai/gpt-5.4 ./test/e2e-restart-resume.sh
#   OMA_RESTART_CLAUDE_AGENT_SDK_MODEL=anthropic/claude-opus-4.7 ./test/e2e-restart-resume.sh
#   OMA_RESTART_OPENCLAW_MODEL=moonshot/kimi-k2.5 ./test/e2e-restart-resume.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
HARNESSES="${OMA_RESTART_HARNESSES:-codex claude-agent-sdk}"
HARNESSES="${HARNESSES//,/ }"
POLL_INTERVAL_SEC="${OMA_RESTART_POLL_INTERVAL_SEC:-2}"
MAX_POLL_SEC="${OMA_RESTART_MAX_POLL_SEC:-360}"
HEALTH_MAX_SEC="${OMA_RESTART_HEALTH_MAX_SEC:-120}"
REQUIRE="${OMA_RESTART_REQUIRE:-0}"
COMPOSE_SERVICE="${OMA_RESTART_COMPOSE_SERVICE:-orchestrator}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/oma-restart-resume.XXXXXX")"
CREATED_SESSIONS=()
CREATED_AGENTS=()

say() { echo "[e2e-restart-resume] $*"; }
die() { echo "[e2e-restart-resume] FATAL: $*" >&2; exit 1; }

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
  rm -rf "${SCRATCH}" >/dev/null 2>&1 || true
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

wait_for_health() {
  local elapsed=0
  local last_error=""
  while [[ "${elapsed}" -lt "${HEALTH_MAX_SEC}" ]]; do
    if last_error="$(api GET /healthz 2>&1 >/dev/null)"; then
      return 0
    fi
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
    say "health t=${elapsed}s not ready"
  done
  if [[ -n "${last_error}" ]]; then
    say "last health error: ${last_error}"
  fi
  return 1
}

compose_restart_orchestrator() {
  (cd "${REPO_ROOT}" && docker compose restart "${COMPOSE_SERVICE}" >/dev/null)
}

stop_container() {
  local container_id="$1"
  docker stop "${container_id}" >/dev/null
}

required_key_for_harness() {
  case "$1" in
    openclaw) echo "${OMA_RESTART_OPENCLAW_REQUIRED_KEY:-MOONSHOT_API_KEY}" ;;
    codex) echo "OPENAI_API_KEY" ;;
    claude-agent-sdk) echo "ANTHROPIC_API_KEY" ;;
    hermes) echo "${OMA_RESTART_HERMES_REQUIRED_KEY:-OPENAI_API_KEY}" ;;
    *) return 1 ;;
  esac
}

model_for_harness() {
  case "$1" in
    openclaw) echo "${OMA_RESTART_OPENCLAW_MODEL:-moonshot/kimi-k2.5}" ;;
    codex) echo "${OMA_RESTART_CODEX_MODEL:-openai/gpt-5.5}" ;;
    claude-agent-sdk) echo "${OMA_RESTART_CLAUDE_AGENT_SDK_MODEL:-anthropic/claude-sonnet-4-6}" ;;
    hermes) echo "${OMA_RESTART_HERMES_MODEL:-openai/gpt-5.5}" ;;
    *) return 1 ;;
  esac
}

safe_harness_name() {
  echo "${1//-/_}"
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

create_agent() {
  local harness="$1"
  local model="$2"
  local name="$3"
  local instructions="$4"
  local body response agent_id

  body="$(jq -n \
    --arg name "${name}" \
    --arg harnessId "${harness}" \
    --arg model "${model}" \
    --arg instructions "${instructions}" \
    '{
      name: $name,
      harnessId: $harnessId,
      model: $model,
      tools: [],
      instructions: $instructions,
      permissionPolicy: {type: "always_allow"},
      thinkingLevel: "off"
    }')"
  response="$(api POST /v1/agents -d "${body}")"
  agent_id="$(echo "${response}" | jq -r '.agent_id')"
  [[ -n "${agent_id}" && "${agent_id}" != "null" ]] \
    || die "${harness}: failed to create agent: ${response}"
  CREATED_AGENTS+=("${agent_id}")
  echo "${agent_id}"
}

create_session() {
  local agent_id="$1"
  local response session_id
  response="$(api POST /v1/sessions -d "{\"agentId\":\"${agent_id}\"}")"
  session_id="$(echo "${response}" | jq -r '.session_id')"
  [[ -n "${session_id}" && "${session_id}" != "null" ]] \
    || die "failed to create session for ${agent_id}: ${response}"
  CREATED_SESSIONS+=("${session_id}")
  echo "${session_id}"
}

post_turn_and_wait() {
  local session_id="$1"
  local label="$2"
  local content="$3"
  local body
  body="$(jq -n --arg c "${content}" '{type: "user.message", content: $c}')"
  api POST "/v1/sessions/${session_id}/events" -d "${body}" >/dev/null
  poll_session "${session_id}" "${label}" >/dev/null
}

latest_agent_message() {
  local session_id="$1"
  api GET "/v1/sessions/${session_id}/events" \
    | jq -r '[.events[] | select(.type=="agent.message")] | last | .content // ""'
}

assert_contains() {
  local label="$1"
  local haystack="$2"
  local needle="$3"
  if ! echo "${haystack}" | grep -Fq "${needle}"; then
    die "${label}: expected output to contain ${needle}; got ${haystack}"
  fi
}

assert_session_idle_with_container() {
  local harness="$1"
  local session_id="$2"
  local expected_turns="$3"
  local json container_id turns status
  json="$(api GET "/v1/sessions/${session_id}")"
  status="$(echo "${json}" | jq -r '.status')"
  turns="$(echo "${json}" | jq -r '.turns')"
  container_id="$(echo "${json}" | jq -r '.container_id // ""')"
  [[ "${status}" == "idle" ]] \
    || die "${harness}: session ${session_id} should be idle: ${json}"
  [[ "${turns}" == "${expected_turns}" ]] \
    || die "${harness}: session ${session_id} turns=${turns}, expected ${expected_turns}: ${json}"
  [[ -n "${container_id}" && "${container_id}" != "null" ]] \
    || die "${harness}: session ${session_id} has no live container: ${json}"
  echo "${container_id}"
}

run_harness() {
  local harness="$1"
  local model="$2"
  local safe_harness run_id agent_id session_id memory ack recall respawn container_before_restart
  local container_after_restart container_before_kill container_after_respawn output

  safe_harness="$(safe_harness_name "${harness}")"
  run_id="$(date +%s)"
  memory="OMA_RESTART_${safe_harness}_MEMORY_${run_id}"
  ack="OMA_RESTART_${safe_harness}_ACK_${run_id}"
  recall="OMA_RESTART_${safe_harness}_RECALL_${run_id}"
  respawn="OMA_RESPAWN_${safe_harness}_RECALL_${run_id}"

  say "${harness}: create agent/session"
  agent_id="$(create_agent \
    "${harness}" \
    "${model}" \
    "restart-${harness}" \
    "You are a restart-safety test agent. Follow exact-output instructions.")"
  session_id="$(create_session "${agent_id}")"

  say "${harness}: turn 1 remember ${memory}"
  post_turn_and_wait \
    "${session_id}" \
    "${harness}:turn1" \
    "Remember this token: ${memory}. Reply with exactly ${ack} and no other text."
  output="$(latest_agent_message "${session_id}")"
  assert_contains "${harness}: turn1" "${output}" "${ack}"
  container_before_restart="$(assert_session_idle_with_container "${harness}" "${session_id}" "1")"
  say "${harness}: active container before restart ${container_before_restart}"

  say "${harness}: restarting orchestrator"
  compose_restart_orchestrator
  wait_for_health \
    || die "${harness}: orchestrator did not become healthy after restart"
  container_after_restart="$(assert_session_idle_with_container "${harness}" "${session_id}" "1")"
  [[ "${container_after_restart}" == "${container_before_restart}" ]] \
    || die "${harness}: expected restart adoption to preserve container ${container_before_restart}, got ${container_after_restart}"
  say "${harness}: PASS orderly restart adopted same container"

  say "${harness}: turn 2 recall after orchestrator restart"
  post_turn_and_wait \
    "${session_id}" \
    "${harness}:turn2" \
    "Using the prior turn in this same managed session, reply with exactly ${recall} ${memory} and no other text."
  output="$(latest_agent_message "${session_id}")"
  assert_contains "${harness}: turn2 recall marker" "${output}" "${recall}"
  assert_contains "${harness}: turn2 memory marker" "${output}" "${memory}"
  container_before_kill="$(assert_session_idle_with_container "${harness}" "${session_id}" "2")"

  say "${harness}: stopping active agent container ${container_before_kill}"
  stop_container "${container_before_kill}"

  say "${harness}: turn 3 recall after forced container death"
  post_turn_and_wait \
    "${session_id}" \
    "${harness}:turn3" \
    "The agent container was killed, but this managed session should resume. Reply with exactly ${respawn} ${memory} and no other text."
  output="$(latest_agent_message "${session_id}")"
  assert_contains "${harness}: turn3 respawn marker" "${output}" "${respawn}"
  assert_contains "${harness}: turn3 memory marker" "${output}" "${memory}"
  container_after_respawn="$(assert_session_idle_with_container "${harness}" "${session_id}" "3")"
  [[ "${container_after_respawn}" != "${container_before_kill}" ]] \
    || die "${harness}: expected a fresh container after forced stop, still got ${container_after_respawn}"
  say "${harness}: PASS container respawn preserved managed session"
}

RUNNABLE=()
for harness in ${HARNESSES}; do
  key_var="$(required_key_for_harness "${harness}")" \
    || die "unknown harness ${harness}; expected openclaw, codex, claude-agent-sdk, or hermes"
  key_value="${!key_var-}"
  if [[ -n "${key_value}" ]]; then
    RUNNABLE+=("${harness}")
  elif [[ "${REQUIRE}" == "1" ]]; then
    say "${harness}: ${key_var} is not set in this shell; assuming orchestrator has server-side credentials"
    RUNNABLE+=("${harness}")
  else
    say "skip ${harness}: ${key_var} is not set"
  fi
done

if [[ "${#RUNNABLE[@]}" -eq 0 ]]; then
  say "no live harnesses runnable; exiting 0"
  exit 0
fi

say "checking orchestrator health at ${BASE_URL}/healthz"
wait_for_health \
  || die "orchestrator is not healthy; run docker compose up -d first"

for harness in "${RUNNABLE[@]}"; do
  run_harness "${harness}" "$(model_for_harness "${harness}")"
done

say "SUCCESS: restart/respawn E2E passed for ${RUNNABLE[*]}"
