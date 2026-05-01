#!/usr/bin/env bash
#
# Provider-backed feature-matrix E2E for non-OpenClaw harness adapters.
#
# This complements test/e2e-harnesses.sh:
#   - e2e-harnesses proves two-turn managed-session recall.
#   - this script proves capability catalog entries are enforced by the
#     managed API and that supported live paths still work through real
#     providers.
#
# Prerequisites when a harness is enabled:
#   - docker compose up -d (orchestrator on localhost:8080 by default)
#   - provider credentials exported before compose starts, so the orchestrator
#     can forward them into spawned adapter containers.
#
# Defaults:
#   - codex uses openai/gpt-5.5 and normally needs OPENAI_API_KEY in the
#     compose/orchestrator environment.
#   - claude-agent-sdk uses anthropic/claude-sonnet-4-6 and normally needs
#     ANTHROPIC_API_KEY in the compose/orchestrator environment.
#
# Useful overrides:
#   BASE_URL=http://localhost:8081 ./test/e2e-feature-matrix.sh
#   OMA_FEATURE_HARNESSES=codex ./test/e2e-feature-matrix.sh
#   OMA_FEATURE_CODEX_MODEL=openai/gpt-5.4 ./test/e2e-feature-matrix.sh
#   OMA_FEATURE_CLAUDE_AGENT_SDK_MODEL=anthropic/claude-opus-4.7 ./test/e2e-feature-matrix.sh
#   OMA_FEATURE_REQUIRE=1 ./test/e2e-feature-matrix.sh
#   OMA_FEATURE_TEST_CANCEL=1 ./test/e2e-feature-matrix.sh
#
# Without OMA_FEATURE_REQUIRE=1, harnesses whose provider key is not visible in
# the local test shell are skipped. With OMA_FEATURE_REQUIRE=1, the script runs
# anyway and lets the already-running orchestrator prove whether server-side
# credentials are actually available.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
HARNESSES="${OMA_FEATURE_HARNESSES:-codex claude-agent-sdk}"
HARNESSES="${HARNESSES//,/ }"
POLL_INTERVAL_SEC="${OMA_FEATURE_POLL_INTERVAL_SEC:-2}"
MAX_POLL_SEC="${OMA_FEATURE_MAX_POLL_SEC:-360}"
HEALTH_MAX_SEC="${OMA_FEATURE_HEALTH_MAX_SEC:-90}"
REQUIRE="${OMA_FEATURE_REQUIRE:-0}"
TEST_CANCEL="${OMA_FEATURE_TEST_CANCEL:-0}"
CANCEL_DELAY_SEC="${OMA_FEATURE_CANCEL_DELAY_SEC:-1}"

CREATED_SESSIONS=()
CREATED_AGENTS=()
CREATED_AGENT_ID=""
CREATED_SESSION_ID=""
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/oma-feature-matrix.XXXXXX")"

say() { echo "[e2e-feature-matrix] $*"; }
die() { echo "[e2e-feature-matrix] FATAL: $*" >&2; exit 1; }

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

curl_json() {
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

curl_json_status() {
  local method="$1"
  local path="$2"
  local out="$3"
  shift 3
  if [[ -n "${OPENCLAW_API_TOKEN:-}" ]]; then
    curl --silent --show-error \
      -o "${out}" \
      -w "%{http_code}" \
      -X "${method}" \
      -H "Authorization: Bearer ${OPENCLAW_API_TOKEN}" \
      -H "Content-Type: application/json" \
      "${BASE_URL}${path}" \
      "$@"
  else
    curl --silent --show-error \
      -o "${out}" \
      -w "%{http_code}" \
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
    if last_error="$(curl_json GET /healthz 2>&1 >/dev/null)"; then
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

required_key_for_harness() {
  case "$1" in
    codex) echo "OPENAI_API_KEY" ;;
    claude-agent-sdk) echo "ANTHROPIC_API_KEY" ;;
    *) return 1 ;;
  esac
}

model_for_harness() {
  case "$1" in
    codex) echo "${OMA_FEATURE_CODEX_MODEL:-openai/gpt-5.5}" ;;
    claude-agent-sdk) echo "${OMA_FEATURE_CLAUDE_AGENT_SDK_MODEL:-anthropic/claude-sonnet-4-6}" ;;
    *) return 1 ;;
  esac
}

safe_harness_name() {
  echo "${1//-/_}"
}

cap_support() {
  local catalog="$1"
  local harness="$2"
  local capability="$3"
  echo "${catalog}" | jq -r \
    --arg h "${harness}" \
    --arg c "${capability}" \
    '.harnesses[]? | select(.harness_id == $h) | .capabilities[$c].support // "missing"'
}

assert_harness_registered() {
  local catalog="$1"
  local harness="$2"
  echo "${catalog}" \
    | jq -e --arg h "${harness}" '.harnesses[]? | select(.harness_id == $h)' >/dev/null \
    || die "harness ${harness} is not registered by /v1/harnesses"
}

expect_capability_present() {
  local catalog="$1"
  local harness="$2"
  local capability="$3"
  local support
  support="$(cap_support "${catalog}" "${harness}" "${capability}")"
  case "${support}" in
    supported|partial|unsupported) return 0 ;;
    *) die "${harness}: capability ${capability} missing from /v1/harnesses" ;;
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
    session_json="$(curl_json GET "/v1/sessions/${session_id}")"
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

create_basic_agent() {
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
  response="$(curl_json POST /v1/agents -d "${body}")"
  agent_id="$(echo "${response}" | jq -r '.agent_id')"
  [[ -n "${agent_id}" && "${agent_id}" != "null" ]] \
    || die "failed to create ${harness} agent: ${response}"
  [[ "$(echo "${response}" | jq -r '.harness_id')" == "${harness}" ]] \
    || die "created agent ${agent_id} has wrong harness: ${response}"
  CREATED_AGENTS+=("${agent_id}")
  CREATED_AGENT_ID="${agent_id}"
}

create_session() {
  local agent_id="$1"
  local response session_id
  response="$(curl_json POST /v1/sessions -d "{\"agentId\":\"${agent_id}\"}")"
  session_id="$(echo "${response}" | jq -r '.session_id')"
  [[ -n "${session_id}" && "${session_id}" != "null" ]] \
    || die "failed to create session for ${agent_id}: ${response}"
  [[ "$(echo "${response}" | jq -r '.agent_id')" == "${agent_id}" ]] \
    || die "created session ${session_id} has wrong agent: ${response}"
  [[ "$(echo "${response}" | jq -r '.status')" == "idle" ]] \
    || die "created session ${session_id} should start idle: ${response}"
  [[ "$(echo "${response}" | jq -r '.turns')" == "0" ]] \
    || die "created session ${session_id} should start at turns=0: ${response}"
  CREATED_SESSIONS+=("${session_id}")
  CREATED_SESSION_ID="${session_id}"
}

post_turn_and_wait() {
  local session_id="$1"
  local label="$2"
  local content="$3"
  local body
  body="$(jq -n --arg c "${content}" '{type: "user.message", content: $c}')"
  curl_json POST "/v1/sessions/${session_id}/events" -d "${body}" >/dev/null
  poll_session "${session_id}" "${label}" >/dev/null
}

latest_agent_message() {
  local session_id="$1"
  curl_json GET "/v1/sessions/${session_id}/events" \
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

assert_create_rejected() {
  local harness="$1"
  local capability="$2"
  local body="$3"
  local out status err cap
  out="${SCRATCH}/${harness}-${capability}-create.json"
  status="$(curl_json_status POST /v1/agents "${out}" -d "${body}")"
  err="$(jq -r '.error // ""' "${out}" 2>/dev/null || true)"
  cap="$(jq -r '.capability // ""' "${out}" 2>/dev/null || true)"
  [[ "${status}" == "400" ]] \
    || die "${harness}: expected create rejection for ${capability} to return 400, got ${status}: $(cat "${out}")"
  [[ "${err}" == "unsupported_harness_capability" ]] \
    || die "${harness}: expected unsupported_harness_capability, got ${err}: $(cat "${out}")"
  [[ "${cap}" == "${capability}" ]] \
    || die "${harness}: expected rejected capability ${capability}, got ${cap}: $(cat "${out}")"
  say "${harness}: PASS create rejects unsupported ${capability}"
}

run_static_rejection_checks() {
  local catalog="$1"
  local harness="$2"
  local model="$3"
  local support body

  support="$(cap_support "${catalog}" "${harness}" "mcp")"
  if [[ "${support}" == "unsupported" ]]; then
    body="$(jq -n \
      --arg harnessId "${harness}" \
      --arg model "${model}" \
      '{
        name: "feature-matrix-mcp-reject",
        harnessId: $harnessId,
        model: $model,
        tools: [],
        instructions: "",
        permissionPolicy: {type: "always_allow"},
        mcpServers: {docs: {command: "npx", args: ["-y", "@modelcontextprotocol/server-github"]}}
      }')"
    assert_create_rejected "${harness}" "mcp" "${body}"
  fi

  support="$(cap_support "${catalog}" "${harness}" "subagents")"
  if [[ "${support}" == "unsupported" ]]; then
    body="$(jq -n \
      --arg harnessId "${harness}" \
      --arg model "${model}" \
      '{
        name: "feature-matrix-subagent-reject",
        harnessId: $harnessId,
        model: $model,
        tools: [],
        instructions: "",
        permissionPolicy: {type: "always_allow"},
        callableAgents: ["agt_child"],
        maxSubagentDepth: 1
      }')"
    assert_create_rejected "${harness}" "subagents" "${body}"
  fi

  support="$(cap_support "${catalog}" "${harness}" "permission_deny")"
  if [[ "${support}" == "unsupported" ]]; then
    body="$(jq -n \
      --arg harnessId "${harness}" \
      --arg model "${model}" \
      '{
        name: "feature-matrix-deny-reject",
        harnessId: $harnessId,
        model: $model,
        tools: [],
        instructions: "",
        permissionPolicy: {type: "deny", tools: ["bash"]}
      }')"
    assert_create_rejected "${harness}" "permission_deny" "${body}"
  fi
}

run_approval_policy_check() {
  local catalog="$1"
  local harness="$2"
  local model="$3"
  local support body response agent_id policy

  support="$(cap_support "${catalog}" "${harness}" "tool_approvals")"
  body="$(jq -n \
    --arg harnessId "${harness}" \
    --arg model "${model}" \
    '{
      name: "feature-matrix-approval-policy",
      harnessId: $harnessId,
      model: $model,
      tools: [],
      instructions: "",
      permissionPolicy: {type: "always_ask"}
    }')"

  if [[ "${support}" == "unsupported" ]]; then
    assert_create_rejected "${harness}" "tool_approvals" "${body}"
    return
  fi

  response="$(curl_json POST /v1/agents -d "${body}")"
  agent_id="$(echo "${response}" | jq -r '.agent_id')"
  [[ -n "${agent_id}" && "${agent_id}" != "null" ]] \
    || die "${harness}: failed to create approval-policy agent: ${response}"
  CREATED_AGENTS+=("${agent_id}")
  policy="$(echo "${response}" | jq -r '.permission_policy.type')"
  [[ "${policy}" == "always_ask" ]] \
    || die "${harness}: approval-policy agent returned wrong policy: ${response}"
  say "${harness}: PASS approval policy accepted for ${support} tool_approvals"
}

run_session_lifecycle_check() {
  local harness="$1"
  local model="$2"
  local safe_harness run_id agent_id session_id marker1 marker2 session_json events_json status

  safe_harness="$(safe_harness_name "${harness}")"
  run_id="$(date +%s)"
  marker1="OMA_FEATURE_LIFECYCLE_${safe_harness}_MEMORY_${run_id}"
  marker2="OMA_FEATURE_LIFECYCLE_${safe_harness}_RECALL_${run_id}"

  create_basic_agent \
    "${harness}" \
    "${model}" \
    "feature-${harness}-lifecycle" \
    "You are a live lifecycle test agent. Follow exact-output instructions."
  agent_id="${CREATED_AGENT_ID}"
  create_session "${agent_id}"
  session_id="${CREATED_SESSION_ID}"

  session_json="$(curl_json GET "/v1/sessions/${session_id}")"
  [[ "$(echo "${session_json}" | jq -r '.harness_id')" == "${harness}" ]] \
    || die "${harness}: session get returned wrong harness: ${session_json}"
  curl_json GET /v1/sessions \
    | jq -e --arg sid "${session_id}" '.sessions[]? | select(.session_id == $sid)' >/dev/null \
    || die "${harness}: created session ${session_id} missing from list"
  say "${harness}: PASS session create/get/list lifecycle"

  post_turn_and_wait \
    "${session_id}" \
    "${harness}:lifecycle-turn1" \
    "Remember this token: ${marker1}. Reply with exactly OMA_FEATURE_LIFECYCLE_${safe_harness}_ACK_${run_id} and no other text."
  assert_contains \
    "${harness}: lifecycle turn1" \
    "$(latest_agent_message "${session_id}")" \
    "OMA_FEATURE_LIFECYCLE_${safe_harness}_ACK_${run_id}"

  post_turn_and_wait \
    "${session_id}" \
    "${harness}:lifecycle-turn2" \
    "Reply with exactly ${marker2} ${marker1} and no other text."
  assert_contains \
    "${harness}: lifecycle turn2" \
    "$(latest_agent_message "${session_id}")" \
    "${marker2} ${marker1}"

  session_json="$(curl_json GET "/v1/sessions/${session_id}")"
  [[ "$(echo "${session_json}" | jq -r '.status')" == "idle" ]] \
    || die "${harness}: lifecycle session should be idle after two turns: ${session_json}"
  [[ "$(echo "${session_json}" | jq -r '.turns')" == "2" ]] \
    || die "${harness}: lifecycle session should have turns=2: ${session_json}"
  assert_contains "${harness}: lifecycle output" "$(echo "${session_json}" | jq -r '.output // ""')" "${marker2}"

  events_json="$(curl_json GET "/v1/sessions/${session_id}/events")"
  [[ "$(echo "${events_json}" | jq '[.events[] | select(.type=="user.message")] | length')" == "2" ]] \
    || die "${harness}: lifecycle events should include two user messages: ${events_json}"
  [[ "$(echo "${events_json}" | jq '[.events[] | select(.type=="agent.message")] | length')" == "2" ]] \
    || die "${harness}: lifecycle events should include two agent messages: ${events_json}"
  say "${harness}: PASS two-turn managed session resume"

  status="$(curl_json_status DELETE "/v1/sessions/${session_id}" "${SCRATCH}/${harness}-delete-session.json")"
  [[ "${status}" == "200" ]] \
    || die "${harness}: expected delete session HTTP 200, got ${status}: $(cat "${SCRATCH}/${harness}-delete-session.json")"
  status="$(curl_json_status GET "/v1/sessions/${session_id}" "${SCRATCH}/${harness}-get-deleted-session.json")"
  [[ "${status}" == "404" ]] \
    || die "${harness}: expected deleted session GET HTTP 404, got ${status}: $(cat "${SCRATCH}/${harness}-get-deleted-session.json")"
  say "${harness}: PASS session delete lifecycle"
}

extract_stream_text() {
  local out="$1"
  grep '^data: ' "${out}" \
    | sed 's/^data: //' \
    | grep -v '^\[DONE\]$' \
    | while IFS= read -r json; do
        echo "${json}" | jq -r '.choices[0].delta.content // .choices[0].message.content // ""' 2>/dev/null || true
      done \
    | tr -d '\n'
}

run_streaming_check() {
  local harness="$1"
  local agent_id="$2"
  local marker="$3"
  local session_key="oma_feature_stream_$(safe_harness_name "${harness}")_${marker##*_}"
  local out="${SCRATCH}/${harness}-stream.sse"
  local body status text

  body="$(jq -n \
    --arg marker "${marker}" \
    '{
      stream: true,
      messages: [{
        role: "user",
        content: ("Reply with exactly this token and no other text: " + $marker)
      }]
    }')"

  if [[ -n "${OPENCLAW_API_TOKEN:-}" ]]; then
    status="$(curl --silent --show-error \
      -o "${out}" \
      -w "%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${OPENCLAW_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "x-openclaw-agent-id: ${agent_id}" \
      -H "x-openclaw-session-key: ${session_key}" \
      "${BASE_URL}/v1/chat/completions" \
      -d "${body}")"
  else
    status="$(curl --silent --show-error \
      -o "${out}" \
      -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "x-openclaw-agent-id: ${agent_id}" \
      -H "x-openclaw-session-key: ${session_key}" \
      "${BASE_URL}/v1/chat/completions" \
      -d "${body}")"
  fi
  CREATED_SESSIONS+=("${session_key}")
  [[ "${status}" == "200" ]] \
    || die "${harness}: stream=true returned HTTP ${status}: $(cat "${out}")"
  grep -q '^data: \[DONE\]$' "${out}" \
    || die "${harness}: stream=true output missing [DONE]"
  text="$(extract_stream_text "${out}")"
  assert_contains "${harness}: stream text" "${text}" "${marker}"
  say "${harness}: PASS chat.completions stream=true"
}

run_compaction_check() {
  local catalog="$1"
  local harness="$2"
  local model="$3"
  local support
  support="$(cap_support "${catalog}" "${harness}" "compaction")"

  if [[ "${support}" == "unsupported" ]]; then
    local agent_id session_id out status err
    create_basic_agent "${harness}" "${model}" "feature-${harness}-compact-reject" ""
    agent_id="${CREATED_AGENT_ID}"
    create_session "${agent_id}"
    session_id="${CREATED_SESSION_ID}"
    out="${SCRATCH}/${harness}-compact-reject.json"
    status="$(curl_json_status POST "/v1/sessions/${session_id}/compact" "${out}" -d '{}')"
    err="$(jq -r '.error // ""' "${out}" 2>/dev/null || true)"
    [[ "${status}" == "400" ]] \
      || die "${harness}: expected unsupported compaction HTTP 400, got ${status}: $(cat "${out}")"
    [[ "${err}" == "unsupported_capability" ]] \
      || die "${harness}: expected unsupported_capability for compaction, got ${err}: $(cat "${out}")"
    say "${harness}: PASS compact rejects unsupported capability"
    return
  fi

  if [[ "${support}" == "supported" || "${support}" == "partial" ]]; then
    local agent_id session_id marker out status err
    marker="OMA_FEATURE_COMPACT_$(safe_harness_name "${harness}")_$(date +%s)"
    create_basic_agent "${harness}" "${model}" "feature-${harness}-compact" "Follow exact-output instructions."
    agent_id="${CREATED_AGENT_ID}"
    create_session "${agent_id}"
    session_id="${CREATED_SESSION_ID}"
    post_turn_and_wait \
      "${session_id}" \
      "${harness}:compact-prep" \
      "Reply with exactly this token and no other text: ${marker}"
    assert_contains \
      "${harness}: compact prep" \
      "$(latest_agent_message "${session_id}")" \
      "${marker}"
    out="${SCRATCH}/${harness}-compact.json"
    status="$(curl_json_status POST "/v1/sessions/${session_id}/compact" "${out}" -d '{}')"
    err="$(jq -r '.error // ""' "${out}" 2>/dev/null || true)"
    [[ "${status}" == "200" ]] \
      || die "${harness}: expected compaction HTTP 200, got ${status}/${err}: $(cat "${out}")"
    say "${harness}: PASS compact accepted"
  fi
}

run_cancel_check() {
  local harness="$1"
  local model="$2"
  local support="$3"
  if [[ "${TEST_CANCEL}" != "1" ]]; then
    say "${harness}: skip cancel live check (set OMA_FEATURE_TEST_CANCEL=1)"
    return
  fi
  if [[ "${support}" == "unsupported" ]]; then
    say "${harness}: skip cancel live check; capability unsupported"
    return
  fi

  local agent_id session_id body out status err session_status
  create_basic_agent "${harness}" "${model}" "feature-${harness}-cancel" "Follow exact-output instructions."
  agent_id="${CREATED_AGENT_ID}"
  create_session "${agent_id}"
  session_id="${CREATED_SESSION_ID}"
  body="$(jq -n '{type: "user.message", content: "Write a long numbered list from 1 to 2000. Do not summarize."}')"
  curl_json POST "/v1/sessions/${session_id}/events" -d "${body}" >/dev/null
  sleep "${CANCEL_DELAY_SEC}"
  out="${SCRATCH}/${harness}-cancel.json"
  status="$(curl_json_status POST "/v1/sessions/${session_id}/cancel" "${out}" -d '{}')"
  if [[ "${status}" == "200" ]]; then
    say "${harness}: PASS cancel accepted"
    return
  fi
  err="$(jq -r '.error // ""' "${out}" 2>/dev/null || true)"
  if [[ "${status}" == "409" && "${err}" == "session_not_running" ]]; then
    session_status="$(curl_json GET "/v1/sessions/${session_id}" | jq -r '.status')"
    [[ "${session_status}" == "idle" ]] \
      || die "${harness}: cancel raced with completion but session is ${session_status}"
    say "${harness}: cancel raced with fast completion; session reusable"
    return
  fi
  die "${harness}: cancel returned unexpected HTTP ${status}/${err}: $(cat "${out}")"
}

run_harness_matrix() {
  local catalog="$1"
  local harness="$2"
  local model="$3"
  local safe_harness run_id agent_id marker support
  safe_harness="$(safe_harness_name "${harness}")"
  run_id="$(date +%s)"

  say "${harness}: checking catalog capabilities"
  for cap in \
    start_turn \
    streaming \
    native_session_resume \
    cancellation \
    dynamic_model_patch \
    compaction \
    tool_approvals \
    permission_deny \
    mcp \
    managed_event_log \
    usage \
    subagents
  do
    expect_capability_present "${catalog}" "${harness}" "${cap}"
  done

  run_static_rejection_checks "${catalog}" "${harness}" "${model}"
  run_approval_policy_check "${catalog}" "${harness}" "${model}"
  run_session_lifecycle_check "${harness}" "${model}"

  create_basic_agent \
    "${harness}" \
    "${model}" \
    "feature-${harness}-stream" \
    "You are a live feature-matrix agent. Follow exact-output instructions."
  agent_id="${CREATED_AGENT_ID}"

  support="$(cap_support "${catalog}" "${harness}" "streaming")"
  if [[ "${support}" == "supported" || "${support}" == "partial" ]]; then
    marker="OMA_FEATURE_STREAM_${safe_harness}_${run_id}"
    run_streaming_check "${harness}" "${agent_id}" "${marker}"
  else
    say "${harness}: skip streaming live check; capability unsupported"
  fi

  run_compaction_check "${catalog}" "${harness}" "${model}"
  support="$(cap_support "${catalog}" "${harness}" "cancellation")"
  run_cancel_check "${harness}" "${model}" "${support}"

  say "${harness}: PASS feature matrix"
}

RUNNABLE=()
for harness in ${HARNESSES}; do
  key_var="$(required_key_for_harness "${harness}")" \
    || die "unknown live harness ${harness}; expected codex or claude-agent-sdk"
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

CATALOG="$(curl_json GET /v1/harnesses)"
for harness in "${RUNNABLE[@]}"; do
  assert_harness_registered "${CATALOG}" "${harness}"
done

for harness in "${RUNNABLE[@]}"; do
  run_harness_matrix "${CATALOG}" "${harness}" "$(model_for_harness "${harness}")"
done

say "SUCCESS: live feature matrix passed for ${RUNNABLE[*]}"
