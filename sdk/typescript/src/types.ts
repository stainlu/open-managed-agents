export interface Agent {
  agent_id: string;
  harness_id: HarnessId;
  model: string;
  tools: string[];
  instructions: string;
  permission_policy: PermissionPolicy;
  version: number;
  created_at: number;
  updated_at: number;
  name?: string | null;
  callable_agents: string[];
  max_subagent_depth: number;
  mcp_servers: McpServers;
  quota?: Quota | null;
  thinking_level: ThinkingLevel;
  channels: Channels;
  archived_at?: number | null;
}

export type PermissionPolicy =
  | { type: "always_allow" }
  | { type: "deny"; tools: string[] }
  | { type: "always_ask"; tools?: string[] };

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";

export type HarnessId = "openclaw" | "hermes" | "codex" | "claude-agent-sdk" | (string & {});

export type HarnessCapabilitySupport = "supported" | "partial" | "unsupported";

export interface HarnessCapability {
  support: HarnessCapabilitySupport;
  detail: string;
}

export interface HarnessCapabilities {
  start_turn: HarnessCapability;
  streaming: HarnessCapability;
  native_session_resume: HarnessCapability;
  cancellation: HarnessCapability;
  interruption: HarnessCapability;
  dynamic_model_patch: HarnessCapability;
  compaction: HarnessCapability;
  tool_approvals: HarnessCapability;
  permission_deny: HarnessCapability;
  mcp: HarnessCapability;
  managed_event_log: HarnessCapability;
  usage: HarnessCapability;
  subagents: HarnessCapability;
}

export interface Harness {
  harness_id: HarnessId;
  name: string;
  capabilities: HarnessCapabilities;
}

export interface HarnessCatalog {
  default_harness_id: HarnessId;
  harnesses: Harness[];
  count: number;
}

export interface AuditEvent {
  id: number;
  ts: number;
  request_id?: string | null;
  actor: string;
  action: string;
  target?: string | null;
  outcome: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEventList {
  events: AuditEvent[];
  count: number;
}

export interface Quota {
  maxCostUsdPerSession?: number;
  maxTokensPerSession?: number;
  maxWallDurationMs?: number;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string | number | boolean>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export type McpServers = Record<string, McpServerConfig>;

export interface Channels {
  telegram?: { enabled?: boolean };
}

export interface Environment {
  environment_id: string;
  name: string;
  description?: string;
  networking: EnvironmentNetworking;
  created_at: number;
  packages?: EnvironmentPackages | null;
}

export type EnvironmentNetworking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowedHosts: string[];
      allowMcpServers?: boolean;
      allowPackageManagers?: boolean;
    };

export interface EnvironmentPackages {
  pip?: string[];
  apt?: string[];
  npm?: string[];
  cargo?: string[];
  gem?: string[];
  go?: string[];
}

export interface Session {
  session_id: string;
  agent_id: string;
  harness_id: HarnessId;
  status: "idle" | "starting" | "running" | "failed";
  tokens: { input: number; output: number };
  cost_usd: number;
  created_at: number;
  output?: string | null;
  environment_id?: string | null;
  error?: string | null;
  last_event_at?: number | null;
  turns?: number;
  boot_ms?: number | null;
  pool_source?: "active" | "warm" | "fresh" | "adopted" | string | null;
  container_id?: string | null;
  container_name?: string | null;
  parent_session_id?: string | null;
}

export interface Event {
  event_id: string;
  session_id: string;
  type: string;
  content: string;
  created_at: number;
  tokens?: { input: number; output: number } | null;
  cost_usd?: number | null;
  model?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_arguments?: Record<string, unknown> | null;
  is_error?: boolean | null;
  approval_id?: string | null;
  run_id?: string | null;
  run_kind?: string | null;
  run_status?: string | null;
  parent_run_id?: string | null;
  event_index?: number | null;
}

export interface Approval {
  approval_id: string;
  session_id: string;
  tool_name: string;
  tool_call_id?: string | null;
  description: string;
  arrived_at: number;
}

export type ManagedRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ManagedRun {
  run_id: string;
  session_id: string;
  agent_id: string;
  status: ManagedRunStatus;
  queued: boolean;
  model?: string | null;
  thinking_level?: ThinkingLevel | null;
  error?: string | null;
  created_at: number;
  started_at?: number | null;
  completed_at?: number | null;
}

export interface RunTreeSource {
  managed_run: boolean;
  event_log: boolean;
}

export interface RunTreeNode {
  run_id: string;
  parent_run_id?: string | null;
  run_kind?: string | null;
  status?: string | null;
  managed_status?: string | null;
  queued?: boolean | null;
  created_at?: number | null;
  started_at?: number | null;
  completed_at?: number | null;
  first_event_at?: number | null;
  last_event_at?: number | null;
  event_count: number;
  tokens?: { input: number; output: number } | null;
  cost_usd?: number | null;
  model?: string | null;
  is_error?: boolean | null;
  source: RunTreeSource;
  children: RunTreeNode[];
}

export interface RunTree {
  session_id: string;
  count: number;
  runs: RunTreeNode[];
}

export interface SendEventResult {
  session_id: string;
  status: string;
  queued?: boolean;
}

export interface ResolveApprovalResult {
  session_id: string;
  approval_id: string;
  decision: "allow" | "deny";
  resolved: true;
}

export interface AbortRunResult {
  session_id: string;
  session_status: Session["status"];
  run: ManagedRun;
  aborted: boolean;
  removed_queued: boolean;
}

export interface CancelResult {
  session_id: string;
  session_status: Session["status"];
  cancelled: true;
}

export interface CompactResult {
  session_id: string;
  session_status: Session["status"];
  compacted: true;
}

export interface RunAgentResult {
  session_id: string;
  agent_id: string;
  status: Session["status"];
  started_at: number;
}

export interface WarmAgentResult {
  agent_id: string;
  queued: true;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
}

export interface WorkspaceFileList {
  agent_id: string;
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFileWriteResult {
  agent_id: string;
  path: string;
  size: number;
}

export interface WorkspaceFileDeleteResult {
  agent_id: string;
  path: string;
  deleted: true;
}

export interface Vault {
  vault_id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export type VaultCredential = StaticBearerCredential | McpOAuthCredential;

export interface StaticBearerCredential {
  credential_id: string;
  vault_id: string;
  name: string;
  type: "static_bearer";
  match_url: string;
  created_at: number;
  updated_at: number;
}

export interface McpOAuthCredential {
  credential_id: string;
  vault_id: string;
  name: string;
  type: "mcp_oauth";
  match_url: string;
  token_endpoint: string;
  client_id: string;
  scopes?: string[];
  expires_at: number;
  created_at: number;
  updated_at: number;
}
