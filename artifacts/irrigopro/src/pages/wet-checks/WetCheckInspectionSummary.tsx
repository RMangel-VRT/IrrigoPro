import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Loader2, ChevronLeft, CheckCircle2, AlertTriangle, Cloud, FileText,
  Camera, Wrench,
} from "lucide-react";
import { apiRequest, asArray, queryClient, useArrayQuery } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cachedApiRequest } from "@/lib/offline/api";
import { PropertyContextHeader } from "./PropertyContextHeader";
import { ZoneStatusGrid, type ZoneRecordWithFindings } from "./ZoneStatusGrid";
import type {
  WetCheckWithDetails,
  WetCheckFinding,
} from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";

// ─── Single finding row ────────────────────────────────────────────────────────

function FindingRow({ finding: f }: { finding: WetCheckFinding }) {
  // Prefer techDisposition (the field's own self-reported intent) over resolution.
  // Fall back to resolution for legacy rows where techDisposition was never set.
  const isComplete =
    f.techDisposition != null
      ? f.techDisposition === "completed_in_field"
      : f.resolution === "repaired_in_field";
  return (
    <div
      className="flex items-start gap-2 text-xs py-1"
      data-testid={`finding-row-${f.id}`}
    >
      {isComplete ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 mt-0.5 flex-shrink-0" />
      ) : (
        <Wrench className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-800">
          {f.issueType.replace(/_/g, " ")}
        </span>
        {f.partName && (
          <span className="text-gray-500">
            {" · "}{f.partName} × {Number(f.quantity ?? 1)}
          </span>
        )}
        {f.notes && (
          <div className="text-gray-500 truncate mt-0.5">{f.notes}</div>
        )}
      </div>
      <Badge
        variant={isComplete ? "default" : "secondary"}
        className="text-[10px] shrink-0"
      >
        {isComplete ? "Completed" : "Pending review"}
      </Badge>
    </div>
  );
}

// ─── Findings grouped by controller → zone ────────────────────────────────────

function FindingsSummary({
  zoneRecords,
  controllers,
}: {
  zoneRecords: ZoneRecordWithFindings[];
  controllers: CustomerController[];
}) {
  const allFindings = zoneRecords.flatMap((z) => asArray(z.findings));
  // Use techDisposition (the field's self-reported intent) as the primary signal,
  // falling back to resolution for legacy rows where techDisposition is null.
  const completedCount = allFindings.filter(
    (f) =>
      f.techDisposition != null
        ? f.techDisposition === "completed_in_field"
        : f.resolution === "repaired_in_field",
  ).length;
  const pendingCount = allFindings.filter(
    (f) =>
      f.techDisposition != null
        ? f.techDisposition !== "completed_in_field"
        : f.resolution === "pending",
  ).length;

  const controllerOrder = controllers.map((c) => c.controllerLetter);
  const grouped = zoneRecords
    .filter((z) => asArray(z.findings).length > 0)
    .slice()
    .sort((a, b) => {
      const ai = controllerOrder.indexOf(a.controllerLetter);
      const bi = controllerOrder.indexOf(b.controllerLetter);
      if (ai !== bi) return ai - bi;
      return a.zoneNumber - b.zoneNumber;
    });

  if (allFindings.length === 0) {
    return (
      <div className="text-sm text-gray-500 text-center py-3">
        No findings recorded.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="findings-summary">
      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <span
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-600 text-white"
          data-testid="findings-chip-completed"
        >
          <CheckCircle2 className="w-3 h-3" />
          {completedCount} Completed in field
        </span>
        <span
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500 text-white"
          data-testid="findings-chip-pending"
        >
          <Wrench className="w-3 h-3" />
          {pendingCount} Pending review
        </span>
      </div>

      {/* Per-zone groups */}
      {grouped.map((zr) => (
        <div
          key={`${zr.controllerLetter}-${zr.zoneNumber}`}
          className="border rounded-lg overflow-hidden"
          data-testid={`findings-zone-group-${zr.controllerLetter}${zr.zoneNumber}`}
        >
          <div className="bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600 uppercase tracking-wide border-b">
            Zone {zr.controllerLetter}{zr.zoneNumber}
          </div>
          <div className="px-3 py-1 divide-y divide-gray-100">
            {asArray(zr.findings).map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Weather & notes inline editor ────────────────────────────────────────────

function WeatherNotesCard({
  wetCheckId,
  initialWeather,
  initialNotes,
}: {
  wetCheckId: number;
  initialWeather: string | null;
  initialNotes: string | null;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [weather, setWeather] = useState(initialWeather ?? "");
  const [notes, setNotes] = useState(initialNotes ?? "");

  const patchMut = useMutation({
    mutationFn: () =>
      apiRequest(`/api/wet-checks/${wetCheckId}`, "PATCH", { weather, notes }),
    onSuccess: () => {
      toast({ title: "Updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
      setEditing(false);
    },
    onError: (e: any) =>
      toast({
        title: "Failed to save",
        description: e?.message,
        variant: "destructive",
      }),
  });

  if (!editing) {
    return (
      <Card data-testid="weather-notes-card">
        <CardContent className="py-3 px-4">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1.5 text-sm flex-1 min-w-0">
              <div className="flex items-center gap-2 text-gray-700">
                <Cloud className="w-4 h-4 text-gray-400 flex-shrink-0" />
                {weather ? (
                  <span>{weather}</span>
                ) : (
                  <span className="text-gray-400 italic">No weather recorded</span>
                )}
              </div>
              <div className="flex items-start gap-2 text-gray-700">
                <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                {notes ? (
                  <span className="whitespace-pre-wrap">{notes}</span>
                ) : (
                  <span className="text-gray-400 italic">No notes recorded</span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-blue-600 hover:underline shrink-0 mt-0.5"
              data-testid="weather-notes-edit-btn"
            >
              Edit
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="weather-notes-edit-card">
      <CardContent className="py-3 px-4 space-y-3">
        <div>
          <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Weather
          </label>
          <Input
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
            placeholder="e.g. Sunny, 72°F"
            className="mt-1 h-10 text-sm"
            data-testid="weather-input"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Notes
          </label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Job-level notes…"
            className="mt-1 text-sm"
            data-testid="notes-input"
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => {
              setWeather(initialWeather ?? "");
              setNotes(initialNotes ?? "");
              setEditing(false);
            }}
            disabled={patchMut.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={() => patchMut.mutate()}
            disabled={patchMut.isPending}
            data-testid="weather-notes-save-btn"
          >
            {patchMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function WetCheckInspectionSummary({ id }: { id: number }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Read return-zone context injected by WetCheckDetail's goToNextUncheckedOrOverview.
  // These let "Keep Editing" drop the tech back on the exact zone they just finished
  // instead of landing on the top-level controller grid.
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const returnController = searchParams.get("returnController");
  const returnZoneRaw = searchParams.get("returnZone");
  const returnZone = returnZoneRaw ? parseInt(returnZoneRaw, 10) : null;

  // Build a URL that drops the tech back on the specific zone when possible.
  const keepEditingHref =
    returnController && returnZone && !isNaN(returnZone)
      ? `/wet-checks/${id}?controller=${returnController}&zone=${returnZone}`
      : `/wet-checks/${id}`;

  const { data: wc, isLoading } = useQuery<WetCheckWithDetails>({
    queryKey: ["/api/wet-checks", id],
    queryFn: () => apiRequest(`/api/wet-checks/${id}`),
    enabled: !isNaN(id) && id > 0,
  });

  const { data: controllers = [] } = useArrayQuery<CustomerController>({
    queryKey: ["/api/properties", wc?.customerId, "controllers"],
    queryFn: () => cachedApiRequest(`/api/properties/${wc!.customerId}/controllers`),
    enabled: !!wc?.customerId,
  });

  const submitMut = useMutation({
    mutationFn: (): Promise<{
      billingSheetId?: number | null;
      autoBilledCount?: number;
      pendingCount?: number;
    }> => apiRequest(`/api/wet-checks/${id}/submit`, "POST", {}),
    onSuccess: (res) => {
      const parts: string[] = [];
      if ((res.autoBilledCount ?? 0) > 0) {
        parts.push(
          `${res.autoBilledCount} finding(s) auto-billed${
            res.billingSheetId ? ` (BS #${res.billingSheetId})` : ""
          }`,
        );
      }
      if ((res.pendingCount ?? 0) > 0) {
        parts.push(`${res.pendingCount} pending → manager`);
      }
      if ((res.pendingCount ?? 0) === 0 && (res.autoBilledCount ?? 0) === 0) {
        parts.push("No findings to bill");
      }
      toast({ title: "Submitted", description: parts.join(" · ") });
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks"] });
      // Redirect to Customer Hub for this customer
      navigate(`/wet-checks/c/${wc!.customerId}`);
    },
    onError: (e: any) => {
      const raw = typeof e?.message === "string" ? e.message : "";
      const m = raw.match(/^\d{3}:\s*(.*)$/s);
      const tail = m ? m[1] : raw;
      let description = tail;
      try {
        const parsed = JSON.parse(tail);
        if (parsed && typeof parsed.message === "string") description = parsed.message;
      } catch { /* not JSON */ }
      toast({ title: "Failed to submit", description, variant: "destructive" });
    },
  });

  if (isLoading || !wc) {
    return (
      <div className="flex justify-center py-10" data-testid="summary-loading">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const wcZoneRecords = asArray(wc.zoneRecords) as ZoneRecordWithFindings[];
  const wcPhotos = asArray(wc.photos);
  const allFindings = wcZoneRecords.flatMap((z) => asArray(z.findings));

  // Zone status counts relative to the full controller definition so that
  // zones with no record (never visited) count as not_checked.
  let checkedOk = 0, checkedIssues = 0, notApplicable = 0;
  const totalZoneCount = controllers.reduce((n, c) => n + (c.zoneCount ?? 0), 0);

  const recordMap = new Map(
    wcZoneRecords.map((r) => [`${r.controllerLetter}-${r.zoneNumber}`, r]),
  );
  for (const ctrl of controllers) {
    for (let z = 1; z <= (ctrl.zoneCount ?? 0); z++) {
      const r = recordMap.get(`${ctrl.controllerLetter}-${z}`);
      if (!r || r.status === "not_checked") continue;
      if (r.status === "checked_ok") checkedOk++;
      else if (r.status === "checked_with_issues") checkedIssues++;
      else if (r.status === "not_applicable") notApplicable++;
    }
  }
  const totalChecked = checkedOk + checkedIssues + notApplicable;
  const uncheckedCount = totalZoneCount - totalChecked;

  // Labor totals per task spec: "inspection + all repair hours summed".
  // wc.totalLaborHours = job-level inspection overhead (travel, setup, etc.)
  // zone.repairLaborHours = per-zone repair labor logged by the tech
  // Per-finding laborHours are excluded: they represent issue-level estimates
  // used for billing, not the authoritative time the tech spent on site.
  const inspectionLaborHours = parseFloat(wc.totalLaborHours ?? "0") || 0;
  const repairLaborHours = wcZoneRecords.reduce(
    (sum, z) => sum + (parseFloat((z as any).repairLaborHours ?? "0") || 0),
    0,
  );
  const totalLaborHours = inspectionLaborHours + repairLaborHours;

  const isReadOnly = wc.status !== "in_progress";

  // Tapping a zone cell returns the tech to that zone's screen in WetCheckDetail
  const handleCellClick = (letter: string, zone: number) => {
    navigate(`/wet-checks/${id}?controller=${letter}&zone=${zone}`);
  };

  return (
    <div className="max-w-3xl mx-auto py-4 space-y-4 px-3 sm:px-4 pb-nav-safe">
      <PropertyContextHeader
        customerName={wc.customerName}
        propertyAddress={wc.propertyAddress}
      />

      {/* Page header with Keep Editing back link */}
      <div className="flex items-center justify-between gap-2">
        <Link
          href={keepEditingHref}
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
          data-testid="btn-keep-editing-top"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Keep Editing
        </Link>
        <h1 className="text-base font-semibold text-gray-800">
          Inspection Summary
        </h1>
      </div>

      {/* Non-blocking unchecked-zone warning banner */}
      {uncheckedCount > 0 && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900"
          data-testid="unchecked-zones-warning"
          role="alert"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
          <span>
            <span className="font-semibold">
              {uncheckedCount} zone{uncheckedCount === 1 ? "" : "s"} not checked
            </span>
            {" "}— are you sure you want to submit?
          </span>
        </div>
      )}

      {/* ── Zone grid ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Zone Overview</CardTitle>
          {/* Legend chips */}
          <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500 text-white font-semibold">
              ✓ OK · {checkedOk}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white font-semibold">
              ! Needs work · {checkedIssues}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-400 text-white font-semibold">
              N/A · {notApplicable}
            </span>
            {uncheckedCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border-2 border-amber-400 text-amber-700 font-semibold">
                <AlertTriangle className="w-3 h-3" />
                Skipped · {uncheckedCount}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {controllers.length === 0 ? (
            <div className="text-sm text-gray-400 py-4 text-center">
              Loading controllers…
            </div>
          ) : (
            <ZoneStatusGrid
              controllers={controllers}
              zoneRecords={wcZoneRecords}
              onCellClick={handleCellClick}
            />
          )}
        </CardContent>
      </Card>

      {/* ── Findings summary ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Findings</CardTitle>
        </CardHeader>
        <CardContent>
          <FindingsSummary
            zoneRecords={wcZoneRecords}
            controllers={controllers}
          />
        </CardContent>
      </Card>

      {/* ── Job totals ── */}
      <Card data-testid="job-totals-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Job Totals</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-3 text-center text-sm">
            <div>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">Labor Hours</dt>
              <dd
                className="text-2xl font-bold text-gray-900 mt-1"
                data-testid="total-labor-hours"
              >
                {totalLaborHours % 1 === 0
                  ? totalLaborHours.toFixed(0)
                  : totalLaborHours.toFixed(2)}
              </dd>
              {repairLaborHours > 0 && (
                <dd className="text-[10px] text-gray-400 mt-0.5 leading-tight">
                  {inspectionLaborHours > 0 && `${inspectionLaborHours.toFixed(2)} inspection`}
                  {repairLaborHours > 0 && (
                    <>{inspectionLaborHours > 0 ? " + " : ""}{repairLaborHours.toFixed(2)} repair</>
                  )}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">Zones Checked</dt>
              <dd
                className="text-2xl font-bold text-gray-900 mt-1"
                data-testid="total-zones-checked"
              >
                {totalChecked}
                <span className="text-sm font-normal text-gray-400"> / {totalZoneCount}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">Findings</dt>
              <dd
                className="text-2xl font-bold text-gray-900 mt-1"
                data-testid="total-findings"
              >
                {allFindings.length}
              </dd>
            </div>
          </dl>

          {wcPhotos.length > 0 && (
            <div
              className="mt-4 pt-3 border-t flex items-center gap-2 text-sm text-gray-600"
              data-testid="photo-count-row"
            >
              <Camera className="w-4 h-4 text-gray-400" />
              {wcPhotos.length} photo{wcPhotos.length === 1 ? "" : "s"} attached
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Weather & notes ── */}
      <div>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Weather &amp; Notes
        </h2>
        <WeatherNotesCard
          wetCheckId={id}
          initialWeather={wc.weather ?? null}
          initialNotes={wc.notes ?? null}
        />
      </div>

      {/* ── Submit CTA ── */}
      <div className="pt-2 space-y-3">
        {!isReadOnly ? (
          <>
            <Button
              className="w-full min-h-[52px] text-base"
              size="lg"
              onClick={() => submitMut.mutate()}
              disabled={submitMut.isPending}
              data-testid="btn-submit-for-review"
            >
              {submitMut.isPending ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                "Submit for Review"
              )}
            </Button>
            <Link
              href={keepEditingHref}
              className="block text-center text-sm text-gray-500 hover:text-gray-800 py-2"
              data-testid="link-keep-editing-bottom"
            >
              ← Keep Editing
            </Link>
          </>
        ) : (
          <div
            className="text-center text-sm text-gray-500 border rounded p-3 bg-gray-50"
            data-testid="already-submitted-note"
          >
            This wet check has already been submitted (status: {wc.status}).
          </div>
        )}
      </div>
    </div>
  );
}
