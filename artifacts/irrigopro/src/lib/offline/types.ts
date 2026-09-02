// Slice 4B — Offline mutation queue types.
//
// A QueuedMutation captures a deferred API call. The `clientId` on the body
// is mirrored at the top level so we can index on it; `parentClientId`
// captures the topological dependency on another queued mutation. The
// engine refuses to dispatch a mutation until its parent's `status ===
// "completed"` so server-assigned ids can be substituted into the body.

export type QueuedMutationStatus = "pending" | "syncing" | "failed" | "completed";

export type QueuedMutationKind =
  | "wet_check.create"
  | "wet_check.update"
  | "wet_check.submit"
  | "zone_record.upsert"
  | "zone_record.update"
  | "finding.create"
  | "finding.update"
  | "finding.delete"
  | "photo.link"
  | "photo.upload"
  | "photo.delete"
  | "work_order.location_patch"
  | "work_order.complete";

export interface WorkOrderLocationPatchPayload {
  workLocationLat: number | null;
  workLocationLng: number | null;
  workLocationAddress: string | null;
  controllerLetter?: string | null;
  zoneNumber?: number | null;
  fieldWorkType?: string | null;
  fieldWorkTypeDetails?: string | null;
  workLocationSource?: "gps" | "manual" | null;
  workLocationAccuracyM?: number | null;
  workLocationGpsError?: string | null;
}

export interface WorkOrderCompletionPayload {
  workOrderId: number;
  workSummary: string;
  customerNotes: string;
  completedAt: string;
  laborMode: "flat" | "per_part";
  totalHours: number;
  usedParts: unknown[];
  photos: string[];
  totalPartsCost: string;
  branchName?: string;
}

export interface QueuedMutation {
  id: string; // local UUID
  kind: QueuedMutationKind;
  method: "POST" | "PATCH" | "DELETE";
  // URL is rendered at dispatch time by the engine so server-assigned ids
  // (resolved via parent's clientId → id map) can be substituted.
  urlTemplate: string;
  // Body, including its own clientId. Engine substitutes any `{{...}}`
  // placeholders pointing to a parent mutation's resolved id.
  body: unknown;
  /** Server id for work-order mutations, used for actionable sync errors. */
  workOrderId?: number;
  clientId: string;
  parentClientId: string | null;
  // Optional additional dependencies. The engine will not dispatch this
  // mutation until every clientId listed here has a "completed" mutation
  // in the queue. Used by `wet_check.submit` to depend on every
  // outstanding zone-record / finding mutation for the same wet check, so
  // that submit cannot run while any descendant is still in flight or
  // backing off.
  parentClientIds?: string[];
  // Ordering-only dependencies release after terminal failure/cancellation;
  // the dependent request then receives its own actionable server response.
  orderingDependencies?: boolean;
  // For URL placeholders: a list of clientIds whose server-assigned ids the
  // engine must resolve and patch into urlTemplate / body before dispatch.
  // Each entry maps a placeholder name → the clientId that produces it.
  placeholders: Record<string, string>;
  attemptCount: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  status: QueuedMutationStatus;
  createdAt: number;
  // After a successful POST that creates a server row, we capture the
  // server-assigned id so dependents can substitute it.
  resolvedId: number | null;
  // 0–100, observable in the queue. Currently used by `photo.upload` to
  // surface sign → PUT → finalize → POST progress in coarse buckets so
  // a future UI can show a per-photo bar without us having to poll the
  // engine for state. Optional; absent on text-only mutations.
  progress?: number;
}

export interface ConflictEvent {
  type: "conflict";
  mutationId: string;
  kind: QueuedMutationKind;
  wetCheckId: number | null;
  message: string;
}
export interface ErrorEvent {
  type: "error";
  mutationId: string;
  kind: QueuedMutationKind;
  status: number | null;
  message: string;
  workOrderId?: number;
}
export interface SyncStateEvent {
  type: "state";
  online: boolean;
  pending: number;
  syncing: number;
  failed: number;
}
export type EngineEvent = ConflictEvent | ErrorEvent | SyncStateEvent;

export type EngineListener = (e: EngineEvent) => void;
