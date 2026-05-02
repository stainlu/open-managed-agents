#!/usr/bin/env bash
#
# Live approval E2E for the OpenClaw harness.
#
# Proves the real managed tool-approval path:
#   1. Agent template uses permissionPolicy always_ask.
#   2. The harness blocks a real tool call.
#   3. The orchestrator surfaces agent.tool_confirmation_request over SSE.
#   4. Client posts user.tool_confirmation.
#   5. The blocked tool resumes and the session completes.
#
# Prerequisites:
#   - docker compose up -d
#   - provider credentials injected into the orchestrator before compose start
#
# Useful overrides:
#   BASE_URL=http://localhost:8081 ./test/e2e-approvals.sh
#   OMA_APPROVAL_REQUIRE=1 ./test/e2e-approvals.sh
#   OMA_APPROVAL_MODEL=moonshot/kimi-k2.6 ./test/e2e-approvals.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
MODEL="${OMA_APPROVAL_MODEL:-${OPENCLAW_TEST_MODEL:-moonshot/kimi-k2.6}}"
REQUIRED_KEY="${OMA_APPROVAL_REQUIRED_KEY:-MOONSHOT_API_KEY}"
REQUIRE="${OMA_APPROVAL_REQUIRE:-0}"
POLL_INTERVAL_SEC="${OMA_APPROVAL_POLL_INTERVAL_SEC:-2}"
MAX_POLL_SEC="${OMA_APPROVAL_MAX_POLL_SEC:-600}"
HEALTH_MAX_SEC="${OMA_APPROVAL_HEALTH_MAX_SEC:-120}"
ORCHESTRATOR_CONTAINER="${OMA_ORCHESTRATOR_CONTAINER:-open-managed-agents-orchestrator}"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/oma-approvals.XXXXXX")"
SSE_OUT="${SCRATCH}/events.sse"
SSE_PID=""
AGENT_ID=""
SESSION_ID=""

say() { echo "[e2e-approvals] $*" >&2; }
die() { echo "[e2e-approvals] FATAL: $*" >&2; exit 1; }

cleanup() {
  local ec=$?
  set +u
  if [[ -n "${SSE_PID}" ]]; then
    kill "${SSE_PID}" >/dev/null 2>&1 || true
    wait "${SSE_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SESSION_ID}" ]]; then
    delete_resource "/v1/sessions/${SESSION_ID}" || true
  fi
  if [[ -n "${AGENT_ID}" ]]; then
    delete_resource "/v1/agents/${AGENT_ID}" || true
  fi
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

start_sse() {
  local path="$1"
  local out="$2"
  if [[ -n "${OPENCLAW_API_TOKEN:-}" ]]; then
    curl --silent --no-buffer \
      -H "Authorization: Bearer ${OPENCLAW_API_TOKEN}" \
      "${BASE_URL}${path}" >"${out}" 2>&1 &
  else
    curl --silent --no-buffer \
      "${BASE_URL}${path}" >"${out}" 2>&1 &
  fi
  SSE_PID=$!
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

print_diagnostics() {
  say "session:"
  if [[ -n "${SESSION_ID}" ]]; then
    api GET "/v1/sessions/${SESSION_ID}" | jq . >&2 || true
    say "events:"
    api GET "/v1/sessions/${SESSION_ID}/events" | jq . >&2 || true
  fi
  say "SSE output:"
  head -c 4096 "${SSE_OUT}" >&2 || true
  echo >&2
  say "orchestrator logs:"
  docker logs --tail 80 "${ORCHESTRATOR_CONTAINER}" >&2 || true
}

extract_approval_id() {
  awk '
    $0 == "event: agent.tool_confirmation_request" { seen=1; next }
    seen && /^data: / {
      sub(/^data: /, "");
      print;
      exit;
    }
    seen && $0 == "" { seen=0 }
  ' "${SSE_OUT}" | jq -r '.approval_id // ""'
}

wait_for_approval() {
  local elapsed=0
  local approval_id=""
  local status=""

  while [[ "${elapsed}" -lt "${MAX_POLL_SEC}" ]]; do
    sleep "${POLL_INTERVAL_SEC}"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
    approval_id="$(extract_approval_id || true)"
    if [[ -n "${approval_id}" && "${approval_id}" != "null" ]]; then
      echo "${approval_id}"
      return 0
    fi
    if [[ -n "${SESSION_ID}" ]]; then
      status="$(api GET "/v1/sessions/${SESSION_ID}" | jq -r '.status')"
      if [[ "${status}" == "failed" ]]; then
        print_diagnostics
        return 1
      fi
      say "approval t=${elapsed}s status=${status}"
    else
      say "approval t=${elapsed}s waiting"
    fi
  done

  print_diagnostics
  return 1
}

post_message() {
  local session_id="$1"
  local content="$2"
  local body
  body="$(jq -n --arg c "${content}" '{type: "user.message", content: $c}')"
  api POST "/v1/sessions/${session_id}/events" -d "${body}" >/dev/null
}

confirm_tool() {
  local session_id="$1"
  local approval_id="$2"
  local body
  body="$(jq -n --arg id "${approval_id}" '{
    type: "user.tool_confirmation",
    toolUseId: $id,
    result: "allow"
  }')"
  api POST "/v1/sessions/${session_id}/events" -d "${body}" >/dev/null
}

if [[ -z "${!REQUIRED_KEY-}" && "${REQUIRE}" != "1" ]]; then
  say "skip: ${REQUIRED_KEY} is not set"
  exit 0
fi
if [[ -z "${!REQUIRED_KEY-}" ]]; then
  say "${REQUIRED_KEY} is not set in this shell; assuming orchestrator has server-side credentials"
fi

say "checking orchestrator health at ${BASE_URL}/healthz"
wait_for_health \
  || die "orchestrator is not healthy; run docker compose up -d first"

say "creating OpenClaw approval agent with model ${MODEL}"
AGENT_ID="$(api POST /v1/agents -d "$(jq -n \
  --arg model "${MODEL}" \
  '{
    name: "approval-e2e-openclaw",
    harnessId: "openclaw",
    model: $model,
    tools: [],
    instructions: "When asked to run a shell command, you must use the available shell/bash/exec tool. After it runs, reply with only the observed stdout.",
    permissionPolicy: {type: "always_ask"},
    thinkingLevel: "off"
  }')" | jq -r '.agent_id')"
[[ -n "${AGENT_ID}" && "${AGENT_ID}" != "null" ]] \
  || die "failed to create approval agent"

SESSION_ID="$(api POST /v1/sessions -d "{\"agentId\":\"${AGENT_ID}\"}" | jq -r '.session_id')"
[[ -n "${SESSION_ID}" && "${SESSION_ID}" != "null" ]] \
  || die "failed to create approval session"
say "session ${SESSION_ID}"

start_sse "/v1/sessions/${SESSION_ID}/events?stream=true" "${SSE_OUT}"
sleep 1

MARKER="OMA_APPROVAL_OPENCLAW_$(date +%s)"
say "posting turn that must trigger tool approval for marker ${MARKER}"
post_message \
  "${SESSION_ID}" \
  "Run this exact shell command and then reply with only its stdout: echo ${MARKER}"

say "waiting for agent.tool_confirmation_request"
APPROVAL_ID="$(wait_for_approval)" \
  || die "never received agent.tool_confirmation_request"
say "received approval ${APPROVAL_ID}; allowing once"
confirm_tool "${SESSION_ID}" "${APPROVAL_ID}"

poll_session "${SESSION_ID}" "after-approval" >/dev/null \
  || die "session did not complete after approval"

OUTPUT="$(latest_agent_message "${SESSION_ID}")"
say "final output: ${OUTPUT}"
if ! echo "${OUTPUT}" | grep -Fq "${MARKER}"; then
  print_diagnostics
  die "final output did not contain ${MARKER}"
fi

say "SUCCESS: live OpenClaw tool approval E2E passed"
