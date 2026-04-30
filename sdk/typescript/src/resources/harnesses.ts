import type { HttpClient } from "../http.js";
import type { Harness, HarnessCatalog } from "../types.js";

export class Harnesses {
  constructor(private readonly http: HttpClient) {}

  catalog(): Promise<HarnessCatalog> {
    return this.http.request<HarnessCatalog>("GET", "/v1/harnesses");
  }

  async list(): Promise<Harness[]> {
    const catalog = await this.catalog();
    return catalog.harnesses;
  }
}
