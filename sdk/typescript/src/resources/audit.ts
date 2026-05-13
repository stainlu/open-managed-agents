import type { HttpClient } from "../http.js";
import type { AuditEvent, AuditEventList } from "../types.js";

export interface AuditListParams {
  since?: number;
  until?: number;
  action?: string;
  target?: string;
  limit?: number;
}

export class Audit {
  constructor(private readonly http: HttpClient) {}

  query(params: AuditListParams = {}): Promise<AuditEventList> {
    return this.http.request<AuditEventList>("GET", auditPath(params));
  }

  async list(params: AuditListParams = {}): Promise<AuditEvent[]> {
    const result = await this.query(params);
    return result.events;
  }
}

function auditPath(params: AuditListParams): string {
  const query = new URLSearchParams();
  if (params.since !== undefined) query.set("since", String(params.since));
  if (params.until !== undefined) query.set("until", String(params.until));
  if (params.action !== undefined) query.set("action", params.action);
  if (params.target !== undefined) query.set("target", params.target);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return suffix ? `/v1/audit?${suffix}` : "/v1/audit";
}
