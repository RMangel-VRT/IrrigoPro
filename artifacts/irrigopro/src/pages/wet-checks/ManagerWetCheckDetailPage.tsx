/**
 * ManagerWetCheckDetailPage — read-only review layout for
 * irrigation_manager and company_admin roles.
 *
 * Replaces the field-tech-oriented WetCheckInspectionSummaryPage for
 * manager roles at /wet-checks/:id/review.  Field techs continue to
 * use WetCheckInspectionSummaryPage (with the "Submit for Review" CTA).
 *
 * Layout: full desktop width, no narrow center column.
 */

import { useState, useEffect, useRef } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useArrayQuery } from "@/lib/queryClient";
import { apiRequest, asArray, parseApiError, authedPdfUrl } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cachedApiRequest } from "@/lib/offline/api";
import { CUSTOM_REVIEW_ISSUE_TYPE } from "@/lib/finding-save-payload";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LaborHoursStepper } from "@/components/ui/labor-hours-stepper";
import {
  Loader2,
  CheckCircle2,
  Wrench,
  Cloud,
  FileText,
  ArrowRight,
  AlertTriangle,
  ClipboardCheck,
  User,
  Calendar,
  MapPin,
  Info,
  FileCheck,
  DollarSign,
  Send,
  Download,
} from "lucide-react";
import type {
  WetCheckWithDetails,
  WetCheckFinding,
  WetCheckZoneRecord,
  Customer,
} from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";
import { ZoneStatusGrid, type ZoneRecordWithFindings } from "./ZoneStatusGrid";
import { safeGet } from "@/utils/safeStorage";

function getAdminRole(): boolean {
  try {
    const raw = safeGet("user");
    if (!raw) return false;
    const role = JSON.parse(raw)?.role;
    return role === "company_admin" || role === "super_admin";
  } catch {
    return false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtDateShort(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

const currency = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

function lineTotal(f: WetCheckFinding, laborRate: number): number {
  const partPrice = parseFloat(String(f.partPrice ?? "0")) || 0;
  const labor = parseFloat(String(f.laborHours ?? "0")) || 0;
  return partPrice * Number(f.quantity ?? 0) + labor * laborRate;
}

const STATUS_LABELS: Record<string, string> = {
  in_progress: "In Progress",
  submitted: "Submitted",
  partially_converted: "Partially Converted",
  converted: "Converted",
};

const STATUS_BADGE: Record<string, string> = {
  in_progress: "bg-gray-100 text-gray-700 border border-gray-300",
  submitted: "bg-blue-100 text-blue-800 border border-blue-300",
  partially_converted: "bg-amber-100 text-amber-800 border border-amber-300",
  converted: "bg-emerald-100 text-emerald-800 border border-emerald-300",
};

// ─── Resolution meta ─────────────────────────────────────────────────────────

type Resolution =
  | "pending"
  | "repaired_in_field"
  | "sent_to_estimate"
  | "deferred_to_work_order"
  | "documented_only";

const RESOLUTION_META: Record<
  Resolution,
  { label: string; className: string }
> = {
  pending:               { label: "Pending",       className: "bg-gray-50 text-gray-600 border-gray-300" },
  repaired_in_field:     { label: "Completed",     className: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  sent_to_estimate:      { label: "→ Estimate",    className: "bg-blue-50 text-blue-700 border-blue-200" },
  deferred_to_work_order:{ label: "→ Work Order",  className: "bg-purple-50 text-purple-700 border-purple-200" },
  documented_only:       { label: "Documented",    className: "bg-gray-100 text-gray-600 border-gray-300" },
};

// ─── Finding row (manager variant) ───────────────────────────────────────────

function FindingRow({
  finding: f,
}: {
  finding: WetCheckFinding;
}) {
  const isComplete =
    f.techDisposition != null
      ? f.techDisposition === "completed_in_field"
      : f.resolution === "repaired_in_field";

  const resolution = (f.resolution ?? "pending") as Resolution;
  const resMeta = RESOLUTION_META[resolution] ?? RESOLUTION_META.pending;

  return (
    <div
      className="flex items-start gap-2.5 py-2 text-sm"
      data-testid={`mgr-finding-row-${f.id}`}
    >
      {isComplete ? (
        <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" />
      ) : (
        <Wrench className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-900">
          {f.issueType === CUSTOM_REVIEW_ISSUE_TYPE
            ? "🚩 Custom — Flag for Manager"
            : f.issueType.replace(/_/g, " ")}
        </span>
        {f.partName && (
          <span className="text-gray-500 text-sm">
            {" · "}{f.partName}
            {f.quantity && Number(f.quantity) !== 1 ? ` × ${Number(f.quantity)}` : ""}
          </span>
        )}
        {f.laborHours && parseFloat(String(f.laborHours)) > 0 && (
          <span className="text-gray-400 text-xs ml-2">
            {parseFloat(String(f.laborHours)).toFixed(2)} hr
          </span>
        )}
        {f.notes && (
          <div className="text-gray-500 text-xs mt-0.5 italic">{f.notes}</div>
        )}
        {/* Link to created record */}
        {f.estimateId && (
          <Link
            href={`/estimates`}
            className="text-xs text-blue-600 hover:underline mt-0.5 inline-block"
            data-testid={`mgr-finding-estimate-link-${f.id}`}
          >
            Estimate #{f.estimateId}
          </Link>
        )}
        {f.workOrderId && (
          <Link
            href={`/work-orders`}
            className="text-xs text-purple-600 hover:underline mt-0.5 inline-block"
            data-testid={`mgr-finding-wo-link-${f.id}`}
          >
            Work Order #{f.workOrderId}
          </Link>
        )}
      </div>
      <Badge
        className={`text-[10px] shrink-0 border ${resMeta.className}`}
        variant="outline"
      >
        {resMeta.label}
      </Badge>
    </div>
  );
}

// ─── Editable zone repair labor row (manager tier) ───────────────────────────

function ZoneRepairLaborRow({ zr, wetCheckId }: { zr: ZoneRecordWithFindings; wetCheckId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [localHours, setLocalHours] = useState<string>(
    String((zr as any).repairLaborHours ?? "0.00"),
  );
  useEffect(() => {
    setLocalHours(String((zr as any).repairLaborHours ?? "0.00"));
  }, [(zr as any).repairLaborHours]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveMut = useMutation({
    mutationFn: (hours: string) =>
      apiRequest(`/api/wet-checks/zone-records/${zr.id}/repair-labor/manager`, "PATCH", {
        repairLaborHours: hours,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
    },
    onError: (e: any) => {
      toast({
        title: "Couldn't save repair labor",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetMut = useMutation({
    mutationFn: () =>
      apiRequest(`/api/wet-checks/zone-records/${zr.id}/repair-labor/reset-manager`, "POST", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wetCheckId] });
    },
    onError: (e: any) => {
      toast({
        title: "Couldn't reset repair labor",
        description: e?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleChange = (val: string) => {
    setLocalHours(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => saveMut.mutate(val), 600);
  };

  const isManual = !!(zr as any).repairLaborManuallySet;
  const hours = parseFloat(String((zr as any).repairLaborHours ?? "0")) || 0;
  const anyPending = saveMut.isPending || resetMut.isPending;

  return (
    <div className="px-4 pb-3 pt-2 bg-gray-50 border-t border-dashed border-gray-200" data-testid={`mgr-zone-repair-labor-${zr.controllerLetter}${zr.zoneNumber}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
          Repair Labor
          {isManual ? (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300 text-[9px] font-semibold">manual</span>
          ) : (
            <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 text-[9px] font-semibold">auto</span>
          )}
        </span>
        <span className="text-xs text-gray-500">
          {hours === 0 ? "—" : `${hours.toFixed(2)} hr`}
        </span>
      </div>
      <LaborHoursStepper
        value={localHours}
        onChange={handleChange}
        min="0.00"
        disabled={anyPending}
      />
      {isManual && (
        <button
          type="button"
          className="mt-1.5 text-[10px] text-blue-600 hover:text-blue-800 underline disabled:opacity-40"
          onClick={() => resetMut.mutate()}
          disabled={anyPending}
          data-testid={`mgr-zone-reset-labor-${zr.controllerLetter}${zr.zoneNumber}`}
        >
          Reset to default
        </button>
      )}
    </div>
  );
}

// ─── Findings grouped by controller → zone ────────────────────────────────────

function FindingsSummary({
  zoneRecords,
  controllers,
  wetCheckId,
}: {
  zoneRecords: ZoneRecordWithFindings[];
  controllers: CustomerController[];
  wetCheckId: number;
}) {
  const allFindings = zoneRecords.flatMap((z) => asArray(z.findings));

  const completedCount = allFindings.filter(
    (f) => f.resolution === "repaired_in_field",
  ).length;
  const sentToEstimate = allFindings.filter(
    (f) => f.resolution === "sent_to_estimate",
  ).length;
  const deferredToWO = allFindings.filter(
    (f) => f.resolution === "deferred_to_work_order",
  ).length;
  const documented = allFindings.filter(
    (f) => f.resolution === "documented_only",
  ).length;
  const pendingCount = allFindings.filter(
    (f) => !f.resolution || f.resolution === "pending",
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
      <div className="text-sm text-gray-400 italic text-center py-4">
        No findings recorded.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="mgr-findings-summary">
      {/* Resolution summary chips */}
      <div className="flex flex-wrap gap-2">
        {completedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-600 text-white">
            <CheckCircle2 className="w-3 h-3" />
            {completedCount} completed in field
          </span>
        )}
        {sentToEstimate > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-600 text-white">
            <FileCheck className="w-3 h-3" />
            {sentToEstimate} → estimate
          </span>
        )}
        {deferredToWO > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-purple-600 text-white">
            <Wrench className="w-3 h-3" />
            {deferredToWO} → work order
          </span>
        )}
        {documented > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-gray-500 text-white">
            <FileText className="w-3 h-3" />
            {documented} documented only
          </span>
        )}
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500 text-white">
            <AlertTriangle className="w-3 h-3" />
            {pendingCount} pending review
          </span>
        )}
      </div>

      {/* Per-zone groups */}
      {grouped.map((zr) => (
        <div
          key={`${zr.controllerLetter}-${zr.zoneNumber}`}
          className="border border-gray-200 rounded-lg overflow-hidden"
          data-testid={`mgr-zone-group-${zr.controllerLetter}${zr.zoneNumber}`}
        >
          <div className="bg-gray-50 px-4 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide border-b flex items-center gap-2">
            <MapPin className="w-3 h-3 text-gray-400" />
            Controller {zr.controllerLetter} · Zone {zr.zoneNumber}
          </div>
          <div className="px-4 py-1 divide-y divide-gray-100">
            {asArray(zr.findings).map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
          {/* Task #891 — editable repair labor per zone (manager review tier) */}
          {zr.id != null && (
            <ZoneRepairLaborRow zr={zr} wetCheckId={wetCheckId} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Outcome summary (for partially_converted / approved / converted) ─────────

interface FindingItem { f: WetCheckFinding; zr: WetCheckZoneRecord; }

const OUTCOME_ACCENTS: Record<
  string,
  { bar: string; iconBg: string; iconText: string }
> = {
  green:  { bar: "border-l-emerald-500", iconBg: "bg-emerald-50", iconText: "text-emerald-600" },
  blue:   { bar: "border-l-blue-500",    iconBg: "bg-blue-50",    iconText: "text-blue-600" },
  purple: { bar: "border-l-purple-500",  iconBg: "bg-purple-50",  iconText: "text-purple-600" },
  gray:   { bar: "border-l-gray-400",    iconBg: "bg-gray-100",   iconText: "text-gray-500" },
};

function OutcomeRow({
  accent,
  icon: Icon,
  primary,
  secondary,
  linkHref,
  linkLabel,
  testId,
}: {
  accent: "green" | "blue" | "purple" | "gray";
  icon: React.ComponentType<{ className?: string }>;
  primary: string;
  secondary?: string;
  linkHref?: string;
  linkLabel?: string;
  testId: string;
}) {
  const a = OUTCOME_ACCENTS[accent];
  return (
    <div
      className={`border-l-4 ${a.bar} bg-white px-4 py-3 flex items-center gap-3 rounded-r-lg`}
      data-testid={testId}
    >
      <div className={`${a.iconBg} p-2 rounded-md shrink-0`}>
        <Icon className={`w-4 h-4 ${a.iconText}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900">{primary}</div>
        {secondary && (
          <div className="text-xs text-gray-500 mt-0.5">{secondary}</div>
        )}
      </div>
      {linkHref && linkLabel && (
        <Link href={linkHref}>
          <Button
            variant="link"
            size="sm"
            className="text-blue-600 h-auto p-0 text-xs"
            data-testid={`${testId}-link`}
          >
            {linkLabel} →
          </Button>
        </Link>
      )}
    </div>
  );
}

function OutcomeSummary({
  allFindings,
  laborRate,
}: {
  allFindings: FindingItem[];
  laborRate: number;
}) {
  const groups = {
    repaired:   allFindings.filter(({ f }) => f.resolution === "repaired_in_field"),
    sentEst:    allFindings.filter(({ f }) => f.resolution === "sent_to_estimate"),
    deferred:   allFindings.filter(({ f }) => f.resolution === "deferred_to_work_order"),
    documented: allFindings.filter(({ f }) => f.resolution === "documented_only"),
    pending:    allFindings.filter(({ f }) => !f.resolution || f.resolution === "pending"),
  };

  const estimateId = groups.sentEst.find((it) => it.f.estimateId != null)?.f.estimateId ?? null;
  const workOrderId = groups.deferred.find((it) => it.f.workOrderId != null)?.f.workOrderId ?? null;

  const totals = {
    repaired:  groups.repaired.reduce((s, it) => s + lineTotal(it.f, laborRate), 0),
    estimate:  groups.sentEst.reduce((s, it) => s + lineTotal(it.f, laborRate), 0),
    workOrder: groups.deferred.reduce((s, it) => s + lineTotal(it.f, laborRate), 0),
  };

  const hasAnyDecision = groups.repaired.length + groups.sentEst.length +
    groups.deferred.length + groups.documented.length > 0;

  if (!hasAnyDecision) return null;

  return (
    <Card data-testid="mgr-outcome-summary">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Triage Outcomes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {groups.repaired.length > 0 && (
          <OutcomeRow
            testId="outcome-repaired"
            accent="green"
            icon={CheckCircle2}
            primary={`${groups.repaired.length} finding${groups.repaired.length !== 1 ? "s" : ""} repaired in field`}
            secondary={totals.repaired > 0 ? `Est. value: ${currency(totals.repaired)}` : undefined}
          />
        )}
        {groups.sentEst.length > 0 && (
          <OutcomeRow
            testId="outcome-estimate"
            accent="blue"
            icon={FileCheck}
            primary={`${groups.sentEst.length} finding${groups.sentEst.length !== 1 ? "s" : ""} sent to estimate`}
            secondary={totals.estimate > 0 ? `Est. value: ${currency(totals.estimate)}` : undefined}
            linkHref={estimateId ? `/estimates` : undefined}
            linkLabel={estimateId ? `Estimate #${estimateId}` : undefined}
          />
        )}
        {groups.deferred.length > 0 && (
          <OutcomeRow
            testId="outcome-work-order"
            accent="purple"
            icon={Wrench}
            primary={`${groups.deferred.length} finding${groups.deferred.length !== 1 ? "s" : ""} deferred to work order`}
            secondary={totals.workOrder > 0 ? `Est. value: ${currency(totals.workOrder)}` : undefined}
            linkHref={workOrderId ? `/work-orders` : undefined}
            linkLabel={workOrderId ? `Work Order #${workOrderId}` : undefined}
          />
        )}
        {groups.documented.length > 0 && (
          <OutcomeRow
            testId="outcome-documented"
            accent="gray"
            icon={FileText}
            primary={`${groups.documented.length} finding${groups.documented.length !== 1 ? "s" : ""} documented only`}
            secondary="No billing action taken"
          />
        )}
        {groups.pending.length > 0 && (
          <div
            className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800"
            data-testid="outcome-pending"
          >
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <span>
              <span className="font-medium">{groups.pending.length} finding{groups.pending.length !== 1 ? "s" : ""}</span>
              {" "}still pending triage
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Status-aware CTA ─────────────────────────────────────────────────────────

function ManagerCTA({ wc }: { wc: WetCheckWithDetails }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const triageUrl = `/manager/wet-checks/${wc.id}`;
  const [forceSubmitOpen, setForceSubmitOpen] = useState(false);
  const isAdmin = getAdminRole();

  const forceSubmitMut = useMutation({
    mutationFn: () =>
      apiRequest(`/api/wet-checks/${wc.id}/force-submit`, "POST", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks", wc.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/wet-checks/needs-review"] });
      toast({
        title: "Wet check marked as submitted",
        description: "Routing and triage are now available.",
      });
      setForceSubmitOpen(false);
    },
    onError: (e: any) => {
      toast({
        title: "Could not mark as submitted",
        description: parseApiError(e, e?.message ?? "Please try again."),
        variant: "destructive",
      });
      setForceSubmitOpen(false);
    },
  });

  if (wc.status === "in_progress") {
    return (
      <>
        <div
          className="flex items-start gap-3 p-4 rounded-lg bg-gray-50 border border-gray-200"
          data-testid="mgr-cta-in-progress"
        >
          <Info className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-700">Inspection in progress</p>
            <p className="text-xs text-gray-500 mt-0.5">
              The field tech has not submitted this inspection yet. This view is read-only.
            </p>
            {isAdmin && (
              <p className="text-xs text-gray-400 mt-1">
                If the tech's submit failed due to an offline issue, you can force-submit below.
              </p>
            )}
          </div>
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-xs"
              onClick={() => setForceSubmitOpen(true)}
              data-testid="mgr-cta-force-submit-button"
            >
              Mark as Submitted
            </Button>
          )}
        </div>

        <AlertDialog open={forceSubmitOpen} onOpenChange={setForceSubmitOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark wet check as submitted?</AlertDialogTitle>
              <AlertDialogDescription>
                This will transition the wet check from "In Progress" to "Submitted" and unlock routing and triage. Use this only if the field tech's submit failed due to a connectivity issue and the inspection is actually complete.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={forceSubmitMut.isPending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => forceSubmitMut.mutate()}
                disabled={forceSubmitMut.isPending}
                data-testid="mgr-cta-force-submit-confirm"
              >
                {forceSubmitMut.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Marking…</>
                ) : (
                  "Mark as Submitted"
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  if (wc.status === "submitted") {
    return (
      <div className="space-y-3" data-testid="mgr-cta-submitted">
        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={() => navigate(triageUrl)}
          data-testid="btn-begin-triage"
        >
          Begin Triage
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
        <p className="text-center text-xs text-gray-400">
          Opens the triage wizard to route findings to estimates or work orders
        </p>
      </div>
    );
  }

  if (wc.status === "partially_converted") {
    return (
      <div className="space-y-3" data-testid="mgr-cta-partially-converted">
        <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-800">Triage partially complete</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Some findings have been routed. Continue triage to handle the remaining items.
            </p>
          </div>
        </div>
        <Button
          className="w-full h-12 text-base font-semibold"
          onClick={() => navigate(triageUrl)}
          data-testid="btn-continue-triage"
        >
          Continue Triage
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    );
  }

  if (wc.status === "converted") {
    return (
      <div
        className="flex items-start gap-3 p-4 rounded-lg bg-emerald-50 border border-emerald-200"
        data-testid="mgr-cta-converted"
      >
        <ClipboardCheck className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-emerald-800">Fully converted</p>
          <Link
            href={triageUrl}
            className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline font-medium"
          >
            View triage details
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Main view ───────────────────────────────────────────────────────────────

function ManagerWetCheckDetailView({ id }: { id: number }) {
  const { toast } = useToast();
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [sendReportOpen, setSendReportOpen] = useState(false);
  const [sendReportEmail, setSendReportEmail] = useState("");
  const [sendReportNote, setSendReportNote] = useState("");

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

  const { data: customer } = useQuery<Customer>({
    queryKey: ["/api/customers", wc?.customerId],
    queryFn: () => apiRequest(`/api/customers/${wc!.customerId}`),
    enabled: !!wc?.customerId,
  });

  const sendReportMut = useMutation({
    mutationFn: ({ to, note }: { to: string; note: string }) =>
      apiRequest(`/api/wet-checks/${id}/report/send`, "POST", { to: to || undefined, note: note || undefined }),
    onSuccess: (_res, vars) => {
      toast({ title: "Report sent", description: `Inspection report emailed to ${vars.to || "customer"}.` });
      setSendReportOpen(false);
      setSendReportEmail("");
      setSendReportNote("");
    },
    onError: (e: any) =>
      toast({ title: "Couldn't send report", description: e?.message, variant: "destructive" }),
  });

  if (isLoading || !wc) {
    return (
      <div className="flex justify-center py-16" data-testid="mgr-detail-loading">
        <Loader2 className="animate-spin w-6 h-6 text-gray-400" />
      </div>
    );
  }

  const wcZoneRecords = asArray(wc.zoneRecords) as ZoneRecordWithFindings[];
  const allFindingItems: FindingItem[] = wcZoneRecords.flatMap((zr) =>
    asArray(zr.findings).map((f) => ({ f, zr })),
  );
  const allFindings = allFindingItems.map((it) => it.f);

  const laborRate = parseFloat(String(customer?.laborRate ?? "45")) || 45;

  // Zone status computation
  const totalZoneCount = controllers.reduce((n, c) => n + (c.zoneCount ?? 0), 0);
  const recordMap = new Map(
    wcZoneRecords.map((r) => [`${r.controllerLetter}-${r.zoneNumber}`, r]),
  );
  let checkedOk = 0, checkedIssues = 0, notApplicable = 0;
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

  // Labor totals
  const inspectionLaborHours = parseFloat(String(wc.totalLaborHours ?? "0")) || 0;
  const repairLaborHours = wcZoneRecords.reduce(
    (sum, z) => sum + (parseFloat(String((z as any).repairLaborHours ?? "0")) || 0),
    0,
  );
  const totalLaborHours = inspectionLaborHours + repairLaborHours;

  // Estimated value (parts + labor from findings)
  const partsValue = allFindings.reduce((sum, f) => {
    const p = parseFloat(String(f.partPrice ?? "0")) || 0;
    return sum + p * Number(f.quantity ?? 0);
  }, 0);
  const findingLaborValue = allFindings.reduce((sum, f) => {
    const lh = parseFloat(String(f.laborHours ?? "0")) || 0;
    return sum + lh * laborRate;
  }, 0);
  const estimatedValue = partsValue + findingLaborValue;

  const statusLabel = STATUS_LABELS[wc.status] ?? wc.status;
  const statusBadgeClass = STATUS_BADGE[wc.status] ?? "bg-gray-100 text-gray-700";

  const showOutcome =
    wc.status === "partially_converted" ||
    wc.status === "converted";

  return (
    <div className="py-6 space-y-6" data-testid="mgr-wet-check-detail">

      {/* ── Property + status header ── */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 rounded-xl p-5 text-white shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1
              className="text-xl font-bold truncate"
              data-testid="mgr-header-customer"
            >
              {wc.customerName}
            </h1>
            {wc.propertyAddress && (
              <p className="text-blue-100 text-sm mt-0.5 truncate" data-testid="mgr-header-address">
                {wc.propertyAddress}
              </p>
            )}
          </div>
          <span
            className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${statusBadgeClass}`}
            data-testid="mgr-status-badge"
          >
            {statusLabel}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="flex items-center gap-2">
            <User className="w-4 h-4 text-blue-300 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-blue-300 uppercase tracking-wide font-semibold">Technician</p>
              <p className="text-sm font-medium text-white">{wc.technicianName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-blue-300 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-blue-300 uppercase tracking-wide font-semibold">
                {wc.submittedAt ? "Submitted" : "Started"}
              </p>
              <p className="text-sm font-medium text-white">
                {fmtDate(wc.submittedAt ?? wc.startedAt)}
              </p>
            </div>
          </div>
          {wc.status === "in_progress" && (
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-300 flex-shrink-0" />
              <div>
                <p className="text-[10px] text-blue-300 uppercase tracking-wide font-semibold">Progress</p>
                <p className="text-sm font-medium text-white">
                  {totalChecked} / {totalZoneCount} zones checked
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Customer report actions ── */}
      <div className="flex flex-wrap gap-2" data-testid="mgr-customer-report-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={isDownloadingReport}
          data-testid="mgr-download-customer-report"
          onClick={async () => {
            if (isDownloadingReport) return;
            setIsDownloadingReport(true);
            try {
              const url = authedPdfUrl(`/api/wet-checks/${id}/report-pdf`, { download: "1" });
              const res = await fetch(url, { credentials: "include" });
              if (!res.ok) {
                let msg = `Failed (${res.status})`;
                try {
                  const ct = res.headers.get("content-type") ?? "";
                  if (ct.includes("application/json")) {
                    const j = await res.json(); if (j?.message) msg = j.message;
                  } else { const t = await res.text(); if (t) msg = t; }
                } catch { /* ignore */ }
                throw new Error(msg);
              }
              const blob = await res.blob();
              const objUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = objUrl;
              const date = wc.startedAt ? new Date(wc.startedAt).toISOString().slice(0, 10) : "unknown";
              const safeName = (wc.customerName ?? "").replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
              a.download = safeName ? `${safeName} - Inspection Report - ${date}.pdf` : `inspection-report-${id}-${date}.pdf`;
              a.rel = "noopener";
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
            } catch (err) {
              toast({ title: "Couldn't download customer report", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
            } finally { setIsDownloadingReport(false); }
          }}
        >
          <Download className="w-4 h-4 mr-1" />
          {isDownloadingReport ? "Preparing…" : "Customer Report (PDF)"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="mgr-send-customer-report"
          onClick={() => {
            setSendReportEmail(customer?.email ?? "");
            setSendReportNote("");
            setSendReportOpen(true);
          }}
        >
          <Send className="w-4 h-4 mr-1" />
          Send to Customer
        </Button>
      </div>

      {/* ── Zone status grid ── */}
      <Card data-testid="mgr-zone-grid-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Zone Overview</span>
            <span className="text-xs font-normal text-gray-500">
              {totalChecked} / {totalZoneCount} zones checked
            </span>
          </CardTitle>
          <div className="flex flex-wrap gap-1.5 pt-1 text-xs">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500 text-white font-semibold">
              ✓ OK · {checkedOk}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white font-semibold">
              ! Issues · {checkedIssues}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-400 text-white font-semibold">
              N/A · {notApplicable}
            </span>
            {uncheckedCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border-2 border-amber-400 text-amber-700 font-semibold">
                <AlertTriangle className="w-3 h-3" />
                Unchecked · {uncheckedCount}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {controllers.length === 0 ? (
            <div className="text-sm text-gray-400 py-4 text-center">
              Loading zone map…
            </div>
          ) : (
            <ZoneStatusGrid
              controllers={controllers}
              zoneRecords={wcZoneRecords}
            />
          )}
        </CardContent>
      </Card>

      {/* ── Slice 3: Lineage panel — originated estimate / work order ── */}
      {(wc.originatedEstimateId != null || wc.originatedWorkOrderId != null) && (
        <Card data-testid="wc-lineage-panel">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <FileCheck className="w-4 h-4 text-blue-500" />
              This Inspection&apos;s Estimate
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {wc.originatedEstimateId != null && (
              <OutcomeRow
                testId="lineage-estimate-row"
                accent="blue"
                icon={FileCheck}
                primary={`Estimate #${wc.originatedEstimateId}`}
                secondary="Created from this inspection's findings"
                linkHref={`/estimates`}
                linkLabel={`View Estimate #${wc.originatedEstimateId}`}
              />
            )}
            {wc.originatedWorkOrderId != null && (
              <OutcomeRow
                testId="lineage-work-order-row"
                accent="purple"
                icon={Wrench}
                primary={`Work Order #${wc.originatedWorkOrderId}`}
                secondary="Converted from the inspection estimate"
                linkHref={`/work-orders`}
                linkLabel={`View Work Order #${wc.originatedWorkOrderId}`}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Triage outcomes (for converted / approved / partially_converted) ── */}
      {showOutcome && (
        <OutcomeSummary
          allFindings={allFindingItems}
          laborRate={laborRate}
        />
      )}

      {/* ── Findings ── */}
      <Card data-testid="mgr-findings-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Findings
            {allFindings.length > 0 && (
              <span className="ml-2 text-xs font-normal text-gray-500">
                ({allFindings.length} total)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FindingsSummary
            zoneRecords={wcZoneRecords}
            controllers={controllers}
            wetCheckId={wc.id}
          />
        </CardContent>
      </Card>

      {/* ── Job totals ── */}
      <Card data-testid="mgr-totals-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Job Totals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-3 gap-4 text-center text-sm">
            <div>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">Labor Hours</dt>
              <dd className="text-2xl font-bold text-gray-900 mt-1" data-testid="mgr-total-labor">
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
              <dd className="text-2xl font-bold text-gray-900 mt-1" data-testid="mgr-total-zones">
                {totalChecked}
                <span className="text-sm font-normal text-gray-400"> / {totalZoneCount}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">Findings</dt>
              <dd className="text-2xl font-bold text-gray-900 mt-1" data-testid="mgr-total-findings">
                {allFindings.length}
              </dd>
            </div>
          </dl>
          {/* Estimated value row */}
          {estimatedValue > 0 && (
            <div
              className="flex items-center justify-between pt-3 border-t border-gray-100 text-sm"
              data-testid="mgr-estimated-value"
            >
              <span className="flex items-center gap-1.5 text-gray-600">
                <DollarSign className="w-4 h-4 text-gray-400" />
                Estimated Value
                <span className="text-[10px] text-gray-400">(parts + labor)</span>
              </span>
              <span className="font-bold text-gray-900">
                {currency(estimatedValue)}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Weather & notes (read-only) ── */}
      {(wc.weather || wc.notes) && (
        <Card data-testid="mgr-weather-notes-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Weather &amp; Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {wc.weather && (
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <Cloud className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <span>{wc.weather}</span>
              </div>
            )}
            {wc.notes && (
              <div className="flex items-start gap-2 text-sm text-gray-700">
                <FileText className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                <span className="whitespace-pre-wrap">{wc.notes}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Status-aware CTA ── */}
      <div className="pt-1">
        <ManagerCTA wc={wc} />
      </div>

      {/* ── Send customer report modal ── */}
      <Dialog open={sendReportOpen} onOpenChange={(o) => { if (!sendReportMut.isPending) setSendReportOpen(o); }}>
        <DialogContent data-testid="mgr-send-report-dialog">
          <DialogHeader>
            <DialogTitle>Send Inspection Report to Customer</DialogTitle>
            <DialogDescription>
              A PDF condition report (zones, findings, photos — no pricing) will be emailed to the customer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="mgr-send-report-email">Recipient email</Label>
              <Input
                id="mgr-send-report-email"
                type="email"
                placeholder="customer@example.com (leave blank to use email on file)"
                value={sendReportEmail}
                onChange={e => setSendReportEmail(e.target.value)}
                data-testid="mgr-send-report-email-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mgr-send-report-note">Note to customer <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                id="mgr-send-report-note"
                rows={3}
                placeholder="Add a note that appears in the email body…"
                value={sendReportNote}
                onChange={e => setSendReportNote(e.target.value)}
                data-testid="mgr-send-report-note-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendReportOpen(false)} disabled={sendReportMut.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => sendReportMut.mutate({ to: sendReportEmail, note: sendReportNote })}
              disabled={sendReportMut.isPending}
              data-testid="mgr-send-report-confirm"
            >
              {sendReportMut.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              Send Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Page entry ──────────────────────────────────────────────────────────────

export default function ManagerWetCheckDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id ?? "0", 10);

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">
        Wet check not found.
      </div>
    );
  }

  return <ManagerWetCheckDetailView id={id} />;
}
