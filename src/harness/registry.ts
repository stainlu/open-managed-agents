import { DEFAULT_HARNESS_ID, type HarnessId } from "./ids.js";
import type { HarnessAdapter } from "./types.js";

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();
  readonly defaultId: HarnessId;

  constructor(args: { adapters: Iterable<HarnessAdapter>; defaultId?: HarnessId }) {
    this.defaultId = args.defaultId ?? DEFAULT_HARNESS_ID;
    for (const adapter of args.adapters) {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`duplicate harness adapter: ${adapter.id}`);
      }
      this.adapters.set(adapter.id, adapter);
    }
    if (!this.adapters.has(this.defaultId)) {
      throw new Error(`default harness adapter is not registered: ${this.defaultId}`);
    }
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): HarnessAdapter {
    const adapter = this.get(id);
    if (!adapter) {
      throw new Error(`harness adapter is not registered: ${id}`);
    }
    return adapter;
  }

  list(): HarnessAdapter[] {
    return [...this.adapters.values()];
  }
}
