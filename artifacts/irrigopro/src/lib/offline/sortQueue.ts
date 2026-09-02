// Slice 4B — Pure sort + backoff helpers.
//
// Pulled into their own file so unit tests can exercise them without
// involving fake-indexeddb or a mocked fetch. The engine consumes them.

import type { QueuedMutation } from "./types";

// Backoff schedule from the spec: 1s → 2s → 4s → 8s → 30s cap. `attemptCount`
// is the count *before* the next attempt. After the first failure
// (attemptCount becomes 1), the next attempt waits 1s; after the second
// failure (attemptCount=2), 2s; and so on. Capped at 30s.
export function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  const base = 1000 * Math.pow(2, attemptCount - 1);
  return Math.min(base, 30_000);
}

// Decide whether a mutation is ready to dispatch given the current set of
// queue entries. A mutation is ready iff:
//   - status === "pending"
//   - parentClientId is null OR the parent mutation is "completed"
//   - all placeholder dependencies (referenced clientIds) are completed
//   - now >= lastAttemptAt + backoff(attemptCount)
//
// The output is sorted by createdAt ascending so the engine can take the
// first N up to its concurrency cap.
export function readySet(
  queue: ReadonlyArray<QueuedMutation>,
  now: number,
  resolveServerIdSync?: (clientId: string) => number | null,
): QueuedMutation[] {
  // A clientId can have multiple queued mutations (e.g. the user toggles a
  // zone status twice before going online); we must gate on ALL of them.
  const byClientId = new Map<string, QueuedMutation[]>();
  for (const m of queue) {
    const arr = byClientId.get(m.clientId);
    if (arr) arr.push(m); else byClientId.set(m.clientId, [m]);
  }
  const otherRows = (cid: string, self?: QueuedMutation): QueuedMutation[] => {
    const arr = byClientId.get(cid);
    if (!arr) return [];
    return self ? arr.filter((x) => x.id !== self.id) : arr;
  };

  // A "parent" clientId is satisfied iff every queued mutation for that
  // clientId (excluding the mutation we're checking) is completed. If
  // there are no queued mutations for it and a resolver is available, the
  // entity already exists on the server — also satisfied. When no resolver
  // is provided we conservatively treat absent-from-queue parents as
  // satisfied (no in-flight create can exist).
  const isParentSatisfied = (cid: string, self?: QueuedMutation): boolean => {
    const rows = otherRows(cid, self);
    if (rows.length > 0) {
      return rows.every((p) =>
        p.status === "completed" ||
        (self?.orderingDependencies === true && p.status === "failed")
      );
    }
    if (self?.orderingDependencies === true) return true;
    if (resolveServerIdSync) return resolveServerIdSync(cid) != null;
    return true;
  };
  // A "placeholder" reference is resolvable iff every queued mutation for
  // that clientId (excluding self) is completed AND at least one of them
  // has a server resolvedId, OR the mirror resolver can produce an id.
  const isPlaceholderResolved = (cid: string, self?: QueuedMutation): boolean => {
    const rows = otherRows(cid, self);
    if (rows.length > 0) {
      if (!rows.every((p) => p.status === "completed")) return false;
      if (rows.some((p) => p.resolvedId != null)) return true;
      if (resolveServerIdSync) return resolveServerIdSync(cid) != null;
      return false;
    }
    if (resolveServerIdSync) return resolveServerIdSync(cid) != null;
    return false;
  };

  const ready: QueuedMutation[] = [];
  for (const m of queue) {
    if (m.status !== "pending") continue;
    // Backoff gate.
    if (m.attemptCount > 0 && m.lastAttemptAt != null) {
      const wait = backoffMs(m.attemptCount);
      if (now < m.lastAttemptAt + wait) continue;
    }
    // Parent gate (single).
    if (m.parentClientId && !isParentSatisfied(m.parentClientId, m)) continue;
    // Multi-parent gate — used by wet_check.submit so it cannot dispatch
    // while any descendant zone-record / finding op is still in flight or
    // backing off.
    if (m.parentClientIds && m.parentClientIds.length > 0) {
      let mpBlocked = false;
      for (const cid of m.parentClientIds) {
        if (!isParentSatisfied(cid, m)) { mpBlocked = true; break; }
      }
      if (mpBlocked) continue;
    }
    // Placeholder gate.
    let blocked = false;
    for (const refClientId of Object.values(m.placeholders ?? {})) {
      if (!isPlaceholderResolved(refClientId, m)) { blocked = true; break; }
    }
    if (blocked) continue;
    ready.push(m);
  }
  ready.sort((a, b) => a.createdAt - b.createdAt);
  return ready;
}

// Substitute placeholder tokens in a URL or in a JSON-cloneable body.
// Tokens are spelled `{{name}}` and resolved via `placeholders[name] →
// clientId → resolvedId` from the supplied lookup. Throws if a placeholder
// can't be resolved (caller should have gated on readySet).
export function resolveTemplate(
  template: string,
  placeholders: Record<string, string>,
  resolveByClientId: (clientId: string) => number | null,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, name) => {
    const cid = placeholders[name];
    if (!cid) throw new Error(`Unknown placeholder: ${name}`);
    const id = resolveByClientId(cid);
    if (id == null) throw new Error(`Placeholder ${name} (${cid}) not yet resolved`);
    return String(id);
  });
}

export function resolveBody<T>(
  body: T,
  placeholders: Record<string, string>,
  resolveByClientId: (clientId: string) => number | null,
): T {
  if (body == null || typeof body !== "object") return body;
  const json = JSON.stringify(body);
  const replaced = json.replace(/"\{\{([a-zA-Z0-9_]+)\}\}"/g, (_, name) => {
    const cid = placeholders[name];
    if (!cid) throw new Error(`Unknown placeholder: ${name}`);
    const id = resolveByClientId(cid);
    if (id == null) throw new Error(`Placeholder ${name} (${cid}) not yet resolved`);
    return String(id);
  });
  return JSON.parse(replaced) as T;
}
