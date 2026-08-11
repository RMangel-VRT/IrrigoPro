import { useEffect, useRef, useState } from "react";
import { ActivityTab } from "@/components/activity/ActivityTab";
import { useLocation, Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, ChevronLeft, CheckCircle2, Wrench, AlertTriangle, Camera, Download, Droplets, Send, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { countZonePhotos } from "@/lib/wet-check-photos";
import { apiRequest, asArray, queryClient, useArrayQuery, authedPdfUrl } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { OfflineStrip, OfflineSyncUI } from "@/components/offline/sync-ui";
import {
  isProbablyOffline,
  submitWetCheck as offlineSubmitWetCheck,
  warmWetCheckMirror,
  readWetCheckFromMirror,
  readWetCheckByClientId,
  cachedApiRequest,
  hasPendingMutationsForWetCheck,
} from "@/lib/offline/api";
import { isOfflineQueueEnabled } from "@/lib/offline/engine";
import type { WetCheckWithDetails } from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";
import { buildWetCheckCsv, downloadCsv, wetCheckCsvFilename } from "@/lib/wet-check-csv";
import { PropertyContextHeader } from "./PropertyContextHeader";
import { PhotoCaptureButton } from "./PhotoCaptureButton";
import { PhotoThumb } from "./PhotoThumb";
import { ControllerHeader } from "./ControllerHeader";
import { ZoneScreen } from "./ZoneScreen";
import { ZoneOverviewSheet } from "./ZoneOverviewSheet";
import { FindingsByResolution } from "./FindingsByResolution";
import { LoosePhotosSection } from "./LoosePhotosSection";

// ─── Detail page ──────────────────────────────────────────────────────────────

export function WetCheckDetail({ id, clientId: routeClientId }: { id?: number; clientId?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Read URL search params once at init so state can be seeded from them.
  // Slice 3 passes ?controller=A&zone=1 after creating zone records so the
  // tech lands directly on the first zone rather than the controller grid.
  const _searchParams = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const _initController = _searchParams.get("controller") ?? null;
  const _initZoneRaw = _searchParams.get("zone");
  const _initZone = _initZoneRaw ? parseInt(_initZoneRaw, 10) : null;

  const [activeLetter, setActiveLetter] = useState<string | null>(_initController);

  // Back-link: show "← Back to Wet Check Billings" when navigated from that page
  const fromParam = _searchParams.get("from") ?? "";
  const [activeZone, setActiveZone] = useState<number | null>(
    _initZone != null && !isNaN(_initZone) ? _initZone : null,
  );

  // Zone overview sheet (open from zone screen's "View All" button)
  const [overviewOpen, setOverviewOpen] = useState(false);

  const { data: wc, isLoading } = useQuery<WetCheckWithDetails>({
    queryKey: id != null ? ["/api/wet-checks", id] : ["/api/wet-checks", "c", routeClientId],
    // Mirror-first when offline (or when only clientId is known, i.e. a
    // wet check that was created offline and has no server id yet) so a
    // tech who reloads the page mid-capture still sees their queued state.
    // Online path warms the mirror so the next offline reload has fresh data.
    queryFn: async () => {
      // Pure-offline (no server id yet) path: read from mirror by clientId.
      if (id == null && routeClientId) {
        const cached = await readWetCheckByClientId(routeClientId);
        if (!cached) throw new Error("Wet check not yet synced — open it from the list when you're back online.");
        return cached as WetCheckWithDetails;
      }
      // IDB-first: when the offline queue is enabled, return the mirror
      // immediately if we have one and refresh from the network in the
      // background. The background refresh re-warms the mirror and triggers
      // a query invalidation so the UI updates without blocking the tech.
      if (isOfflineQueueEnabled()) {
        const cached = await readWetCheckFromMirror(id!);
        if (cached) {
          if (!isProbablyOffline()) {
            // Task #512 — skip the background refresh while local edits
            // for this wet check are still queued. Otherwise a stale
            // server snapshot (e.g. zone still `checked_with_issues`)
            // can clobber an optimistic Needs Work → Ran OK flip the
            // tech just made, leaving the controller-grid tile red even
            // though the local mirror + queue already say `checked_ok`.
            void hasPendingMutationsForWetCheck(cached?.clientId ?? "")
              .then((pending) => {
                if (pending) return;
                return apiRequest(`/api/wet-checks/${id}`)
                  .then((fresh) => warmWetCheckMirror(null, id!, fresh).then(() => {
                    queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", id] });
                  }));
              })
              .catch(() => { /* ignore — heartbeat will recover */ });
          }
          return cached as WetCheckWithDetails;
        }
        // No mirror row yet — fall through to a blocking fetch and warm.
        if (isProbablyOffline()) {
          throw new Error("Wet check not cached locally — reconnect to load it.");
        }
      }
      const fresh = await apiRequest(`/api/wet-checks/${id}`);
      if (isOfflineQueueEnabled()) {
        try { await warmWetCheckMirror(null, id!, fresh); } catch {}
      }
      return fresh;
    },
  });

  const { data: controllers = [] } = useArrayQuery<CustomerController>({
    queryKey: ["/api/properties", wc?.customerId, "controllers"],
    queryFn: () => cachedApiRequest(`/api/properties/${wc!.customerId}/controllers`),
    enabled: !!wc?.customerId,
  });

  // Submit-confirm modal pulls a server-computed preview of what will be
  // auto-billed vs. left for the manager queue, so the tech sees exact
  // dollars before committing. The same preview shape is returned by
  // /submit so the success toast can echo what actually happened.
  type SubmitPreview = {
    autoBillEnabled: boolean;
    autoBilledCount: number;
    autoBilledPartsTotal: string;
    autoBilledLaborTotal: string;
    autoBilledGrandTotal: string;
    pendingCount: number;
    pendingByGroup: { quick_fix: number; advanced: number; zone_issue: number };
  };
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<SubmitPreview | null>(null);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [sendReportOpen, setSendReportOpen] = useState(false);
  const [sendReportEmail, setSendReportEmail] = useState("");
  const [sendReportNote, setSendReportNote] = useState("");
  const { user: authUser } = useAuth();

  // Manager-tier roles that may download/send the customer report
  const canSeeCustomerReport = (
    authUser?.role === "irrigation_manager" ||
    authUser?.role === "company_admin" ||
    authUser?.role === "super_admin" ||
    authUser?.role === "billing_manager"
  );

  const { data: wcCustomer } = useQuery<import("@workspace/db/schema").Customer>({
    queryKey: ["/api/customers", wc?.customerId],
    queryFn: () => apiRequest(`/api/customers/${wc!.customerId}`),
    enabled: !!wc?.customerId && canSeeCustomerReport,
    staleTime: 5 * 60 * 1000,
  });

  // Slice 3 — server-authoritative WET_CHECK_AUTO_BILL flag. When OFF,
  // the field UI must fall back to the Slice 2 plain-submit flow (no
  // preview modal, no chip rail, no auto-bill messaging).
  const { data: autoBillCfg } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/config/wet-check-auto-bill"],
    staleTime: 5 * 60 * 1000,
  });
  const autoBillEnabled = autoBillCfg?.enabled ?? true;

  const sendReportMut = useMutation({
    mutationFn: ({ to, note }: { to: string; note: string }) =>
      apiRequest(`/api/wet-checks/${wc?.id ?? id}/report/send`, "POST", { to: to || undefined, note: note || undefined }),
    onSuccess: (_res, vars) => {
      toast({ title: "Report sent", description: `Inspection report emailed to ${vars.to || "customer"}.` });
      setSendReportOpen(false);
      setSendReportEmail("");
      setSendReportNote("");
    },
    onError: (e: any) =>
      toast({ title: "Couldn't send report", description: e?.message, variant: "destructive" }),
  });

  const previewMut = useMutation({
    mutationFn: (): Promise<SubmitPreview> =>
      apiRequest(`/api/wet-checks/${id}/submit-preview`, "POST", {}),
    onSuccess: (p) => {
      setPreview(p);
      setConfirmOpen(true);
    },
    onError: (e: any) =>
      toast({ title: "Could not preview submit", description: e?.message, variant: "destructive" }),
  });

  const submitMut = useMutation({
    mutationFn: async (): Promise<{ status?: string; billingSheetId?: number | null; autoBilledCount?: number; pendingCount?: number; queued?: boolean }> => {
      // Online path: hit the server directly so we get the auto-bill summary.
      // Offline path: queue the submit linked to this wet check by clientId
      // so the engine can dispatch it with the real id once create resolves.
      const serverId = wc?.id ?? id;
      // If we have no server id yet (e.g. opened by /c/:clientId before
      // the create has dispatched), the only safe path is to queue.
      const mustQueue = serverId == null;
      if ((mustQueue || (isOfflineQueueEnabled() && isProbablyOffline())) && wc?.clientId) {
        await offlineSubmitWetCheck(wc.clientId, serverId ?? undefined);
        return { queued: true };
      }
      return apiRequest(`/api/wet-checks/${serverId}/submit`, "POST", {});
    },
    onSuccess: (res) => {
      if (res.queued) {
        toast({
          title: "Queued offline",
          description: "Submit will run as soon as you're back online.",
        });
        setConfirmOpen(false);
        navigate("/wet-checks");
        return;
      }
      const parts: string[] = [];
      if ((res.autoBilledCount ?? 0) > 0) {
        parts.push(`${res.autoBilledCount} finding(s) auto-billed${res.billingSheetId ? ` (BS #${res.billingSheetId})` : ""}`);
      }
      if ((res.pendingCount ?? 0) > 0) parts.push(`${res.pendingCount} pending → manager`);
      if ((res.pendingCount ?? 0) === 0 && (res.autoBilledCount ?? 0) === 0) parts.push("No findings to bill");
      toast({ title: "Submitted", description: parts.join(" · ") });
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks"] });
      setConfirmOpen(false);
      navigate("/wet-checks");
    },
    onError: (e: any) => {
      // Task #600 — `apiRequest` throws `Error("<status>: <body>")` where
      // body is the raw response text. For our 4xx JSON responses that's
      // `{"message":"…"}`, so unwrap it to the instructional message
      // (e.g. "Cannot auto-bill finding 24: marked complete but has no
      // part assigned…") instead of dumping the JSON in the toast.
      const raw = typeof e?.message === "string" ? e.message : "";
      const m = raw.match(/^\d{3}:\s*(.*)$/s);
      const tail = m ? m[1] : raw;
      let description = tail;
      try {
        const parsed = JSON.parse(tail);
        if (parsed && typeof parsed.message === "string") description = parsed.message;
      } catch { /* not JSON, use tail verbatim */ }
      toast({ title: "Failed to submit", description, variant: "destructive" });
    },
  });

  // Task #561 — Hoist the "jump to next needs-decision" hooks (Task
  // #517) above the loading guard. Otherwise WetCheckDetail trips
  // React error #310 ("Rendered more hooks than during the previous
  // render") when `wc` resolves on the second render — often
  // synchronously from the IDB mirror in `isOfflineQueueEnabled()`
  // mode — and React suddenly sees five extra hooks below the early
  // return that didn't run on the first render. Derive the inputs
  // from `wc?.zoneRecords` with `asArray` + optional chaining so
  // they collapse to an empty list while `wc` is still loading.
  const needsDecisionIds = asArray(wc?.zoneRecords)
    .flatMap(z => asArray(z.findings))
    .filter(
      f =>
        f.resolution === "repaired_in_field" &&
        f.partId == null &&
        !f.noPartNeeded,
    )
    .map(f => f.id);
  const needsDecisionKey = needsDecisionIds.join(",");
  const [jumpIndex, setJumpIndex] = useState(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTargetRef = useRef<HTMLElement | null>(null);
  // Reset cycle whenever the underlying list of offenders changes so a
  // fixed finding doesn't leave a stale pointer past the end. Also
  // clear any in-flight highlight + timer so a card that just left the
  // offender set isn't stuck wearing the amber ring.
  useEffect(() => {
    setJumpIndex(0);
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    if (highlightTargetRef.current) {
      highlightTargetRef.current.classList.remove(
        "ring-2",
        "ring-amber-400",
        "ring-offset-2",
        "bg-amber-50",
        "transition",
      );
      highlightTargetRef.current = null;
    }
  }, [needsDecisionKey]);
  // Cancel any pending highlight cleanup on unmount, and clear the
  // class from any element it was applied to so we don't leave a
  // stuck ring on a card that's no longer in the offender list.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      if (highlightTargetRef.current) {
        highlightTargetRef.current.classList.remove(
          "ring-2",
          "ring-amber-400",
          "ring-offset-2",
          "bg-amber-50",
          "transition",
        );
        highlightTargetRef.current = null;
      }
    };
  }, []);

  if (isLoading || !wc) {
    return <div className="flex justify-center py-10"><Loader2 className="animate-spin" /></div>;
  }

  // Task #540 — `wc.zoneRecords` / `wc.photos` are typed as `T[]` but the
  // server can return `null` for nested array fields on freshly-created
  // records. Normalize at the top so every downstream `.map / .filter /
  // .flatMap / .length` is safe without sprinkling `?? []` everywhere.
  const wcZoneRecords = asArray(wc.zoneRecords);
  const wcPhotos = asArray(wc.photos);
  const zonesByLetter = (letter: string) =>
    wcZoneRecords.filter(z => z.controllerLetter === letter);

  const isReadOnly = wc.status !== "in_progress";

  // Drill-down: a specific zone
  if (activeLetter && activeZone) {
    const ctrl = controllers.find(c => c.controllerLetter === activeLetter);
    const zoneCount = ctrl?.zoneCount ?? 0;
    const records = zonesByLetter(activeLetter);
    const zoneRecord = records.find(z => z.zoneNumber === activeZone);

    // Flat ordered zone list across all controllers for prev/next navigation
    const allZones = controllers.flatMap(c =>
      Array.from({ length: c.zoneCount ?? 0 }, (_, i) => ({
        letter: c.controllerLetter,
        zone: i + 1,
      })),
    );
    const currentZoneIndex = allZones.findIndex(
      z => z.letter === activeLetter && z.zone === activeZone,
    );
    const totalZones = allZones.length;

    // Quick lookup: does a zone have an existing record with a checked status?
    const zoneRecordMap = new Map(
      wcZoneRecords.map(r => [`${r.controllerLetter}-${r.zoneNumber}`, r]),
    );
    const isUnchecked = (letter: string, zone: number) => {
      const r = zoneRecordMap.get(`${letter}-${zone}`);
      return !r || r.status === "not_checked";
    };

    // Globally unchecked zones (excludes the current zone being actively viewed,
    // since the tech is deciding its status right now).
    const otherUncheckedZones = allZones.filter(
      z => !(z.letter === activeLetter && z.zone === activeZone) && isUnchecked(z.letter, z.zone),
    );

    // "Review & Submit" appears when no OTHER unchecked zones exist — the current
    // zone is the last remaining one, or all zones have already been checked.
    const isLastUncheckedZone = otherUncheckedZones.length === 0;

    // Next unchecked zone to visit. Prefer zones after the current position so the
    // tech moves forward naturally; wrap around to earlier zones if none remain
    // ahead. This handles the "jumped via View All" case correctly.
    const nextUncheckedZone =
      allZones.slice(currentZoneIndex + 1).find(z => isUnchecked(z.letter, z.zone)) ??
      allZones.slice(0, currentZoneIndex).find(z => isUnchecked(z.letter, z.zone)) ??
      null;

    const navigateToZone = (letter: string, zone: number) => {
      setActiveLetter(letter);
      setActiveZone(zone);
    };

    // Prev button: previous sequential zone so techs can review prior work.
    const prevZone = currentZoneIndex > 0 ? allZones[currentZoneIndex - 1] : null;

    const goToNextUncheckedOrOverview = () => {
      if (nextUncheckedZone) {
        navigateToZone(nextUncheckedZone.letter, nextUncheckedZone.zone);
      } else {
        // All zones checked — navigate to the Slice 5 inspection summary at
        // /wet-checks/:id/review (the canonical field-tech path per task spec).
        // For irrigation_manager the /review route now also maps to
        // WetCheckInspectionSummaryPage; manager triage uses /manager/wet-checks/:id.
        // Pass the current zone as return context so "Keep Editing" can
        // drop the tech back on the exact zone they just finished.
        navigate(
          `/wet-checks/${wc.id ?? id ?? 0}/review?returnController=${activeLetter}&returnZone=${activeZone}`,
        );
      }
    };

    return (
      <>
        {/* Task #511 — `key` forces a fresh mount whenever the tech advances
            to a different zone. Remounting on `${letter}-${zone}` resets all
            per-zone local state to defaults so each zone opens as a clean slate. */}
        <ZoneScreen
          key={`zone-${activeLetter}-${activeZone}`}
          wetCheckId={wc.id ?? id ?? 0}
          wetCheckClientId={wc.clientId ?? null}
          customerId={wc.customerId}
          customerName={wc.customerName}
          propertyAddress={wc.propertyAddress}
          letter={activeLetter}
          zoneNumber={activeZone}
          zoneCount={zoneCount}
          zoneRecord={zoneRecord}
          photos={wcPhotos.filter(p =>
            p.zoneRecordId === zoneRecord?.id ||
            (p.findingId != null && asArray(zoneRecord?.findings).some(f => f.id === p.findingId))
          )}
          readOnly={isReadOnly}
          wetCheckMode={(wc.mode as "service" | "inspection") ?? "service"}
          onBack={() => setActiveZone(null)}
          // Auto-advance (Ran OK / N/A) jumps to the next unchecked zone,
          // skipping zones already marked, so the tech's flow stays fast.
          onAdvance={goToNextUncheckedOrOverview}
          currentZoneIndex={currentZoneIndex >= 0 ? currentZoneIndex : undefined}
          totalZones={totalZones}
          onNavigatePrev={
            prevZone ? () => navigateToZone(prevZone.letter, prevZone.zone) : null
          }
          // Manual Next also advances to the next unchecked zone; when none
          // remain the button reads "Review & Submit" and goes to the overview.
          onNavigateNext={goToNextUncheckedOrOverview}
          isLastZone={isLastUncheckedZone}
          onOpenOverview={() => setOverviewOpen(true)}
        />
        <ZoneOverviewSheet
          open={overviewOpen}
          onClose={() => setOverviewOpen(false)}
          controllers={controllers}
          zoneRecords={wcZoneRecords}
          activeLetter={activeLetter}
          activeZone={activeZone}
          onNavigate={navigateToZone}
          photos={wcPhotos}
        />
      </>
    );
  }

  // Drill-down: a specific controller's zone grid
  if (activeLetter) {
    const ctrl = controllers.find(c => c.controllerLetter === activeLetter);
    const records = zonesByLetter(activeLetter);
    const recordsByZone = new Map(records.map(r => [r.zoneNumber, r]));
    return (
      <div className="max-w-3xl mx-auto py-4 space-y-3 px-3 sm:px-4 pb-nav-safe">
        <PropertyContextHeader
          customerName={wc.customerName}
          propertyAddress={wc.propertyAddress}
          controllerLetter={activeLetter}
        />
        <Button variant="ghost" onClick={() => setActiveLetter(null)} data-testid="btn-back">
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Controllers
        </Button>
        <ControllerHeader
          controller={ctrl}
          customerId={wc.customerId}
          readOnly={isReadOnly}
          zoneRecords={records}
          customerName={wc.customerName}
          propertyAddress={wc.propertyAddress ?? undefined}
        />
        <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-1.5 sm:gap-1">
          {Array.from({ length: ctrl?.zoneCount ?? 0 }, (_, i) => i + 1).map(n => {
            const r = recordsByZone.get(n);
            const cls = r?.status === "checked_ok"
              ? "bg-green-500 text-white"
              : r?.status === "checked_with_issues"
              ? "bg-red-500 text-white"
              : r?.status === "not_applicable"
              ? "bg-gray-400 text-white"
              : "bg-white border border-gray-300";
            // Task #458 — overlay a check-mark on Needs Work tiles the tech
            // has explicitly marked complete, so the controller grid reads
            // as a true progress map (red = still mid-edit, red-with-check
            // = reviewed-and-confirmed).
            const isMarkedComplete =
              r?.status === "checked_with_issues" && r?.markedCompleteAt != null;
            const zonePhotoCount = countZonePhotos(wc, r);
            const findingCountForZone = asArray(r?.findings).length;
            const aria = [
              isMarkedComplete ? `Zone ${n} — Needs Work, marked complete` : `Zone ${n}`,
              zonePhotoCount > 0
                ? `, ${zonePhotoCount} photo${zonePhotoCount === 1 ? "" : "s"}`
                : "",
            ].join("");
            return (
              <button
                key={n}
                onClick={() => setActiveZone(n)}
                className={`relative aspect-square min-h-[44px] text-sm sm:text-xs font-medium rounded active:scale-95 transition-transform ${cls}`}
                data-testid={`zone-${activeLetter}-${n}`}
                data-marked-complete={isMarkedComplete ? "true" : undefined}
                aria-label={aria}
              >
                {n}
                {isMarkedComplete && (
                  <span
                    className="absolute -top-1 -right-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-white text-green-600 shadow ring-1 ring-green-600"
                    data-testid={`zone-${activeLetter}-${n}-marked-complete`}
                  >
                    <CheckCircle2 className="w-3 h-3" strokeWidth={3} />
                  </span>
                )}
                {/* Finding-count badge on needs-work tiles — bottom-left so it never
                    conflicts with the photo-count badge at bottom-right */}
                {r?.status === "checked_with_issues" && findingCountForZone > 0 && (
                  <span
                    className="absolute -bottom-1 -left-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-0.5 rounded-full bg-white text-[9px] font-bold text-red-700 shadow ring-1 ring-red-400"
                    data-testid={`zone-${activeLetter}-${n}-finding-count`}
                    aria-label={`${findingCountForZone} finding${findingCountForZone !== 1 ? "s" : ""}`}
                  >
                    {findingCountForZone}
                  </span>
                )}
                {zonePhotoCount > 0 && (
                  <span
                    className="absolute -bottom-1 -right-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-0.5 rounded-full bg-white text-[9px] font-bold text-gray-800 shadow ring-1 ring-gray-400"
                    data-testid={`zone-${activeLetter}-${n}-photo-count`}
                  >
                    <Camera className="w-2 h-2 mr-px" aria-hidden />
                    {zonePhotoCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Zone grid legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 pt-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-green-500 flex-shrink-0" />
            Ran OK
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-500 flex-shrink-0" />
            Needs work
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm bg-gray-400 flex-shrink-0" />
            N/A
          </span>
        </div>
      </div>
    );
  }

  // Top-level: controllers grid + wet-check level photos
  const wetCheckLevelPhotos = wcPhotos.filter(p => !p.zoneRecordId && !p.findingId);
  // Status chip counts so the tech sees at-a-glance what they're about to
  // submit: how many findings are already complete (will auto-bill) vs.
  // still pending a manager decision, plus skipped zones.
  const allFindings = wcZoneRecords.flatMap(z => asArray(z.findings));
  const completeCount = allFindings.filter(f => f.resolution === "repaired_in_field").length;
  const pendingFindingCount = allFindings.filter(f => f.resolution === "pending").length;
  // Task #1535 — Findings marked complete without a part are now gracefully
  // re-routed to manager review by the backend instead of blocking submit.
  // Surface them as a non-blocking informational banner so the tech is aware,
  // but do not disable the submit button.
  const completeNeedingDecision = allFindings.filter(f =>
    f.resolution === "repaired_in_field" &&
    f.partId == null &&
    !f.noPartNeeded,
  );
  // Task #517 — Tap the amber banner to jump to the next finding that
  // still needs a part / labor-only decision. The cycle index, refs,
  // and effects are hoisted above the loading guard (see Task #561)
  // so the hook order stays stable across the wc undefined → defined
  // transition; only the click handler stays here.
  const jumpToNextNeedsDecision = () => {
    if (needsDecisionIds.length === 0) return;
    const idx = jumpIndex % needsDecisionIds.length;
    const targetId = needsDecisionIds[idx];
    // The offending findings are rendered above the banner inside the
    // FindingsByResolution "Complete" group as
    // `group-complete-row-${id}` rows. Those are the only per-finding
    // anchors present on the wet check submit screen.
    const el = document.querySelector<HTMLElement>(
      `[data-testid="group-complete-row-${targetId}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Clear any prior highlight first so a quick re-tap doesn't leave
      // a stuck ring on a previous, unrelated card.
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      if (highlightTargetRef.current && highlightTargetRef.current !== el) {
        highlightTargetRef.current.classList.remove(
          "ring-2",
          "ring-amber-400",
          "ring-offset-2",
          "bg-amber-50",
          "transition",
        );
      }
      el.classList.add(
        "ring-2",
        "ring-amber-400",
        "ring-offset-2",
        "bg-amber-50",
        "transition",
      );
      highlightTargetRef.current = el;
      highlightTimerRef.current = setTimeout(() => {
        el.classList.remove(
          "ring-2",
          "ring-amber-400",
          "ring-offset-2",
          "bg-amber-50",
          "transition",
        );
        if (highlightTargetRef.current === el) {
          highlightTargetRef.current = null;
        }
        highlightTimerRef.current = null;
      }, 1500);
    }
    setJumpIndex(idx + 1);
  };
  const naCount = wcZoneRecords.filter(z => z.status === "not_applicable").length;
  // Task #428 — submit CTA copy + intent counts. Disposition is the tech's
  // self-reported intent and is decoupled from `resolution` (which carries
  // billing/routing semantics).
  const dispositionCompleted = allFindings.filter(f => f.techDisposition === "completed_in_field").length;
  const dispositionNeedsReview = allFindings.filter(f => f.techDisposition !== "completed_in_field").length;
  const submitCtaLabel =
    allFindings.length === 0
      ? "Submit — no issues found"
      : dispositionNeedsReview === 0
        ? "Submit — all work completed"
        : "Submit for manager review";
  return (
    <div className="max-w-3xl mx-auto py-4 space-y-4 px-3 sm:px-4 pb-nav-safe">
      <PropertyContextHeader
        customerName={wc.customerName}
        propertyAddress={wc.propertyAddress}
      />
      <OfflineStrip />
      {fromParam === "wet-check-billings" && (
        <Link
          href="/wet-check-billings"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Back to Wet Check Billings
        </Link>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => navigate(wc.customerId ? `/wet-checks/c/${wc.customerId}` : "/wet-checks")}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back to Customer
        </Button>
        <div className="flex items-center gap-2">
          {typeof wc.id === "number" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadCsv(buildWetCheckCsv(wc), wetCheckCsvFilename(wc))}
              >
                <Download className="w-4 h-4 mr-1" /> Export CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isDownloadingPdf}
                data-testid="wet-check-download-pdf"
                onClick={async () => {
                  if (isDownloadingPdf) return;
                  setIsDownloadingPdf(true);
                  try {
                    const url = authedPdfUrl(`/api/wet-checks/${wc.id}/pdf`, { download: "1" });
                    const res = await fetch(url, { credentials: "include" });
                    if (!res.ok) {
                      let msg = `Failed (${res.status})`;
                      try {
                        const ct = res.headers.get("content-type") ?? "";
                        if (ct.includes("application/json")) {
                          const j = await res.json();
                          if (j?.message) msg = j.message;
                        } else {
                          const t = await res.text();
                          if (t) msg = t;
                        }
                      } catch { /* ignore */ }
                      throw new Error(msg);
                    }
                    const blob = await res.blob();
                    const objUrl = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = objUrl;
                    const date = wc.startedAt
                      ? new Date(wc.startedAt).toISOString().slice(0, 10)
                      : "unknown";
                    const safeName = (wc.customerName ?? "")
                      .replace(/[/\\:*?"<>|]/g, " ")
                      .replace(/\s+/g, " ")
                      .trim();
                    a.download = safeName
                      ? `${safeName} - Wet Check ${wc.id} - ${date}.pdf`
                      : `wet-check-${wc.id}-${date}.pdf`;
                    a.rel = "noopener";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
                  } catch (err) {
                    toast({
                      title: "Couldn't download PDF",
                      description: err instanceof Error ? err.message : "Please try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setIsDownloadingPdf(false);
                  }
                }}
              >
                <Download className="w-4 h-4 mr-1" />
                {isDownloadingPdf ? "Preparing..." : "Download PDF"}
              </Button>
              {canSeeCustomerReport && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isDownloadingReport}
                    data-testid="wet-check-download-report"
                    onClick={async () => {
                      if (isDownloadingReport) return;
                      setIsDownloadingReport(true);
                      try {
                        const url = authedPdfUrl(`/api/wet-checks/${wc.id}/report-pdf`, { download: "1" });
                        const res = await fetch(url, { credentials: "include" });
                        if (!res.ok) {
                          let msg = `Failed (${res.status})`;
                          try {
                            const ct = res.headers.get("content-type") ?? "";
                            if (ct.includes("application/json")) {
                              const j = await res.json();
                              if (j?.message) msg = j.message;
                            } else {
                              const t = await res.text();
                              if (t) msg = t;
                            }
                          } catch { /* ignore */ }
                          throw new Error(msg);
                        }
                        const blob = await res.blob();
                        const objUrl = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = objUrl;
                        const date = wc.startedAt
                          ? new Date(wc.startedAt).toISOString().slice(0, 10)
                          : "unknown";
                        const safeName = (wc.customerName ?? "")
                          .replace(/[/\\:*?"<>|]/g, " ")
                          .replace(/\s+/g, " ")
                          .trim();
                        a.download = safeName
                          ? `${safeName} - Inspection Report - ${date}.pdf`
                          : `inspection-report-${wc.id}-${date}.pdf`;
                        a.rel = "noopener";
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
                      } catch (err) {
                        toast({
                          title: "Couldn't download customer report",
                          description: err instanceof Error ? err.message : "Please try again.",
                          variant: "destructive",
                        });
                      } finally {
                        setIsDownloadingReport(false);
                      }
                    }}
                  >
                    <FileText className="w-4 h-4 mr-1" />
                    {isDownloadingReport ? "Preparing..." : "Customer Report"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="wet-check-send-report"
                    onClick={() => {
                      setSendReportEmail(wcCustomer?.email ?? "");
                      setSendReportNote("");
                      setSendReportOpen(true);
                    }}
                  >
                    <Send className="w-4 h-4 mr-1" />
                    Send to Customer
                  </Button>
                </>
              )}
            </>
          )}
          <OfflineSyncUI />
        </div>
      </div>
      {/* Sticky chip — keeps the complete / pending / skipped tally
          visible while the tech scrolls through controllers, so they
          always know what the submit-confirm modal will say. Tapping a
          chip scrolls to the matching findings group below the
          controllers grid. Hidden entirely when auto-billing is off so
          the Slice 2 submit experience is restored verbatim. */}
      {!isReadOnly && autoBillEnabled && (
        <div
          className="sticky top-2 z-20 -mx-3 sm:mx-0 px-3 sm:px-0 overflow-x-auto scrollbar-hide bg-white/90 backdrop-blur border-y sm:border sm:rounded py-1.5"
          data-testid="status-chip-row"
        >
          <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <button
              type="button"
              onClick={() => document.getElementById("findings-group-complete")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="min-h-[36px] inline-flex items-center"
              data-testid="chip-complete"
            >
              <Badge variant="default">✓ Complete · {completeCount}</Badge>
            </button>
            <button
              type="button"
              onClick={() => document.getElementById("findings-group-pending")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="min-h-[36px] inline-flex items-center"
              data-testid="chip-pending"
            >
              <Badge variant="secondary">Needs decision · {pendingFindingCount}</Badge>
            </button>
            <button
              type="button"
              onClick={() => document.getElementById("findings-group-na")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="min-h-[36px] inline-flex items-center"
              data-testid="chip-na"
            >
              <Badge variant="outline">N/A · {naCount}</Badge>
            </button>
          </div>
        </div>
      )}
      {/* ── Head view ─────────────────────────────────────────────────────── */}
      {(() => {
        const statusPill = (() => {
          const s = wc.status;
          if (s === "converted")
            return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 border border-emerald-300">Converted</span>;
          if (s === "submitted")
            return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700 border border-blue-300">Submitted</span>;
          if (s === "pending_manager_review")
            return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-300">Pending Review</span>;
          if (s === "in_progress")
            return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">In Progress</span>;
          return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-300">{s?.replace(/_/g, " ") ?? "—"}</span>;
        })();
        const totalZones = controllers.reduce((n, c) => n + (c.zoneCount ?? 0), 0);
        const workDate = wc.startedAt
          ? new Date(wc.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
          : null;
        return (
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden" data-testid="wc-head-view">
            <div className="px-4 pt-4 pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="flex-shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                    <Droplets className="w-4.5 h-4.5 text-blue-600" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-gray-900 leading-tight">{wc.customerName}</h2>
                    {wc.propertyAddress && (
                      <div className="text-sm text-gray-500 truncate">{wc.propertyAddress}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {statusPill}
                  {!isReadOnly && (
                    <PhotoCaptureButton
                      wetCheckId={wc.id ?? id ?? 0}
                      wetCheckClientId={wc.clientId ?? null}
                    />
                  )}
                </div>
              </div>

              {/* Meta row */}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>{controllers.length} controller{controllers.length !== 1 ? "s" : ""}</span>
                <span className="text-gray-300">·</span>
                <span>{totalZones} zone{totalZones !== 1 ? "s" : ""}</span>
                <span className="text-gray-300">·</span>
                <span
                  className="inline-flex items-center gap-0.5"
                  data-testid="wc-photo-total"
                  aria-label={`${wcPhotos.length} photo${wcPhotos.length === 1 ? "" : "s"} attached`}
                >
                  <Camera className="w-3 h-3" aria-hidden />
                  {wcPhotos.length} photo{wcPhotos.length === 1 ? "" : "s"}
                </span>
                {wc.technicianName && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>{wc.technicianName}</span>
                  </>
                )}
                {workDate && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span>{workDate}</span>
                  </>
                )}
              </div>
            </div>

            {wetCheckLevelPhotos.length > 0 && (
              <div className="px-4 pb-3 border-t border-gray-100 pt-3" data-testid="wc-photos">
                {(() => {
                  const options = wcZoneRecords.flatMap(zr =>
                    asArray(zr.findings).map(f => ({
                      id: f.id,
                      label: `${zr.controllerLetter}${zr.zoneNumber} · ${f.issueType.replace(/_/g, " ")} · ${f.partName ?? "no part"}`,
                    })),
                  );
                  return (
                    <LoosePhotosSection
                      photos={wetCheckLevelPhotos}
                      findingOptions={options}
                      wetCheckId={wc.id ?? id ?? 0}
                      readOnly={isReadOnly}
                    />
                  );
                })()}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Inspection health hero ─────────────────────────────────────────── */}
      {(() => {
        let ok = 0, issues = 0, markedComplete = 0;
        for (const zr of wcZoneRecords) {
          if (zr.status === "checked_ok") ok++;
          else if (zr.status === "checked_with_issues") {
            issues++;
            if (zr.markedCompleteAt) markedComplete++;
          }
        }
        const totalZones = controllers.reduce((n, c) => n + (c.zoneCount ?? 0), 0);
        const gray = Math.max(0, totalZones - ok - issues);
        const total = ok + issues + gray;
        const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
        const okPct = pct(ok), issuesPct = pct(issues), grayPct = pct(gray);

        return (
          <div
            className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 space-y-3"
            data-testid="wet-check-summary-counts"
            aria-label={`Wet check summary: ${ok} ran OK, ${issues} need work, ${gray} N/A`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-gray-700">Inspection Health</span>
              {issues > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200" data-testid="summary-needs-work-flag">
                  <AlertTriangle className="w-3 h-3" aria-hidden />
                  Needs work
                </span>
              )}
            </div>

            {/* Stacked health bar */}
            {total > 0 ? (
              <div className="flex h-7 rounded-lg overflow-hidden w-full gap-px" role="img" aria-label={`${okPct}% ran OK, ${issuesPct}% needs work, ${grayPct}% N/A`}>
                {ok > 0 && (
                  <div
                    className="flex items-center justify-center text-xs font-bold text-white bg-green-500 transition-all"
                    style={{ width: `${okPct}%` }}
                    data-testid="summary-ok"
                  >
                    {ok}
                  </div>
                )}
                {issues > 0 && (
                  <div
                    className="flex items-center justify-center text-xs font-bold text-white bg-red-500 transition-all"
                    style={{ width: `${issuesPct}%` }}
                    data-testid="summary-issues"
                  >
                    {issues}
                  </div>
                )}
                {gray > 0 && (
                  <div
                    className="flex items-center justify-center text-xs font-bold text-gray-500 bg-gray-100 transition-all"
                    style={{ width: `${grayPct}%` }}
                    data-testid="summary-na"
                  >
                    {gray}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-7 rounded-lg bg-gray-100 w-full" data-testid="summary-empty" />
            )}

            {/* Legend */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 flex-shrink-0" />
                Ran OK {ok} · {okPct}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500 flex-shrink-0" />
                Needs work {issues} · {issuesPct}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200 flex-shrink-0" />
                N/A {gray} · {grayPct}%
              </span>
              {markedComplete > 0 && (
                <span className="flex items-center gap-1.5" data-testid="summary-marked-complete">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-200 flex-shrink-0" />
                  Marked complete {markedComplete}
                </span>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Controller cards ──────────────────────────────────────────────── */}
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Controllers</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {controllers.map(c => {
          const recs = zonesByLetter(c.controllerLetter);
          const ok = recs.filter(r => r.status === "checked_ok").length;
          const issues = recs.filter(r => r.status === "checked_with_issues").length;
          const gray = Math.max(0, (c.zoneCount ?? 0) - ok - issues);
          const total = ok + issues + gray;
          const photoCount = recs.reduce((n, r) => n + countZonePhotos(wc, r), 0);
          const findingCount = recs.reduce((n, r) => n + asArray(r.findings).length, 0);

          // Left-edge accent: red if has needs-work, gray if no zones actively checked, green otherwise.
          // "Not inspected" means no zone has been checked_ok or checked_with_issues;
          // not_applicable / not_checked both map to gray and do not count as inspected.
          const hasAnyCheckedZone = recs.some(r => r.status === "checked_ok" || r.status === "checked_with_issues");
          const accentClass = issues > 0
            ? "border-l-red-500"
            : !hasAnyCheckedZone
            ? "border-l-gray-300"
            : "border-l-green-500";

          // Status pill
          const ctrlStatusPill = issues > 0
            ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200">{issues} need work</span>
            : !hasAnyCheckedZone
            ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">Not inspected</span>
            : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">All OK</span>;

          // Mini health bar percentages
          const okPct = total > 0 ? Math.round((ok / total) * 100) : 0;
          const issPct = total > 0 ? Math.round((issues / total) * 100) : 0;
          const grayPct = total > 0 ? Math.max(0, 100 - okPct - issPct) : 100;

          return (
            <div
              key={c.controllerLetter}
              className={`rounded-xl border-l-4 border border-gray-200 bg-white shadow-sm cursor-pointer hover:shadow-md active:scale-[0.99] transition-all overflow-hidden ${accentClass}`}
              onClick={() => setActiveLetter(c.controllerLetter)}
              data-testid={`controller-${c.controllerLetter}`}
            >
              <div className="px-4 pt-3 pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-gray-900">Controller {c.controllerLetter}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{c.zoneCount ?? 0} zones</div>
                  </div>
                  {ctrlStatusPill}
                </div>

                {/* Mini stacked health bar */}
                <div className="mt-3 flex h-2 rounded-full overflow-hidden w-full gap-px bg-gray-100">
                  {ok > 0 && <div className="bg-green-500" style={{ width: `${okPct}%` }} />}
                  {issues > 0 && <div className="bg-red-500" style={{ width: `${issPct}%` }} />}
                  {grayPct > 0 && <div className="bg-gray-200" style={{ width: `${grayPct}%` }} />}
                </div>
              </div>

              {/* Footer */}
              <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between gap-2 text-xs text-gray-500">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-0.5 text-green-700" data-testid={`controller-${c.controllerLetter}-ok`}>
                    <CheckCircle2 className="w-3 h-3" aria-hidden /> {ok}
                  </span>
                  <span
                    className="flex items-center gap-0.5 text-red-700"
                    data-testid={`controller-${c.controllerLetter}-finding-count`}
                    aria-label={`${findingCount} work item${findingCount !== 1 ? "s" : ""} on this controller`}
                  >
                    <Wrench className="w-3 h-3" aria-hidden /> {findingCount}
                  </span>
                  {photoCount > 0 && (
                    <span
                      className="flex items-center gap-0.5"
                      data-testid={`controller-${c.controllerLetter}-photo-count`}
                      aria-label={`${photoCount} photo${photoCount !== 1 ? "s" : ""} on this controller`}
                    >
                      <Camera className="w-3 h-3" aria-hidden /> {photoCount}
                    </span>
                  )}
                </div>
                <span className="text-blue-600 font-medium flex items-center gap-0.5">
                  View zones →
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {!isReadOnly && autoBillEnabled && (
        <FindingsByResolution
          findings={allFindings}
          zoneRecords={wcZoneRecords}
        />
      )}

      {!isReadOnly && completeNeedingDecision.length > 0 && (
        <button
          type="button"
          onClick={jumpToNextNeedsDecision}
          aria-label={
            completeNeedingDecision.length === 1
              ? "Jump to the finding marked complete without a part"
              : `Jump to the next of ${completeNeedingDecision.length} findings marked complete without a part`
          }
          className="block w-full text-left text-sm rounded border border-amber-300 bg-amber-50 p-3 text-amber-900 cursor-pointer hover:bg-amber-100 active:bg-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 transition-colors"
          data-testid="submit-needs-part-or-no-part-hint"
        >
          {completeNeedingDecision.length} finding{completeNeedingDecision.length === 1 ? " is" : "s are"} marked complete without a part or labor-only confirmation.
          {completeNeedingDecision.length === 1 ? "It" : "They"} will be automatically sent to manager review on submit.
          {" "}Open {completeNeedingDecision.length === 1 ? "it" : "them"} to pick a part or tick
          {" "}<span className="font-medium">No part needed (labor only)</span> if you want to bill it directly.
        </button>
      )}

      {!isReadOnly && (
        <Button
          className="w-full min-h-[48px]"
          size="lg"
          onClick={() => {
            // Flag-off → restore Slice 2 plain-submit (no preview, no
            // confirm modal). The server enforces the same gate, so
            // this is purely a UX fallback for the tech.
            if (!autoBillEnabled) {
              submitMut.mutate();
              return;
            }
            // Submit-preview is a server-only call. Skip it when offline,
            // when the offline queue flag is on without an in-band probe,
            // or when we don't yet have a server id (clientId-only route);
            // queue the submit directly so the tech can complete the
            // capture flow without connectivity.
            const noServerId = (wc?.id ?? id) == null;
            if (noServerId || isProbablyOffline()) {
              submitMut.mutate();
              return;
            }
            previewMut.mutate();
          }}
          disabled={previewMut.isPending || submitMut.isPending}
          data-testid="btn-submit-wet-check"
        >
          {(previewMut.isPending || submitMut.isPending) ? <Loader2 className="animate-spin" /> : submitCtaLabel}
        </Button>
      )}

      {/* Task #641 — Activity feed */}
      <div className="border rounded" data-testid="wet-check-activity-section">
        <div className="px-3 py-2 bg-gray-50 text-sm font-semibold border-b">
          Activity
        </div>
        <ActivityTab resource="wet-checks" id={wc?.id ?? null} />
      </div>

      {/* Send Customer Report modal */}
      <Dialog open={sendReportOpen} onOpenChange={(o) => { if (!sendReportMut.isPending) setSendReportOpen(o); }}>
        <DialogContent data-testid="send-report-dialog">
          <DialogHeader>
            <DialogTitle>Send Inspection Report to Customer</DialogTitle>
            <DialogDescription>
              A PDF condition report (zones, findings, photos — no pricing) will be emailed to the customer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="send-report-email">Recipient email</Label>
              <Input
                id="send-report-email"
                type="email"
                placeholder="customer@example.com (leave blank to use email on file)"
                value={sendReportEmail}
                onChange={e => setSendReportEmail(e.target.value)}
                data-testid="send-report-email-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-report-note">Note to customer <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                id="send-report-note"
                rows={3}
                placeholder="Add a note that appears in the email body…"
                value={sendReportNote}
                onChange={e => setSendReportNote(e.target.value)}
                data-testid="send-report-note-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSendReportOpen(false)}
              disabled={sendReportMut.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => sendReportMut.mutate({ to: sendReportEmail, note: sendReportNote })}
              disabled={sendReportMut.isPending}
              data-testid="send-report-confirm"
            >
              {sendReportMut.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              Send Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Submit-confirm modal — surfaces the server's preview of what
          will be auto-billed and what will land in the manager queue
          before the tech commits. */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o && !submitMut.isPending) setConfirmOpen(false); }}>
        <DialogContent data-testid="submit-confirm-dialog">
          <DialogHeader>
            <DialogTitle>
              {allFindings.length === 0
                ? "Submit — no issues found?"
                : dispositionNeedsReview === 0
                  ? "Submit — all work completed?"
                  : "Submit for manager review?"}
            </DialogTitle>
            <DialogDescription data-testid="submit-confirm-intent">
              {allFindings.length === 0
                ? "No findings recorded — this wet check will be marked complete."
                : dispositionNeedsReview === 0
                  ? `${dispositionCompleted} finding(s) marked completed in field.`
                  : `${dispositionNeedsReview} finding(s) flagged for manager review${dispositionCompleted > 0 ? `, ${dispositionCompleted} completed in field` : ""}.`}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              {preview.autoBillEnabled ? (
                <div className="border rounded p-3" data-testid="preview-auto-billed">
                  <div className="font-medium flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    Auto-billed now
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {preview.autoBilledCount} finding(s) marked complete · Parts ${preview.autoBilledPartsTotal} · Labor ${preview.autoBilledLaborTotal}
                  </div>
                  <div className="font-semibold mt-1" data-testid="preview-grand-total">
                    Total: ${preview.autoBilledGrandTotal}
                  </div>
                </div>
              ) : (
                <div className="border rounded p-3 bg-amber-50 border-amber-200" data-testid="preview-auto-bill-disabled">
                  <div className="font-medium flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    Auto-billing disabled
                  </div>
                  <div className="text-xs text-gray-700 mt-1">
                    All findings (including ones marked complete) will be sent to the manager queue for routing.
                  </div>
                </div>
              )}
              {preview.pendingCount > 0 && (
                <div className="border rounded p-3" data-testid="preview-pending">
                  <div className="font-medium flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-amber-600" />
                    Pending — sent to manager
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {preview.pendingCount} finding(s) need a routing decision
                  </div>
                  <div className="text-xs text-gray-600 mt-1 flex gap-3">
                    <span>Quick fix · {preview.pendingByGroup.quick_fix}</span>
                    <span>Advanced · {preview.pendingByGroup.advanced}</span>
                    <span>Zone · {preview.pendingByGroup.zone_issue}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={submitMut.isPending}
              data-testid="btn-submit-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => submitMut.mutate()}
              disabled={submitMut.isPending}
              data-testid="btn-submit-confirm"
            >
              {submitMut.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {preview && preview.autoBillEnabled && preview.autoBilledCount > 0
                ? "Submit & Bill"
                : "Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
