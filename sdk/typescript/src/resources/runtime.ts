import type { HttpClient } from "../http.js";
import type { RuntimeProfile } from "../types.js";

export class Runtime {
  constructor(private readonly http: HttpClient) {}

  profile(): Promise<RuntimeProfile> {
    return this.http.request<RuntimeProfile>("GET", "/v1/runtime");
  }
}
