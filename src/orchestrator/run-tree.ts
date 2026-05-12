import type { ManagedRun } from "../store/types.js";
import type { Event } from "./types.js";

export type RunTreeSource = {
  managedRun: boolean;
  eventLog: boolean;
};

export type RunTreeNode = {
  runId: string;
  parentRunId?: string;
  runKind?: string;
  status?: string;
  managedStatus?: ManagedRun["status"];
  queued?: boolean;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  firstEventAt?: number;
  lastEventAt?: number;
  eventCount: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  model?: string;
  isError?: boolean;
  source: RunTreeSource;
  children: RunTreeNode[];
};

type MutableRunTreeNode = Omit<RunTreeNode, "children"> & {
  order: number;
  children: MutableRunTreeNode[];
};

export function buildRunTree(
  events: Event[],
  managedRuns: ManagedRun[] = [],
): RunTreeNode[] {
  const nodes = new Map<string, MutableRunTreeNode>();
  let order = 0;

  const nodeFor = (runId: string): MutableRunTreeNode => {
    const existing = nodes.get(runId);
    if (existing) return existing;
    const node: MutableRunTreeNode = {
      runId,
      eventCount: 0,
      source: { managedRun: false, eventLog: false },
      children: [],
      order: order++,
    };
    nodes.set(runId, node);
    return node;
  };

  for (const run of managedRuns) {
    const node = nodeFor(run.runId);
    node.source.managedRun = true;
    node.managedStatus = run.status;
    node.queued = run.queued;
    node.status ??= run.status;
    node.createdAt = minDefined(node.createdAt, run.createdAt);
    if (run.startedAt !== null) node.startedAt = minDefined(node.startedAt, run.startedAt);
    if (run.completedAt !== null) {
      node.completedAt = maxDefined(node.completedAt, run.completedAt);
    }
    if (run.model !== undefined) node.model = run.model;
  }

  for (const event of events) {
    if (!event.runId) continue;
    const node = nodeFor(event.runId);
    node.source.eventLog = true;
    node.eventCount += 1;
    node.firstEventAt = minDefined(node.firstEventAt, event.createdAt);
    node.lastEventAt = maxDefined(node.lastEventAt, event.createdAt);
    if (event.parentRunId && event.parentRunId !== node.runId) {
      node.parentRunId ??= event.parentRunId;
      nodeFor(event.parentRunId);
    }
    if (event.runKind) node.runKind ??= event.runKind;
    if (event.model) node.model = event.model;
    if (event.isError) node.isError = true;
    if (event.tokensIn !== undefined) {
      node.tokensIn = (node.tokensIn ?? 0) + event.tokensIn;
    }
    if (event.tokensOut !== undefined) {
      node.tokensOut = (node.tokensOut ?? 0) + event.tokensOut;
    }
    if (event.costUsd !== undefined) {
      node.costUsd = (node.costUsd ?? 0) + event.costUsd;
    }

    if (event.type === "session.run_start") {
      node.startedAt = minDefined(node.startedAt, event.createdAt);
    } else if (event.type === "session.run_end") {
      node.completedAt = maxDefined(node.completedAt, event.createdAt);
      node.status = event.runStatus ?? (event.isError ? "failed" : "completed");
    }
  }

  for (const node of nodes.values()) node.children = [];
  const roots: MutableRunTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentRunId ? nodes.get(node.parentRunId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortNodes(roots);
  return roots.map(freezeNode);
}

function sortNodes(nodes: MutableRunTreeNode[]): void {
  nodes.sort(compareNodes);
  for (const node of nodes) sortNodes(node.children);
}

function compareNodes(a: MutableRunTreeNode, b: MutableRunTreeNode): number {
  return nodeSortTime(a) - nodeSortTime(b) || a.order - b.order;
}

function nodeSortTime(node: MutableRunTreeNode): number {
  return node.startedAt ?? node.firstEventAt ?? node.createdAt ?? Number.MAX_SAFE_INTEGER;
}

function freezeNode(node: MutableRunTreeNode): RunTreeNode {
  const { order: _order, ...rest } = node;
  return {
    ...rest,
    children: node.children.map(freezeNode),
  };
}

function minDefined(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.min(current, next);
}

function maxDefined(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next);
}
