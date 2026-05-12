import type { AgentConfig } from "../orchestrator/types.js";
import type { VaultStore } from "../store/types.js";

export function injectMcpVaultCredentials(
  agentMcpServers: AgentConfig["mcpServers"],
  vaults: Pick<VaultStore, "listCredentials"> | undefined,
  vaultId: string | null | undefined,
): AgentConfig["mcpServers"] {
  if (!vaultId) return agentMcpServers;
  if (!agentMcpServers || Object.keys(agentMcpServers).length === 0) {
    return agentMcpServers;
  }
  if (!vaults) {
    throw new Error(
      "MCP vault credential injection requires a vault store",
    );
  }
  const creds = vaults.listCredentials(vaultId);
  if (creds.length === 0) return agentMcpServers;
  const out: AgentConfig["mcpServers"] = {};
  for (const [name, server] of Object.entries(agentMcpServers)) {
    const url = typeof server.url === "string" ? server.url : undefined;
    if (!url) {
      out[name] = server;
      continue;
    }
    const match = creds
      .filter((c) => url.startsWith(c.matchUrl))
      .sort((a, b) => b.matchUrl.length - a.matchUrl.length)[0];
    if (!match) {
      out[name] = server;
      continue;
    }
    const bearer = match.type === "mcp_oauth" ? match.accessToken : match.token;
    const existingHeaders = server.headers ?? {};
    out[name] = {
      ...server,
      headers: {
        ...existingHeaders,
        Authorization: `Bearer ${bearer}`,
      },
    };
  }
  return out;
}
