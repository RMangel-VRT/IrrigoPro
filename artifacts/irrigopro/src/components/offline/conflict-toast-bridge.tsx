// Slice 4D — Surface engine conflict (409) and persistent error (4xx)
// events as non-blocking toasts. Mounted once near the app root so
// conflicts triggered on any page are visible to the field tech without
// the page having to subscribe.
//
// Behaviour vs. the original 4B bridge:
//   • Gated behind the OFFLINE_SYNC_UI flag so flipping the UI off
//     hides the toasts (the engine still drains in the background).
//   • Conflict toast is non-blocking and includes a "View what they
//     did" action — it navigates to /wet-checks/:id and invalidates
//     the cached query so the latest server-wins data renders.
//   • Per-mutation dedupe: each mutationId only toasts once.
import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { queryClient } from "@/lib/queryClient";
import {
  getSyncEngine,
  isOfflineQueueEnabled,
  isOfflineSyncUIEnabled,
} from "@/lib/offline/engine";
import type { EngineEvent, QueuedMutationKind } from "@/lib/offline/types";

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

// Task #469 — recognize HTML / non-JSON error bodies so the toast can show
// a friendly retry-style message instead of dumping raw markup.
function isHtmlErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const head = msg.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<")) return true;
  if (head.startsWith("edge_")) return true;
  return false;
}

export function ConflictToastBridge() {
  const { toast } = useToast();
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isOfflineQueueEnabled()) return;
    if (!isOfflineSyncUIEnabled()) return;
    const engine = getSyncEngine();
    const seen = seenRef.current;
    const off = engine.on((e: EngineEvent) => {
      if (e.type === "conflict") {
        if (seen.has(e.mutationId)) return;
        seen.add(e.mutationId);
        console.warn(
          "[offline-engine] conflict",
          { mutationId: e.mutationId, kind: e.kind, wetCheckId: e.wetCheckId, message: e.message },
        );
        const wcId = e.wetCheckId;
        toast({
          title: "Someone else changed this first",
          description: e.message
            ? `${e.kind}: server kept its version. ${e.message.slice(0, 160)}`
            : `${e.kind}: server kept its version.`,
          duration: 12_000,
          action: wcId
            ? (
              <ToastAction
                altText="View what they did"
                onClick={() => {
                  // Refresh the wet check from server-wins mirror and
                  // navigate the user to it. Using window.location keeps
                  // this bridge router-agnostic.
                  queryClient.invalidateQueries({ queryKey: ["/api/wet-checks"] });
                  if (typeof window !== "undefined") {
                    const target = `/wet-checks/${wcId}`;
                    if (window.location.pathname !== target) {
                      window.location.assign(target);
                    }
                  }
                }}
              >
                View what they did
              </ToastAction>
            )
            : undefined,
        });
      } else if (e.type === "error") {
        if (seen.has(`err:${e.mutationId}`)) return;
        seen.add(`err:${e.mutationId}`);
        console.warn(
          "[offline-engine] mutation failed",
          { mutationId: e.mutationId, kind: e.kind, status: e.status, message: e.message },
        );
        // Task #469 — if the error body is HTML or otherwise doesn't parse
        // as JSON, it almost certainly came from an upstream/edge layer
        // rather than our API. The engine already keeps these mutations
        // pending and retries them, but if one slips through (or a future
        // 4xx code path treats it as failed) show a friendly retry-style
        // message instead of dumping raw HTML at the field tech.
        const looksLikeHtml = isHtmlErrorMessage(e.message);
        if (e.kind === "work_order.complete") {
          toast({
            title: "Work order completion needs attention",
            description: e.message.slice(0, 240),
            variant: "destructive",
            duration: 12_000,
          });
        } else if (looksLikeHtml) {
          toast({
            title: "Couldn't reach server — will retry",
            description: kindLabel(e.kind),
            duration: 8_000,
          });
        } else {
          toast({
            title: "Sync failed",
            description: `${kindLabel(e.kind)} (${e.status ?? "?"}): ${(e.message ?? "").slice(0, 200)}`,
            variant: "destructive",
            duration: 12_000,
          });
        }
      }
    });
    return () => { off(); };
  }, [toast]);
  return null;
}
