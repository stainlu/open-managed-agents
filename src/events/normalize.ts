import type { Event } from "../orchestrator/types.js";

export function normalizeManagedEventBatch(
  sessionId: string,
  events: Event[],
  opts: { seenEventIds?: Set<string> } = {},
): Event[] {
  const seen = opts.seenEventIds ?? new Set<string>();
  const normalized: Event[] = [];
  for (const event of events) {
    const eventId = stringValue(event.eventId);
    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);
    normalized.push({
      ...event,
      eventId,
      sessionId,
      content: eventContent(event.content),
      createdAt: normalizeCreatedAt(event.createdAt),
      tokensIn: normalizeOptionalNonnegativeInt(event.tokensIn),
      tokensOut: normalizeOptionalNonnegativeInt(event.tokensOut),
      costUsd: normalizeOptionalNonnegativeNumber(event.costUsd),
    });
  }
  return normalized;
}

export function mergeManagedEventsForSession(
  sessionId: string,
  events: Event[],
): Event[] {
  return orderManagedEvents(normalizeManagedEventBatch(sessionId, events));
}

export function orderManagedEvents(events: Event[]): Event[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.createdAt - b.event.createdAt || a.index - b.index)
    .map(({ event }) => event);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function eventContent(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeCreatedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return Math.max(0, Math.trunc(value));
}

function normalizeOptionalNonnegativeInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function normalizeOptionalNonnegativeNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}
