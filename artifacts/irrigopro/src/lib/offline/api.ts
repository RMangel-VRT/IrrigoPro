// Slice 4B — Field-tech API wrapper.
//
// Thin layer around the wet check API that the wet-checks screens call
// instead of `apiRequest` directly. When the OFFLINE_QUEUE flag is on,
// writes go through the mutation queue with optimistic mirror updates;
// when off, calls fall through to `apiRequest`.
//
// Photos are intentionally NOT wrapped here — the spec keeps photos
// online-only in 4B with a "try when you're back online" message.

import { apiRequest } from "@/lib/queryClient";
import { preparePhotoForUpload } from "@/lib/photo-prep";
import {
  deleteFindingMirror,
  enqueueMutation,
  getApiCache,
  getWetCheckMirrorById,
  getWetCheckMirrorByClientId,
  listAllMutations,
  listFindingsForZoneRecord,
  listZoneRecordsForWetCheck,
  openOfflineDB,
  putApiCache,
  putFindingMirror,
  putPhotoBlob,
  putWetCheckMirror,
  putZoneRecordMirror,
  withDB,
  type OfflineDB,
} from "./db";
import { getSyncEngine, isOfflineQueueEnabled } from "./engine";
import type {
  QueuedMutation,
  QueuedMutationKind,
  WorkOrderCompletionPayload,
  WorkOrderLocationPatchPayload,
} from "./types";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof (crypto as any).getRandomValues === "function") (crypto as any).getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newMutation(partial: Omit<QueuedMutation, "id" | "attemptCount" | "lastAttemptAt" | "lastError" | "status" | "createdAt" | "resolvedId">): QueuedMutation {
  return {
    id: uuid(),
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
    createdAt: Date.now(),
    resolvedId: null,
    ...partial,
  };
}

// Photo-offline guard — exported so callers can show the spec's exact
// message when a tech tries to capture a photo with no network.
// Only surfaced when the 4C OFFLINE_PHOTOS flag is OFF; with the flag
// on, photos are queued through the mutation engine and this message is
// never shown.
export const PHOTO_OFFLINE_MESSAGE =
  "Photos require connectivity — try when you're back online.";

// 4C — feature flag. ON by default per spec; can be disabled at build
// time via `VITE_OFFLINE_PHOTOS=false` for incident rollback.
export function isOfflinePhotosEnabled(): boolean {
  if (!isOfflineQueueEnabled()) return false;
  try {
    const v = (import.meta as any).env?.VITE_OFFLINE_PHOTOS;
    if (v === false || v === "false" || v === "0") return false;
    return true;
  } catch {
    return true;
  }
}

// 4C — request persistent storage so the browser is much less likely to
// evict the queued photo Blobs under quota pressure. Idempotent and
// safe to call repeatedly (browsers cache the decision). Also returns
// a tight-quota signal so the caller can warn the tech proactively
// instead of failing silently when IDB rejects a put().
export interface PersistentStorageStatus {
  persisted: boolean;
  /** quota in bytes if known */
  quotaBytes?: number;
  /** usage in bytes if known */
  usageBytes?: number;
  /** true when free space < 50MB OR usage > 80% of quota */
  quotaTight: boolean;
}
export async function ensurePersistentStorage(): Promise<PersistentStorageStatus> {
  let persisted = false;
  let quotaBytes: number | undefined;
  let usageBytes: number | undefined;
  try {
    if (typeof navigator !== "undefined" && (navigator as any).storage?.persist) {
      // `persist()` returns whether the storage IS persisted after the
      // call — on Safari the prompt may be silently denied; we treat
      // anything other than `true` as best-effort.
      persisted = await (navigator as any).storage.persist();
    }
    if (typeof navigator !== "undefined" && (navigator as any).storage?.estimate) {
      const est = await (navigator as any).storage.estimate();
      quotaBytes = est.quota;
      usageBytes = est.usage;
    }
  } catch (err) {
    console.warn("[offline] ensurePersistentStorage failed", err);
  }
  const free = (quotaBytes ?? 0) - (usageBytes ?? 0);
  const ratioTight = quotaBytes ? (usageBytes ?? 0) / quotaBytes > 0.8 : false;
  const freeTight = quotaBytes ? free < 50 * 1024 * 1024 : false;
  return { persisted, quotaBytes, usageBytes, quotaTight: ratioTight || freeTight };
}

// IDB-first read for GET endpoints used during the wet-check capture
// flow (controllers, issue-type configs, parts-by-issue). Returns the
// cached payload immediately when present and refreshes from the
// network in the background; on cold-start offline the call rejects
// only if there is no cache to fall back on.
export async function cachedApiRequest<T = any>(url: string): Promise<T> {
  if (!isOfflineQueueEnabled()) return await apiRequest(url);
  const db = await openOfflineDB();
  const cached = await getApiCache(db, url);
  if (cached) {
    if (!isProbablyOffline()) {
      void apiRequest(url)
        .then(async (fresh) => { await putApiCache(db, url, fresh); })
        .catch(() => { /* heartbeat will mark offline */ });
    }
    return cached.data as T;
  }
  if (isProbablyOffline()) {
    throw new Error("Not cached locally — reconnect to load.");
  }
  const fresh = await apiRequest(url);
  try { await putApiCache(db, url, fresh); } catch {}
  return fresh as T;
}

export function isProbablyOffline(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.onLine === false;
}

// Work-order mutations intentionally use the queue only when the device is
// actually offline. This preserves the existing immediate online behavior,
// while keeping every offline location patch and completion durable.
export function shouldQueueWorkOrderMutation(): boolean {
  return isOfflineQueueEnabled() && isProbablyOffline();
}

const workOrderQueueTails = new Map<number, Promise<void>>();

async function withWorkOrderQueueLock<T>(
  workOrderId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = workOrderQueueTails.get(workOrderId) ?? Promise.resolve();
  const current = prior.then(operation, operation);
  const tail = current.then(() => undefined, () => undefined);
  workOrderQueueTails.set(workOrderId, tail);
  try {
    return await current;
  } finally {
    if (workOrderQueueTails.get(workOrderId) === tail) {
      workOrderQueueTails.delete(workOrderId);
    }
  }
}

function isTerminalClientError(error: unknown): boolean {
  return error instanceof Error && /^4\d\d:/.test(error.message);
}

async function outstandingWorkOrderLocationPatches(
  workOrderId: number,
): Promise<QueuedMutation[]> {
  return (await getSyncEngine().listMutations())
    .filter(
      (mutation) =>
        mutation.kind === "work_order.location_patch" &&
        mutation.workOrderId === workOrderId &&
        mutation.status !== "completed",
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function patchWorkOrderLocation(
  workOrderId: number,
  payload: WorkOrderLocationPatchPayload,
): Promise<{ queued: boolean }> {
  return await withWorkOrderQueueLock(workOrderId, async () => {
    const predecessors = await outstandingWorkOrderLocationPatches(workOrderId);
    const mustJoinQueue =
      predecessors.length > 0 || shouldQueueWorkOrderMutation();
    if (!mustJoinQueue) {
      try {
        await apiRequest(`/api/work-orders/${workOrderId}`, "PATCH", payload);
        return { queued: false };
      } catch (error) {
        if (!isOfflineQueueEnabled() || isTerminalClientError(error)) throw error;
        // navigator.onLine is often still true during Wi-Fi captive portals,
        // DNS failures, and server outages. Preserve the write durably after
        // the immediate request proves connectivity is unavailable.
        getSyncEngine().setOnline(false);
      }
    }

    await getSyncEngine().enqueue(newMutation({
      kind: "work_order.location_patch",
      method: "PATCH",
      urlTemplate: `/api/work-orders/${workOrderId}`,
      body: payload,
      clientId: uuid(),
      parentClientId: null,
      // Serialize successive pin changes so an older request cannot arrive
      // last and overwrite the technician's newest location.
      parentClientIds: predecessors.map((mutation) => mutation.clientId),
      orderingDependencies: true,
      placeholders: {},
      workOrderId,
    }));
    return { queued: true };
  });
}

export async function completeWorkOrder(
  payload: WorkOrderCompletionPayload,
): Promise<{ queued: boolean }> {
  return await withWorkOrderQueueLock(payload.workOrderId, async () => {
    const outstandingLocationPatches =
      await outstandingWorkOrderLocationPatches(payload.workOrderId);
    const mustJoinQueue =
      outstandingLocationPatches.length > 0 ||
      shouldQueueWorkOrderMutation();
    if (!mustJoinQueue) {
      try {
        await apiRequest("/api/work-orders/complete", "POST", payload);
        return { queued: false };
      } catch (error) {
        if (!isOfflineQueueEnabled() || isTerminalClientError(error)) throw error;
        getSyncEngine().setOnline(false);
      }
    }

    await getSyncEngine().enqueue(newMutation({
      kind: "work_order.complete",
      method: "POST",
      urlTemplate: "/api/work-orders/complete",
      body: payload,
      clientId: uuid(),
      parentClientId: null,
      parentClientIds: outstandingLocationPatches.map(
        (mutation) => mutation.clientId,
      ),
      orderingDependencies: true,
      placeholders: {},
      workOrderId: payload.workOrderId,
    }));
    return { queued: true };
  });
}

// --- Wet check create --------------------------------------------------

export interface CreateWetCheckInput {
  customerId: number;
  clientId?: string;
}

export async function createWetCheck(input: CreateWetCheckInput): Promise<{ id?: number; clientId: string; customerId: number; status: string }> {
  const clientId = input.clientId ?? uuid();
  if (!isOfflineQueueEnabled()) {
    return await apiRequest("/api/wet-checks", "POST", { customerId: input.customerId, clientId });
  }
  const db = await openOfflineDB();
  const optimistic = {
    clientId,
    id: undefined as number | undefined,
    customerId: input.customerId,
    status: "in_progress",
    zoneRecords: [],
    photos: [],
  };
  await putWetCheckMirror(db, {
    clientId,
    data: optimistic,
    status: "in_progress",
    updatedAt: Date.now(),
  });
  await getSyncEngine().enqueue(newMutation({
    kind: "wet_check.create",
    method: "POST",
    urlTemplate: "/api/wet-checks",
    body: { customerId: input.customerId, clientId },
    clientId,
    parentClientId: null,
    placeholders: {},
  }));
  return optimistic;
}

// --- Wet check submit --------------------------------------------------

// Find every queued mutation that belongs to a given wet check by walking
// the queue + mirrors. Used by submitWetCheck to enforce full topological
// dependency: submit must wait for the wet-check create AND every zone
// record / finding mutation for that wet check to complete first.
async function collectDescendantClientIds(db: OfflineDB, wetCheckClientId: string): Promise<string[]> {
  const all = await listAllMutations(db);
  const zoneRecords = await listZoneRecordsForWetCheck(db, wetCheckClientId);
  const zoneClientIds = new Set(zoneRecords.map((z) => z.clientId));
  // Also collect all findings whose zoneRecord belongs to this wet check.
  const findingClientIds = new Set<string>();
  for (const z of zoneRecords) {
    const fs = await listFindingsForZoneRecord(db, z.clientId);
    for (const f of fs) findingClientIds.add(f.clientId);
  }
  const deps = new Set<string>();
  // Always include the wet check create itself.
  deps.add(wetCheckClientId);
  for (const m of all) {
    if (m.status === "completed") continue;
    if (m.clientId === wetCheckClientId) { deps.add(m.clientId); continue; }
    if (zoneClientIds.has(m.clientId)) { deps.add(m.clientId); continue; }
    if (findingClientIds.has(m.clientId)) { deps.add(m.clientId); continue; }
    // finding.update / finding.delete carry parentClientId === finding clientId
    if (m.parentClientId && (zoneClientIds.has(m.parentClientId) || findingClientIds.has(m.parentClientId))) {
      deps.add(m.clientId);
    }
  }
  return Array.from(deps);
}

export async function submitWetCheck(wetCheckClientId: string, wetCheckId: number | undefined): Promise<{ queued: boolean }> {
  if (!isOfflineQueueEnabled() && wetCheckId != null) {
    await apiRequest(`/api/wet-checks/${wetCheckId}/submit`, "POST", {});
    return { queued: false };
  }
  const db = await openOfflineDB();
  const parentClientIds = await collectDescendantClientIds(db, wetCheckClientId);
  await getSyncEngine().enqueue(newMutation({
    kind: "wet_check.submit",
    method: "POST",
    urlTemplate: "/api/wet-checks/{{wc}}/submit",
    body: {},
    clientId: uuid(),
    parentClientId: wetCheckClientId,
    parentClientIds,
    placeholders: { wc: wetCheckClientId },
  }));
  return { queued: true };
}

// Compose the wet check + its zone records + findings from the per-entity
// mirror stores into a single WetCheckWithDetails-shaped view object. This
// is what the offline detail page should render so optimistic edits made
// against zoneRecords / findings (which live in their own stores) are
// visible immediately, not just the stale aggregate that was last warmed.
async function assembleFromMirror(db: OfflineDB, root: any, wetCheckClientId: string): Promise<any> {
  const zoneRows = await withDB(db, (d) =>
    d.getAllFromIndex("wetCheckZoneRecords", "byWetCheckClientId", wetCheckClientId));
  const composedZones: any[] = [];
  for (const zr of zoneRows) {
    const findingRows = await withDB(db, (d) =>
      d.getAllFromIndex("wetCheckFindings", "byZoneRecordClientId", zr.clientId));
    composedZones.push({
      ...(zr.data ?? {}),
      id: zr.id ?? zr.data?.id,
      clientId: zr.clientId,
      findings: findingRows.map((f) => ({
        ...(f.data ?? {}),
        id: f.id ?? f.data?.id,
        clientId: f.clientId,
      })),
    });
  }
  // Prefer per-entity rows when present; fall back to the root payload's
  // zoneRecords (e.g. when only the aggregate was warmed).
  const zoneRecords = composedZones.length > 0
    ? composedZones
    : (Array.isArray(root?.zoneRecords) ? root.zoneRecords : []);
  return {
    ...(root ?? {}),
    clientId: wetCheckClientId,
    zoneRecords,
    photos: Array.isArray(root?.photos) ? root.photos : [],
  };
}

// Re-export the helper so the wet checks page can read the offline mirror
// when navigating by clientId before the engine has a server id.
export async function readWetCheckByClientId(clientId: string) {
  const db = await openOfflineDB();
  const row = await getWetCheckMirrorByClientId(db, clientId);
  if (!row) return null;
  return await assembleFromMirror(db, row.data, clientId);
}

// Re-exported types so callers don't have to reach into ./types.
export type { QueuedMutationKind };

// --- Zone record upsert ------------------------------------------------

export interface UpsertZoneRecordInput {
  wetCheckClientId: string;
  wetCheckId?: number;
  controllerLetter: string;
  zoneNumber: number;
  status: "not_checked" | "checked_ok" | "checked_with_issues" | "not_applicable";
  ranSuccessfully?: boolean | null;
  notes?: string | null;
  clientId?: string;
  // Capture-time timestamp set on the device. Preserved through queueing
  // so replay records the real field-time, not the replay-time clock.
  checkedAt?: string;
  // Task #458 — Mark Zone Complete badge state. Send an ISO timestamp to
  // set, `null` to clear. Server force-clears it whenever status !=
  // checked_with_issues, so callers don't need to bother clearing it
  // explicitly when transitioning out of Needs Work.
  markedCompleteAt?: string | null;
}

export async function upsertZoneRecord(input: UpsertZoneRecordInput): Promise<{ id?: number; clientId: string }> {
  const clientId = input.clientId ?? uuid();
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  // Task #458 — server force-clears `markedCompleteAt` whenever status is
  // not `checked_with_issues`, so we mirror that rule here too: anything
  // explicitly set by the caller is honored only on Needs Work upserts.
  const markedCompleteAt =
    input.status === "checked_with_issues"
      ? (input.markedCompleteAt ?? null)
      : null;
  if (!isOfflineQueueEnabled() && input.wetCheckId != null) {
    return await apiRequest(`/api/wet-checks/${input.wetCheckId}/zone-records`, "POST", {
      controllerLetter: input.controllerLetter,
      zoneNumber: input.zoneNumber,
      status: input.status,
      ranSuccessfully: input.ranSuccessfully ?? null,
      notes: input.notes ?? null,
      checkedAt,
      markedCompleteAt,
      clientId,
    });
  }
  const db = await openOfflineDB();
  // Preserve the server id (and any not-yet-promoted findings array on the
  // existing data payload) when reusing the same clientId — putZoneRecordMirror
  // is a full row replace, so otherwise a Needs Work → Ran OK flip would
  // strip the id and any cached server-shape we still want to surface.
  const existingZr = await withDB(db, (d) => d.get("wetCheckZoneRecords", clientId));
  const existingId =
    existingZr?.id ?? (typeof existingZr?.data?.id === "number" ? existingZr.data.id : undefined);
  await putZoneRecordMirror(db, {
    clientId,
    id: existingId,
    wetCheckClientId: input.wetCheckClientId,
    wetCheckId: input.wetCheckId,
    data: {
      ...(existingZr?.data ?? {}),
      id: existingId,
      clientId,
      controllerLetter: input.controllerLetter,
      zoneNumber: input.zoneNumber,
      status: input.status,
      ranSuccessfully: input.ranSuccessfully ?? null,
      notes: input.notes ?? null,
      checkedAt,
      markedCompleteAt,
    },
    updatedAt: Date.now(),
  });
  const body = {
    controllerLetter: input.controllerLetter,
    zoneNumber: input.zoneNumber,
    status: input.status,
    ranSuccessfully: input.ranSuccessfully ?? null,
    notes: input.notes ?? null,
    checkedAt,
    markedCompleteAt,
    clientId,
  };
  await getSyncEngine().enqueue(newMutation({
    kind: "zone_record.upsert",
    method: "POST",
    urlTemplate: "/api/wet-checks/{{wc}}/zone-records",
    body,
    clientId,
    parentClientId: input.wetCheckClientId,
    placeholders: { wc: input.wetCheckClientId },
  }));
  return { clientId };
}

// --- Finding create / update / delete ---------------------------------

export interface CreateFindingInput {
  zoneRecordClientId: string;
  zoneRecordId?: number;
  wetCheckId?: number;
  payload: any; // server-shaped finding body (issueType, severity, partsUsed, etc.)
  clientId?: string;
}

export async function createFinding(input: CreateFindingInput): Promise<{ id?: number; clientId: string }> {
  const clientId = input.clientId ?? uuid();
  if (!isOfflineQueueEnabled() && input.zoneRecordId != null) {
    return await apiRequest(`/api/wet-checks/zone-records/${input.zoneRecordId}/findings`, "POST", {
      ...input.payload,
      clientId,
    });
  }
  const db = await openOfflineDB();
  await putFindingMirror(db, {
    clientId,
    zoneRecordClientId: input.zoneRecordClientId,
    zoneRecordId: input.zoneRecordId,
    wetCheckId: input.wetCheckId,
    data: { ...input.payload, clientId },
    updatedAt: Date.now(),
  });
  await getSyncEngine().enqueue(newMutation({
    kind: "finding.create",
    method: "POST",
    urlTemplate: "/api/wet-checks/zone-records/{{zr}}/findings",
    body: { ...input.payload, clientId },
    clientId,
    parentClientId: input.zoneRecordClientId,
    placeholders: { zr: input.zoneRecordClientId },
  }));
  return { clientId };
}

export async function updateFinding(findingClientId: string, findingId: number | undefined, patch: any): Promise<void> {
  if (!isOfflineQueueEnabled() && findingId != null) {
    await apiRequest(`/api/wet-checks/findings/${findingId}`, "PATCH", patch);
    return;
  }
  const db = await openOfflineDB();
  // Mirror update — preserve other fields.
  const existing = await withDB(db, (d) => d.get("wetCheckFindings", findingClientId));
  if (existing) {
    await putFindingMirror(db, {
      ...existing,
      data: { ...existing.data, ...patch },
      updatedAt: Date.now(),
    });
  }
  await getSyncEngine().enqueue(newMutation({
    kind: "finding.update",
    method: "PATCH",
    urlTemplate: "/api/wet-checks/findings/{{f}}",
    body: patch,
    clientId: uuid(),
    parentClientId: findingClientId,
    placeholders: { f: findingClientId },
  }));
}

// Task #755 — patch repairLaborHours on a zone record.
// When offline and the zone record was created in this session (has a
// clientId but may not yet have a server id), the mutation is queued
// with a `{{zr}}` placeholder so the engine substitutes the server id
// at dispatch time, matching the same pattern as finding.update.
export async function patchZoneRecordRepairLabor(
  zoneRecordClientId: string,
  zoneRecordId: number | undefined,
  repairLaborHours: string,
): Promise<void> {
  if (!isOfflineQueueEnabled() && zoneRecordId != null) {
    await apiRequest(`/api/wet-checks/zone-records/${zoneRecordId}/repair-labor`, "PATCH", {
      repairLaborHours,
    });
    return;
  }
  const db = await openOfflineDB();
  const existing = await withDB(db, (d) => d.get("wetCheckZoneRecords", zoneRecordClientId));
  if (existing) {
    await putZoneRecordMirror(db, {
      ...existing,
      data: { ...existing.data, repairLaborHours },
      updatedAt: Date.now(),
    });
  }
  await getSyncEngine().enqueue(newMutation({
    kind: "zone_record.update",
    method: "PATCH",
    urlTemplate: "/api/wet-checks/zone-records/{{zr}}/repair-labor",
    body: { repairLaborHours },
    clientId: uuid(),
    parentClientId: zoneRecordClientId,
    placeholders: { zr: zoneRecordClientId },
  }));
}

export async function patchZoneRecordReadings(
  zoneRecordClientId: string,
  zoneRecordId: number | undefined,
  observedPressure: string,
  observedFlow: string,
): Promise<void> {
  const body = {
    observedPressure: observedPressure.trim() !== "" ? observedPressure.trim() : null,
    observedFlow: observedFlow.trim() !== "" ? observedFlow.trim() : null,
  };
  if (!isOfflineQueueEnabled() && zoneRecordId != null) {
    await apiRequest(`/api/wet-checks/zone-records/${zoneRecordId}`, "PATCH", body);
    return;
  }
  const db = await openOfflineDB();
  const existing = await withDB(db, (d) => d.get("wetCheckZoneRecords", zoneRecordClientId));
  if (existing) {
    await putZoneRecordMirror(db, {
      ...existing,
      data: { ...existing.data, ...body },
      updatedAt: Date.now(),
    });
  }
  await getSyncEngine().enqueue(newMutation({
    kind: "zone_record.update",
    method: "PATCH",
    urlTemplate: "/api/wet-checks/zone-records/{{zr}}",
    body,
    clientId: uuid(),
    parentClientId: zoneRecordClientId,
    placeholders: { zr: zoneRecordClientId },
  }));
}

// Queue a photo→finding link PATCH.
//
// Task #510 — the photo is addressed by its `clientId` via a new `{{p}}`
// placeholder so the engine resolves it to the photo's server id at
// dispatch time (the same way `{{f}}` resolves a finding's server id).
// We also set `parentClientId` to the photo's own clientId so the
// queue's existing "wait for parent to complete" gate keeps the link
// PATCH from racing the upload — the engine treats every queued
// mutation sharing a clientId as a parent for any other mutation
// targeting that clientId.
//
// Callers that already hold a real positive server id (e.g. the
// removePendingPhoto / delete paths) keep the direct-id path: pass
// `photoId` and we hit `/api/wet-checks/photos/:id` immediately when
// the offline queue is disabled.
export interface LinkPhotoToFindingInput {
  /** clientId of the photo (always present for offline-queued uploads). */
  photoClientId: string;
  /** Optional positive server id for the photo (used when offline queue is disabled). */
  photoId?: number | null;
  /** clientId of the finding (used to resolve {{f}} via the finding mirror or queued create). */
  findingClientId: string;
  /** Optional positive server id for the finding (required when offline queue is disabled). */
  findingId?: number | null;
}

export async function linkPhotoToFinding(input: LinkPhotoToFindingInput): Promise<void> {
  const { photoClientId, photoId, findingClientId, findingId } = input;
  if (!isOfflineQueueEnabled()) {
    if (photoId == null || photoId < 0 || findingId == null) {
      throw new Error(
        "linkPhotoToFinding: positive photoId and findingId required when offline queue is disabled",
      );
    }
    await apiRequest(`/api/wet-checks/photos/${photoId}`, "PATCH", { findingId });
    return;
  }
  await getSyncEngine().enqueue(newMutation({
    kind: "photo.link",
    method: "PATCH",
    urlTemplate: `/api/wet-checks/photos/{{p}}`,
    body: { findingId: "{{f}}" },
    clientId: uuid(),
    // Gate on the photo's upload mutation completing first; sharing a
    // clientId means the engine's parent-satisfied check waits for the
    // upload before dispatching the link PATCH.
    parentClientId: photoClientId,
    placeholders: { p: photoClientId, f: findingClientId },
  }));
}

// Test helper — surface the placeholder-based queue payload without
// needing to actually have the engine running. Not exported in the
// public API; only the unit tests reach for this.
export function __buildPhotoLinkMutationForTests(
  photoClientId: string,
  findingClientId: string,
): QueuedMutation {
  return newMutation({
    kind: "photo.link",
    method: "PATCH",
    urlTemplate: `/api/wet-checks/photos/{{p}}`,
    body: { findingId: "{{f}}" },
    clientId: uuid(),
    parentClientId: photoClientId,
    placeholders: { p: photoClientId, f: findingClientId },
  });
}

// 4C — capture-and-queue a wet check photo. Compresses with the web
// worker, stores the resulting Blob in IndexedDB, and enqueues a
// `photo.upload` mutation whose parent is the most-specific known
// entity (finding > zone record > wet check). The engine will run the
// existing sign → PUT → finalize → metadata-POST flow on its next tick
// (immediately when online, on reconnect when offline).
export interface QueuePhotoUploadInput {
  file: File;
  wetCheckClientId: string;
  wetCheckId?: number;
  zoneRecordClientId?: string | null;
  zoneRecordId?: number | null;
  findingClientId?: string | null;
  findingId?: number | null;
}
export interface QueuePhotoUploadResult {
  clientId: string;
  /** object URL pointing at the captured Blob — for optimistic thumbnails */
  localUrl: string;
  originalSize: number;
  compressedSize: number;
  usedFallback: boolean;
}
export async function queuePhotoUpload(input: QueuePhotoUploadInput): Promise<QueuePhotoUploadResult> {
  const clientId = uuid();
  // Share the billing-sheet prep pipeline so wet-check photos travel the
  // same hardened envelope: HEIC→JPEG once, then ~1600px / ~0.35MB / q=0.80
  // JPEG that drives the server-generated `thumb` / `medium` variants.
  // `preparePhotoForUpload` falls back to the input bytes on any failure;
  // we mirror that as `usedFallback` so the caller can warn on huge
  // originals that didn't compress.
  const originalSize = input.file.size;
  let prepared: File;
  let usedFallback = false;
  try {
    const out = await preparePhotoForUpload(input.file);
    prepared = out.displayFile;
    usedFallback = out.usedFallback;
  } catch (err) {
    console.warn("[offline] preparePhotoForUpload failed; queuing original bytes", err);
    prepared = input.file;
    usedFallback = true;
  }
  const compressedSize = prepared.size;
  const db = await openOfflineDB();
  await putPhotoBlob(db, {
    clientId,
    blob: prepared,
    contentType: prepared.type || "image/jpeg",
    name: prepared.name || `photo-${clientId}.jpg`,
    byteSize: prepared.size,
    capturedAt: Date.now(),
    compressed: !usedFallback,
  });
  // Most-specific parent precedence: finding > zoneRecord > wetCheck.
  // The engine's `readySet` only dispatches a mutation once its parent
  // has resolved, so picking the right parent is what enforces the
  // dependency-order replay for 4C.
  const parentClientId =
    (input.findingClientId ?? null)
    || (input.zoneRecordClientId ?? null)
    || input.wetCheckClientId;
  const placeholders: Record<string, string> = { wc: input.wetCheckClientId };
  if (input.zoneRecordClientId) placeholders.zr = input.zoneRecordClientId;
  if (input.findingClientId) placeholders.f = input.findingClientId;
  // Body: server expects numeric zoneRecordId/findingId; the engine
  // substitutes `{{zr}}` / `{{f}}` with resolved server ids at dispatch
  // time. `url` is filled in by the engine after the finalize step.
  const body: Record<string, any> = {
    takenAt: input.file.lastModified
      ? new Date(input.file.lastModified).toISOString()
      : new Date().toISOString(),
    clientId,
    zoneRecordId: input.zoneRecordClientId ? "{{zr}}" : (input.zoneRecordId ?? null),
    findingId: input.findingClientId ? "{{f}}" : (input.findingId ?? null),
  };
  await getSyncEngine().enqueue(newMutation({
    kind: "photo.upload",
    method: "POST",
    urlTemplate: "/api/wet-checks/{{wc}}/photos",
    body,
    clientId,
    parentClientId,
    placeholders,
  }));
  // Optimistic local thumbnail. Caller is responsible for revoking the
  // object URL when the photo eventually replaces it with the server one.
  let localUrl = "";
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
      localUrl = URL.createObjectURL(prepared);
    }
  } catch {}
  return {
    clientId,
    localUrl,
    originalSize,
    compressedSize,
    usedFallback,
  };
}

export async function deleteFinding(findingClientId: string, findingId: number | undefined): Promise<void> {
  if (!isOfflineQueueEnabled() && findingId != null) {
    await apiRequest(`/api/wet-checks/findings/${findingId}`, "DELETE");
    return;
  }
  const db = await openOfflineDB();
  // Task #518 — capture the wet-check clientId BEFORE we drop the
  // finding mirror so the engine can:
  //   (a) clear the readySet parent gate (the resolver can satisfy a
  //       wet-check parent via the wet-check mirror — but it could not
  //       satisfy a finding parent once we'd deleted the finding
  //       mirror, which used to leave finding.delete mutations stuck
  //       in `pending` forever for findings that pre-existed online),
  //   (b) resolve the wet-check id on a 409 refusal so
  //       refreshMirrorFromServer can put the deleted row back —
  //       findWetCheckIdForMutation reads `placeholders.wc`.
  const fMirror = await withDB(db, (d) => d.get("wetCheckFindings", findingClientId));
  let wetCheckClientId: string | undefined;
  if (fMirror?.zoneRecordClientId) {
    const zr = await withDB(db, (d) => d.get("wetCheckZoneRecords", fMirror.zoneRecordClientId!));
    wetCheckClientId = zr?.wetCheckClientId;
  }
  await deleteFindingMirror(db, findingClientId);
  const hasServerId = findingId != null;
  // Bake the server id into the urlTemplate when we know it (legacy
  // form, mirrors api.ts:830) so the placeholder resolver doesn't need
  // a finding mirror that we just deleted. Only fall back to the
  // `{{f}}` placeholder for offline-created findings whose server id
  // arrives via a still-queued finding.create mutation.
  const placeholders: Record<string, string> = {};
  if (!hasServerId) placeholders.f = findingClientId;
  if (wetCheckClientId) placeholders.wc = wetCheckClientId;
  await getSyncEngine().enqueue(newMutation({
    kind: "finding.delete",
    method: "DELETE",
    urlTemplate: hasServerId
      ? `/api/wet-checks/findings/${findingId}`
      : "/api/wet-checks/findings/{{f}}",
    body: undefined,
    clientId: uuid(),
    // Pre-existing online findings have no in-flight create to wait
    // on; gate on the wet check (which we know exists) when we have
    // its clientId, otherwise leave parentClientId null.
    parentClientId: hasServerId ? (wetCheckClientId ?? null) : findingClientId,
    placeholders,
  }));
}

// Queue (or directly perform) a wet-check photo delete. Used by the
// "revert zone from Needs Work" flow (Task #455) to remove finding-level
// photos as part of cascading the cleanup. Online: hits the DELETE
// endpoint immediately. Offline: queues a `photo.delete` mutation that
// the engine will replay against the same endpoint with the photo's
// numeric server id baked into the URL (no placeholders needed).
//
// When `wetCheckClientId` is provided we also optimistically strip the
// photo from the wet check mirror's `root.photos` array so the offline
// reader (`assembleFromMirror`) reflects the cleanup immediately, before
// the queued mutation has a chance to replay.
export async function deletePhoto(photoId: number, wetCheckClientId?: string): Promise<void> {
  if (!isOfflineQueueEnabled()) {
    await apiRequest(`/api/wet-checks/photos/${photoId}`, "DELETE");
    return;
  }
  const db = await openOfflineDB();
  if (wetCheckClientId) {
    const row = await getWetCheckMirrorByClientId(db, wetCheckClientId);
    if (row) {
      const data = (row as any).data ?? {};
      const before: any[] = Array.isArray(data.photos) ? data.photos : [];
      const after = before.filter((p) => p?.id !== photoId);
      if (after.length !== before.length) {
        await putWetCheckMirror(db, {
          ...row,
          data: { ...data, photos: after },
          updatedAt: Date.now(),
        });
      }
    }
  }
  await getSyncEngine().enqueue(newMutation({
    kind: "photo.delete",
    method: "DELETE",
    urlTemplate: `/api/wet-checks/photos/${photoId}`,
    body: undefined,
    clientId: uuid(),
    parentClientId: null,
    placeholders: {},
  }));
}

// Cancel any queued photo mutations (uploads or finding-link patches)
// tied to the supplied finding clientIds. Used by the revert-zone flow
// (Task #455) so an offline-captured photo for a finding being deleted
// can't replay later and re-attach itself — either directly to the
// finding (which has been deleted) or, worse, surface as a zone-level
// photo on the now-OK zone.
//
// A photo.upload counts as tied to a finding when ANY of these is true:
//   1. parentClientId === findingClientId (the typical capture-while-
//      finding-exists path).
//   2. placeholders.f === findingClientId (the upload's body still
//      references the finding via {{f}} even though the queue parent is
//      the zone record).
// A photo.link is tied via parentClientId (or placeholders.f) — always
// the finding cid in the create-finding-from-existing-photos flow.
export async function cancelQueuedPhotoMutationsForFindings(
  findingClientIds: ReadonlyArray<string>,
): Promise<number> {
  if (!isOfflineQueueEnabled() || findingClientIds.length === 0) return 0;
  const engine = getSyncEngine();
  const set = new Set(findingClientIds);
  const all = await engine.listMutations();
  let cancelled = 0;
  for (const m of all) {
    if (m.status === "completed") continue;
    if (m.kind !== "photo.upload" && m.kind !== "photo.link") continue;
    const parentMatch = m.parentClientId != null && set.has(m.parentClientId);
    const placeholderF = m.placeholders?.f;
    const placeholderMatch = !!placeholderF && set.has(placeholderF);
    if (parentMatch || placeholderMatch) {
      await engine.cancelMutation(m.id);
      cancelled++;
    }
  }
  return cancelled;
}

// Task #455 — single offline cascade for the "revert zone from Needs
// Work" flow. We enqueue all of:
//   1) photo.delete (one per finding photo)
//   2) finding.update (set repairedInField=false on each non-pending
//      finding so the server-side delete is allowed)
//   3) finding.delete (one per finding)
//   4) zone_record.upsert (the actual status flip)
// with explicit `parentClientIds` chaining so the engine — which
// dispatches up to 2 mutations concurrently — cannot reorder them. The
// status flip will not run until every photo + finding mutation for this
// zone has completed. Every step also writes through to the IndexedDB
// mirror immediately so the local view reflects the cleaned-up zone
// before any of these mutations replay.
export interface ZoneRevertCascadeInput {
  wetCheckClientId: string;
  wetCheckId?: number;
  zoneRecordClientId: string;
  zoneRecordId?: number;
  controllerLetter: string;
  zoneNumber: number;
  targetStatus: "checked_ok" | "not_applicable";
  findings: ReadonlyArray<{
    id: number;
    // Legacy findings created before clientId was wired through may be
    // null. Cascade falls back to addressing such findings by server id
    // directly (no placeholder), so they still get cleaned up.
    clientId: string | null;
    needsResetToPending: boolean;
    photoIds: ReadonlyArray<number>;
  }>;
  checkedAt?: string;
}
export async function enqueueZoneRevertCascade(input: ZoneRevertCascadeInput): Promise<void> {
  const db = await openOfflineDB();
  const engine = getSyncEngine();
  const checkedAt = input.checkedAt ?? new Date().toISOString();

  // Cancel any not-yet-replayed photo uploads/links tied to these
  // findings so they can't sneak through after revert. (Legacy findings
  // without a clientId have nothing queued against them, so skip.)
  await cancelQueuedPhotoMutationsForFindings(
    input.findings.map((f) => f.clientId).filter((c): c is string => !!c),
  );

  // Step 1 — photo deletes. Independent of each other; their cids feed
  // every later step's parentClientIds.
  const photoDeleteCids: string[] = [];
  for (const f of input.findings) {
    for (const photoId of f.photoIds) {
      const row = await getWetCheckMirrorByClientId(db, input.wetCheckClientId);
      if (row) {
        const data = (row as any).data ?? {};
        const before: any[] = Array.isArray(data.photos) ? data.photos : [];
        const after = before.filter((p) => p?.id !== photoId);
        if (after.length !== before.length) {
          await putWetCheckMirror(db, {
            ...row,
            data: { ...data, photos: after },
            updatedAt: Date.now(),
          });
        }
      }
      const cid = uuid();
      photoDeleteCids.push(cid);
      await engine.enqueue(newMutation({
        kind: "photo.delete",
        method: "DELETE",
        urlTemplate: `/api/wet-checks/photos/${photoId}`,
        body: undefined,
        clientId: cid,
        parentClientId: null,
        placeholders: {},
      }));
    }
  }

  // Step 2 — repairedInField=false on every non-pending finding so the
  // server's delete is allowed through. Each patch waits on every photo
  // delete completing first. Legacy findings without a clientId are
  // addressed by server id directly (no placeholder, no parent gating).
  const findingPatchCids = new Map<string, string>();
  for (const f of input.findings) {
    if (!f.needsResetToPending) continue;
    if (f.clientId) {
      const existing = await withDB(db, (d) => d.get("wetCheckFindings", f.clientId!));
      if (existing) {
        await putFindingMirror(db, {
          ...existing,
          data: { ...(existing as any).data, resolution: "pending" },
          updatedAt: Date.now(),
        });
      }
    }
    const cid = uuid();
    if (f.clientId) findingPatchCids.set(f.clientId, cid);
    await engine.enqueue(newMutation({
      kind: "finding.update",
      method: "PATCH",
      urlTemplate: f.clientId
        ? "/api/wet-checks/findings/{{f}}"
        : `/api/wet-checks/findings/${f.id}`,
      body: { repairedInField: false },
      clientId: cid,
      parentClientId: f.clientId ?? null,
      parentClientIds: photoDeleteCids.length > 0 ? [...photoDeleteCids] : undefined,
      placeholders: f.clientId ? { f: f.clientId } : {},
    }));
  }

  // Step 3 — finding.delete. Each finding's delete waits on its own
  // patch (if any) AND every photo delete.
  const findingDeleteCids: string[] = [];
  for (const f of input.findings) {
    if (f.clientId) await deleteFindingMirror(db, f.clientId);
    const cid = uuid();
    findingDeleteCids.push(cid);
    const deps: string[] = [...photoDeleteCids];
    const patchCid = f.clientId ? findingPatchCids.get(f.clientId) : undefined;
    if (patchCid) deps.push(patchCid);
    await engine.enqueue(newMutation({
      kind: "finding.delete",
      method: "DELETE",
      urlTemplate: f.clientId
        ? "/api/wet-checks/findings/{{f}}"
        : `/api/wet-checks/findings/${f.id}`,
      body: undefined,
      clientId: cid,
      parentClientId: f.clientId ?? null,
      parentClientIds: deps.length > 0 ? deps : undefined,
      placeholders: f.clientId ? { f: f.clientId } : {},
    }));
  }

  // Step 4 — zone status flip. Waits on every finding delete (which in
  // turn wait on every patch + every photo delete), so this cannot
  // dispatch until the whole cascade is durably completed server-side.
  // Preserve the existing row's server id so the cascade's status flip
  // doesn't strip it from the mirror — `assembleFromMirror` reads `zr.id`
  // / `zr.data?.id`, and downstream readers (e.g. `wc.photos.filter` by
  // `zoneRecordId`) need the id to remain stable across the revert.
  const existingZr = await withDB(db, (d) => d.get("wetCheckZoneRecords", input.zoneRecordClientId));
  const existingId =
    existingZr?.id ?? (typeof existingZr?.data?.id === "number" ? existingZr.data.id : input.zoneRecordId);
  await putZoneRecordMirror(db, {
    clientId: input.zoneRecordClientId,
    id: existingId,
    wetCheckClientId: input.wetCheckClientId,
    wetCheckId: input.wetCheckId,
    data: {
      ...(existingZr?.data ?? {}),
      id: existingId,
      clientId: input.zoneRecordClientId,
      controllerLetter: input.controllerLetter,
      zoneNumber: input.zoneNumber,
      status: input.targetStatus,
      ranSuccessfully: input.targetStatus === "checked_ok" ? true : null,
      notes: null,
      checkedAt,
      // Force-clear the Mark-Complete badge — server force-clears it on
      // any non-Needs-Work status, and we mirror that locally so the
      // controller grid never keeps the green-check overlay on a tile
      // that is no longer red.
      markedCompleteAt: null,
    },
    updatedAt: Date.now(),
  });
  const allDeps = [...photoDeleteCids, ...Array.from(findingPatchCids.values()), ...findingDeleteCids];
  await engine.enqueue(newMutation({
    kind: "zone_record.upsert",
    method: "POST",
    urlTemplate: "/api/wet-checks/{{wc}}/zone-records",
    body: {
      controllerLetter: input.controllerLetter,
      zoneNumber: input.zoneNumber,
      status: input.targetStatus,
      ranSuccessfully: input.targetStatus === "checked_ok" ? true : null,
      notes: null,
      checkedAt,
      clientId: input.zoneRecordClientId,
    },
    clientId: input.zoneRecordClientId,
    parentClientId: input.wetCheckClientId,
    parentClientIds: allDeps.length > 0 ? allDeps : undefined,
    placeholders: { wc: input.wetCheckClientId },
  }));
}

// --- Read helpers used to warm the mirror ------------------------------

export async function warmWetCheckMirror(db: OfflineDB | null, wetCheckId: number, data: any): Promise<void> {
  const ddb = db ?? (await openOfflineDB());
  const clientId: string = data?.clientId ?? `server-${wetCheckId}`;
  const now = Date.now();
  await putWetCheckMirror(ddb, {
    clientId,
    id: wetCheckId,
    data,
    status: data?.status ?? "in_progress",
    updatedAt: now,
  });
  // Also hydrate per-entity stores so finding.update / finding.delete and
  // zone_record.upsert mutations against pre-existing server entities can
  // resolve their {{f}} / {{zr}} placeholders via the mirror.
  const zoneRecords: any[] = Array.isArray(data?.zoneRecords) ? data.zoneRecords : [];
  for (const zr of zoneRecords) {
    if (!zr?.clientId) continue;
    await putZoneRecordMirror(ddb, {
      clientId: zr.clientId,
      id: typeof zr.id === "number" ? zr.id : undefined,
      wetCheckClientId: clientId,
      wetCheckId,
      data: zr,
      updatedAt: now,
    });
    const findings: any[] = Array.isArray(zr?.findings) ? zr.findings : [];
    for (const f of findings) {
      if (!f?.clientId) continue;
      await putFindingMirror(ddb, {
        clientId: f.clientId,
        id: typeof f.id === "number" ? f.id : undefined,
        zoneRecordClientId: zr.clientId,
        zoneRecordId: typeof zr.id === "number" ? zr.id : undefined,
        wetCheckId,
        data: f,
        updatedAt: now,
      });
    }
  }
}

// True iff there is at least one not-yet-completed mutation in the queue
// whose clientId belongs to the given wet check (the wet check itself,
// any of its zone records, or any of their findings) — including any
// queued submit / cascade entries gated on those clientIds. Used by the
// detail query to skip the background server refetch while local edits
// are still draining, so a stale server snapshot can't clobber an
// optimistic Needs Work → Ran OK flip in the controller grid.
export async function hasPendingMutationsForWetCheck(wetCheckClientId: string): Promise<boolean> {
  if (!isOfflineQueueEnabled() || !wetCheckClientId) return false;
  const db = await openOfflineDB();
  const all = await listAllMutations(db);
  const zoneRecords = await listZoneRecordsForWetCheck(db, wetCheckClientId);
  const ownedCids = new Set<string>();
  ownedCids.add(wetCheckClientId);
  for (const z of zoneRecords) {
    ownedCids.add(z.clientId);
    const fs = await listFindingsForZoneRecord(db, z.clientId);
    for (const f of fs) ownedCids.add(f.clientId);
  }
  for (const m of all) {
    if (m.status === "completed") continue;
    if (ownedCids.has(m.clientId)) return true;
    if (m.parentClientId && ownedCids.has(m.parentClientId)) return true;
    for (const c of m.parentClientIds ?? []) {
      if (ownedCids.has(c)) return true;
    }
    for (const c of Object.values(m.placeholders ?? {})) {
      if (ownedCids.has(c)) return true;
    }
  }
  return false;
}

export async function readWetCheckFromMirror(wetCheckId: number): Promise<any | null> {
  const db = await openOfflineDB();
  const row = await getWetCheckMirrorById(db, wetCheckId);
  if (!row) return null;
  return await assembleFromMirror(db, row.data, row.clientId);
}
