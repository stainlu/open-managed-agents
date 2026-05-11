export type ManagedRunRequest = {
  sessionId: string;
  agentId: string;
  content: string;
  model?: string;
  thinkingLevel?: string;
  queued: boolean;
};

export type ScheduleManagedRunArgs = {
  request: ManagedRunRequest;
  run: () => Promise<void>;
  onFailure: (error: unknown) => void;
};

export interface ManagedRunScheduler {
  schedule(args: ScheduleManagedRunArgs): void | Promise<void>;
}

export class InlineRunScheduler implements ManagedRunScheduler {
  schedule(args: ScheduleManagedRunArgs): void {
    void args.run().catch(args.onFailure);
  }
}
