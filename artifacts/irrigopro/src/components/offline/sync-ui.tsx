// Slice 4D — Sync UI surface for the wet check screen.
//
// This file is a UI-only consumer of the offline engine (4A/4B/4C). It
// exports four pieces that together cover the spec:
//
//   • <OfflineStrip /> — thin amber bar pinned to the top of the wet
//     check screen while offline.
//   • <SyncBadge />    — inline header pill with three states (synced /
//     syncing / errors). Tapping it opens the queue view.
//   • <QueueView />    — bottom-sheet listing every queued mutation
//     grouped by status, with Cancel and Retry actions.
//   • <OfflineSyncUI /> — convenience wrapper that mounts the strip +
//     badge + queue view + photo progress chip together. The wet check
//     page renders one of these in its header.
//
// Everything is gated behind `isOfflineSyncUIEnabled()`. With the flag
// off the components render `null` but the engine continues draining in
// the background — no behavioral coupling.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Loader2,
  RefreshCw,
  WifiOff,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  getSyncEngine,
  isOfflineQueueEnabled,
  isOfflineSyncUIEnabled,
} from "@/lib/offline/engine";
import type {
  EngineEvent,
  QueuedMutation,
  QueuedMutationKind,
} from "@/lib/offline/types";

// ─── Hook: live engine snapshot ──────────────────────────────────────────────
//
// Subscribes to the engine's event stream and exposes the current online
// flag, aggregate counts, and the full queue list. The list is refreshed
// from the engine on every emitted event (every dispatch transition,
// every enqueue, every retry/cancel).

interface SyncSnapshot {
  online: boolean;
  pending: number;
  syncing: number;
  failed: number;
  mutations: QueuedMutation[];
}

const EMPTY_SNAPSHOT: SyncSnapshot = {
  online: true,
  pending: 0,
  syncing: 0,
  failed: 0,
  mutations: [],
};

export function useSyncEngineState(enabled: boolean = true): SyncSnapshot {
  const [snap, setSnap] = useState<SyncSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    if (!enabled) return;
    if (!isOfflineQueueEnabled()) return;
    const engine = getSyncEngine();
    let cancelled = false;

    const refresh = async () => {
      try {
        const mutations = await engine.listMutations();
        if (cancelled) return;
        let pending = 0, syncing = 0, failed = 0;
        for (const m of mutations) {
          if (m.status === "pending") pending++;
          else if (m.status === "syncing") syncing++;
          else if (m.status === "failed") failed++;
        }
        // Trust engine.isOnline() as the source of truth — state events
        // emit it on every transition, and listMutations is only called
        // alongside an event so we're never reading stale.
        setSnap({
          online: engine.isOnline(),
          pending,
          syncing,
          failed,
          mutations,
        });
      } catch {
        // Ignore — db may not be open yet.
      }
    };

    const off = engine.on((e: EngineEvent) => {
      if (e.type === "state") {
        // Adopt the engine's authoritative counts immediately so the
        // badge reacts even before listMutations resolves.
        setSnap((prev) => ({
          ...prev,
          online: e.online,
          pending: e.pending,
          syncing: e.syncing,
          failed: e.failed,
        }));
      }
      void refresh();
    });

    void refresh();
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);

  return snap;
}

// ─── Offline strip ───────────────────────────────────────────────────────────

export function OfflineStrip() {
  const snap = useSyncEngineState();
  if (!isOfflineSyncUIEnabled()) return null;
  if (snap.online) return null;
  return (
    <div
      className="sticky top-0 z-30 -mx-4 mb-2 flex items-center justify-center gap-2 bg-amber-100 text-amber-900 text-xs font-medium px-3 py-1.5 border-y border-amber-300"
      role="status"
      data-testid="offline-strip"
    >
      <WifiOff className="w-3.5 h-3.5" />
      <span>Offline — your changes are queued and will sync when you're back online.</span>
    </div>
  );
}

// ─── Per-photo progress chip ─────────────────────────────────────────────────
//
// Counts photo-link mutations that are still queued (pending/syncing) vs
// the total seen for this batch since it started. Renders as a thin
// "Uploading photo N of M…" pill near the badge so the tech knows the
// photos they just took haven't been dropped.

function usePhotoProgress(mutations: QueuedMutation[]) {
  const photoMutations = useMemo(
    () => mutations.filter((m) => m.kind === "photo.link"),
    [mutations],
  );
  const remaining = photoMutations.filter(
    (m) => m.status === "pending" || m.status === "syncing",
  ).length;
  // Total = remaining + recently-completed photo links in the same
  // mirror snapshot (the engine prunes >24h, so this is naturally a
  // recent-batch view).
  const total = photoMutations.length;
  const done = total - remaining;
  return { remaining, total, done };
}

export function PhotoUploadProgress() {
  const snap = useSyncEngineState();
  const { remaining, total, done } = usePhotoProgress(snap.mutations);
  if (!isOfflineSyncUIEnabled()) return null;
  if (remaining === 0 || total === 0) return null;
  return (
    <div
      className="inline-flex items-center gap-1.5 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-0.5"
      data-testid="photo-upload-progress"
    >
      <Loader2 className="w-3 h-3 animate-spin" />
      <span>Uploading photo {Math.min(done + 1, total)} of {total}…</span>
    </div>
  );
}

// ─── Sync badge ──────────────────────────────────────────────────────────────

type BadgeState = "synced" | "syncing" | "errors";

function badgeState(snap: SyncSnapshot): BadgeState {
  if (snap.failed > 0) return "errors";
  if (snap.pending > 0 || snap.syncing > 0) return "syncing";
  return "synced";
}

export function SyncBadge({
  onOpenQueue,
}: {
  onOpenQueue: () => void;
}) {
  const snap = useSyncEngineState();
  if (!isOfflineSyncUIEnabled()) return null;
  const state = badgeState(snap);
  const inFlight = snap.pending + snap.syncing;
  const label =
    state === "errors"
      ? `Sync errors (${snap.failed})`
      : state === "syncing"
        ? `Syncing… ${inFlight}`
        // Task #556 — narrowed copy: this badge only reflects the offline
        // write queue, not read auth. "All synced" was misleading when
        // every read was silently 401-ing.
        : "Uploads synced";
  const Icon =
    state === "errors" ? AlertTriangle : state === "syncing" ? Loader2 : CheckCircle2;
  const variant: "default" | "secondary" | "destructive" =
    state === "errors" ? "destructive" : state === "syncing" ? "secondary" : "default";
  return (
    <button
      type="button"
      onClick={onOpenQueue}
      className="inline-flex"
      aria-label={`Open sync queue — ${label}`}
      data-testid="sync-badge"
      data-sync-state={state}
    >
      <Badge
        variant={variant}
        className={`gap-1 cursor-pointer ${state === "synced" ? "bg-emerald-600 hover:bg-emerald-600" : ""}`}
      >
        <Icon className={`w-3 h-3 ${state === "syncing" ? "animate-spin" : ""}`} />
        <span>{label}</span>
      </Badge>
    </button>
  );
}

// ─── Queue view (bottom sheet) ───────────────────────────────────────────────

function kindLabel(kind: QueuedMutationKind): string {
  switch (kind) {
    case "wet_check.create":   return "Create wet check";
    case "wet_check.update":   return "Update wet check";
    case "wet_check.submit":   return "Submit wet check";
    case "zone_record.upsert": return "Save zone status";
    case "zone_record.update": return "Update zone";
    case "finding.create":     return "Add finding";
    case "finding.update":     return "Edit finding";
    case "finding.delete":     return "Remove finding";
    case "photo.link":         return "Attach photo";
    case "photo.upload":       return "Upload photo";
    case "photo.delete":       return "Remove photo";
    default:                   return kind;
  }
}

// Task #469 — surface a plain "Couldn't reach server" line for HTML / edge
// errors instead of the raw `<!doctype html>…` payload.
function friendlyErrorMessage(raw: string): string {
  const head = raw.trimStart().slice(0, 64).toLowerCase();
  // Task #501 — passive retry cap reached. The raw message is shaped like
  // `gave_up_after_8_attempts` or `gave_up_after_60_minutes: <body>`.
  if (head.startsWith("gave_up_after_")) {
    const m = /^gave_up_after_(\d+)_(attempts|minutes)/.exec(head);
    if (m) {
      const n = m[1];
      const unit = m[2];
      return unit === "attempts"
        ? `Gave up after ${n} attempts — tap Retry to try again`
        : `Gave up after ${n} minutes — tap Retry to try again`;
    }
    return "Gave up after repeated failures — tap Retry to try again";
  }
  // The device's IndexedDB connection was closed mid-dispatch (iOS does this
  // whenever the app is backgrounded). Nothing was sent and no attempt was
  // spent — the queue picks this up again on its own.
  if (head.startsWith("local_storage_unavailable")) {
    return "Device storage was busy — will retry";
  }
  if (
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<") ||
    head.startsWith("edge_")
  ) {
    return "Couldn't reach server — will retry";
  }
  return raw.slice(0, 240);
}

function relTime(now: number, ts: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function MutationRow({
  m,
  onCancel,
  onRetry,
}: {
  m: QueuedMutation;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const now = Date.now();
  const isFailed = m.status === "failed";
  const isCompleted = m.status === "completed";
  const isSyncing = m.status === "syncing";
  return (
    <div
      className="flex items-start justify-between gap-3 border rounded p-2 text-sm"
      data-testid={`queue-row-${m.id}`}
      data-status={m.status}
      data-kind={m.kind}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{kindLabel(m.kind)}</span>
          {isSyncing && (
            <Badge variant="secondary" className="gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Syncing
            </Badge>
          )}
          {isFailed && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="w-3 h-3" /> Failed
            </Badge>
          )}
          {isCompleted && (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Done
            </Badge>
          )}
          {m.attemptCount > 0 && !isCompleted && (
            <span className="text-[11px] text-gray-500">
              try #{m.attemptCount + (isFailed ? 0 : 1)}
            </span>
          )}
        </div>
        <div className="text-[11px] text-gray-500">
          {m.method} {m.urlTemplate}
          {" · "}
          {relTime(now, m.createdAt)}
        </div>
        {m.lastError && (
          <div
            className="text-[11px] text-red-700 mt-0.5 break-words"
            data-testid={`queue-error-${m.id}`}
          >
            {friendlyErrorMessage(m.lastError)}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {isFailed && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2"
            onClick={() => onRetry(m.id)}
            data-testid={`queue-retry-${m.id}`}
          >
            <RefreshCw className="w-3 h-3 mr-1" /> Retry
          </Button>
        )}
        {!isCompleted && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-red-600 hover:text-red-700"
            onClick={() => onCancel(m.id)}
            data-testid={`queue-cancel-${m.id}`}
          >
            <X className="w-3 h-3 mr-1" /> Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function QueueView({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const snap = useSyncEngineState(open);
  const { toast } = useToast();

  const onCancel = useCallback(async (id: string) => {
    try {
      await getSyncEngine().cancelMutation(id);
      toast({ title: "Cancelled queued change" });
    } catch (e: any) {
      toast({ title: "Cancel failed", description: e?.message, variant: "destructive" });
    }
  }, [toast]);

  const onRetry = useCallback(async (id: string) => {
    try {
      await getSyncEngine().retryMutation(id);
      toast({ title: "Retrying…" });
    } catch (e: any) {
      toast({ title: "Retry failed", description: e?.message, variant: "destructive" });
    }
  }, [toast]);

  const groups = useMemo(() => {
    const failed: QueuedMutation[] = [];
    const inflight: QueuedMutation[] = [];
    const completed: QueuedMutation[] = [];
    for (const m of snap.mutations) {
      if (m.status === "failed") failed.push(m);
      else if (m.status === "completed") completed.push(m);
      else inflight.push(m);
    }
    failed.sort((a, b) => b.createdAt - a.createdAt);
    inflight.sort((a, b) => a.createdAt - b.createdAt);
    completed.sort((a, b) => b.createdAt - a.createdAt);
    return { failed, inflight, completed: completed.slice(0, 20) };
  }, [snap.mutations]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[80vh] overflow-y-auto"
        data-testid="queue-view"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <CloudOff className="w-5 h-5" />
            Sync queue
            <span className="text-xs font-normal text-gray-500 ml-2">
              {snap.online ? "Online" : "Offline"} · {snap.pending + snap.syncing} in flight · {snap.failed} failed
            </span>
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-4 py-4">
          {snap.mutations.length === 0 && (
            <div className="text-sm text-gray-500 text-center py-6" data-testid="queue-empty">
              No queued changes — everything is in sync.
            </div>
          )}
          {groups.failed.length > 0 && (
            <section data-testid="queue-section-failed">
              <div className="text-xs uppercase tracking-wide text-red-700 mb-2">Failed ({groups.failed.length})</div>
              <div className="space-y-2">
                {groups.failed.map((m) => (
                  <MutationRow key={m.id} m={m} onCancel={onCancel} onRetry={onRetry} />
                ))}
              </div>
            </section>
          )}
          {groups.inflight.length > 0 && (
            <section data-testid="queue-section-inflight">
              <div className="text-xs uppercase tracking-wide text-gray-600 mb-2">
                Syncing ({groups.inflight.length})
              </div>
              <div className="space-y-2">
                {groups.inflight.map((m) => (
                  <MutationRow key={m.id} m={m} onCancel={onCancel} onRetry={onRetry} />
                ))}
              </div>
            </section>
          )}
          {groups.completed.length > 0 && (
            <section data-testid="queue-section-completed">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                Recently completed
              </div>
              <div className="space-y-2">
                {groups.completed.map((m) => (
                  <MutationRow key={m.id} m={m} onCancel={onCancel} onRetry={onRetry} />
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Wrapper used by the wet check page header ───────────────────────────────

export function OfflineSyncUI() {
  const [open, setOpen] = useState(false);
  if (!isOfflineSyncUIEnabled()) return null;
  if (!isOfflineQueueEnabled()) return null;
  return (
    <div className="inline-flex items-center gap-2" data-testid="offline-sync-ui">
      <SyncBadge onOpenQueue={() => setOpen(true)} />
      <PhotoUploadProgress />
      <QueueView open={open} onOpenChange={setOpen} />
    </div>
  );
}
