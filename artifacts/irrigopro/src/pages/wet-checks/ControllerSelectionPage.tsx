import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Sun,
  CloudSun,
  Cloud,
  CloudRain,
  Droplets,
  Map,
  GitBranch,
} from "lucide-react";
import { apiRequest, asArray, useArrayQuery } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { Customer, WetCheckWithDetails, WetCheck } from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";

// ─── Types ────────────────────────────────────────────────────────────────────

type WeatherOption = "sunny" | "partly_cloudy" | "overcast" | "rainy";

const WEATHER_OPTIONS: { value: WeatherOption; label: string; Icon: React.ElementType }[] = [
  { value: "sunny",         label: "Sunny",         Icon: Sun       },
  { value: "partly_cloudy", label: "Partly Cloudy", Icon: CloudSun  },
  { value: "overcast",      label: "Overcast",      Icon: Cloud     },
  { value: "rainy",         label: "Rain",          Icon: CloudRain },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(raw: string | Date): string {
  const d = new Date(raw);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Controller card ──────────────────────────────────────────────────────────

interface ControllerCardProps {
  controller: CustomerController;
  selected: boolean;
  lastCheckedAt: Date | null;
  hadIssues: boolean;
  onToggle: () => void;
}

function ControllerCard({ controller, selected, lastCheckedAt, hadIssues, onToggle }: ControllerCardProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={[
        "relative w-full text-left rounded-xl border-2 p-4 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
        selected
          ? "border-blue-500 bg-blue-50 shadow-sm"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50",
      ].join(" ")}
      data-testid={`ctrl-card-${controller.controllerLetter}`}
      aria-pressed={selected}
    >
      {/* Checkmark badge */}
      {selected && (
        <span className="absolute top-2 right-2 text-blue-600" data-testid={`ctrl-check-${controller.controllerLetter}`}>
          <CheckCircle2 className="h-5 w-5" strokeWidth={2.5} />
        </span>
      )}

      {/* Letter */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className={[
            "inline-flex items-center justify-center w-9 h-9 rounded-lg text-lg font-bold",
            selected ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700",
          ].join(" ")}
        >
          {controller.controllerLetter}
        </span>
        <span className="text-sm font-semibold text-gray-900">
          Controller {controller.controllerLetter}
        </span>
      </div>

      {/* Zone count */}
      <p className="text-xs text-gray-500 mb-1">
        {controller.zoneCount != null ? `${controller.zoneCount} zone${controller.zoneCount !== 1 ? "s" : ""}` : "Zone count not set"}
      </p>

      {/* Last checked — only shown when this controller had zone records in last check */}
      <p className="text-xs text-gray-400">
        {lastCheckedAt ? `Last checked ${formatDate(lastCheckedAt)}` : "Never checked"}
      </p>

      {/* Issues chip */}
      {hadIssues && (
        <Badge
          className="mt-2 bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-medium"
          data-testid={`ctrl-issues-${controller.controllerLetter}`}
        >
          Had issues
        </Badge>
      )}
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface ControllerSelectionPageProps {
  customerId: number;
  // Task #315 — selected branch for multi-location customers. null / undefined
  // for single-location customers (customer-level bucket).
  branchName?: string | null;
}

export function ControllerSelectionPage({ customerId, branchName }: ControllerSelectionPageProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [selectedLetters, setSelectedLetters] = useState<Set<string>>(new Set());
  const [weather, setWeather] = useState<WeatherOption | null>(null);
  const [notes, setNotes] = useState("");

  // ── Data fetches ──────────────────────────────────────────────────────────

  const { data: customer, isLoading: loadingCustomer } = useQuery<Customer>({
    queryKey: ["/api/customers", customerId],
    queryFn: () => apiRequest(`/api/customers/${customerId}`),
  });

  // Task #315 — when a branch is selected, scope the controllers fetch to
  // that branch via ?branch=<name>. The server lazily bootstraps the branch
  // controller bucket on first visit (idempotent ensurePropertyControllers).
  const controllersUrl = branchName
    ? `/api/properties/${customerId}/controllers?branch=${encodeURIComponent(branchName)}`
    : `/api/properties/${customerId}/controllers`;

  const { data: controllers = [], isLoading: loadingControllers } = useArrayQuery<CustomerController>({
    queryKey: ["/api/properties", customerId, "controllers", branchName ?? null],
    queryFn: () => apiRequest(controllersUrl),
  });

  // Fetch up to 5 recent wet checks (summaries) for per-controller last-inspected data.
  // When a branch is selected, filter to that branch so we only surface history from
  // this specific location.
  type WetCheckSummary = WetCheck & { zoneCount: number; processedCount: number; failedCount: number };
  const recentChecksUrl = branchName
    ? `/api/wet-checks?customerId=${customerId}&branchName=${encodeURIComponent(branchName)}&limit=5`
    : `/api/wet-checks?customerId=${customerId}&limit=5`;

  const { data: recentChecks = [] } = useArrayQuery<WetCheckSummary>({
    queryKey: ["/api/wet-checks", { customerId, branchName: branchName ?? null, limit: 5 }],
    queryFn: () => apiRequest(recentChecksUrl),
  });

  // Most recent non-in_progress check (first candidate for "last checked" context)
  const lastCompletedCheck = useMemo(
    () => recentChecks.find((wc) => wc.status !== "in_progress") ?? null,
    [recentChecks],
  );

  // Full details of the last completed check (for per-controller zone presence + issues)
  const { data: lastCheckDetails } = useQuery<WetCheckWithDetails>({
    queryKey: ["/api/wet-checks", lastCompletedCheck?.id, "details"],
    queryFn: () => apiRequest(`/api/wet-checks/${lastCompletedCheck!.id}`),
    enabled: lastCompletedCheck?.id != null,
    staleTime: 5 * 60 * 1000,
  });

  // ── Derived per-controller metadata ──────────────────────────────────────
  // "Last checked" is the most recent completed check where this controller
  // actually had zone records. "Had issues" means any zone in that same check
  // was checked_with_issues or had any findings recorded.
  const controllerMeta = useMemo(() => {
    const meta: Record<string, { lastCheckedAt: Date | null; hadIssues: boolean }> = {};
    const zoneRecords = asArray(lastCheckDetails?.zoneRecords);

    for (const ctrl of controllers) {
      const letter = ctrl.controllerLetter;
      const zonesForCtrl = zoneRecords.filter((z) => z.controllerLetter === letter);
      const hadIssues = zonesForCtrl.some(
        (z) => z.status === "checked_with_issues" || asArray(z.findings).length > 0,
      );
      const lastCheckedAt =
        zonesForCtrl.length > 0 && lastCheckDetails?.startedAt
          ? new Date(lastCheckDetails.startedAt)
          : null;
      meta[letter] = { lastCheckedAt, hadIssues };
    }
    return meta;
  }, [controllers, lastCheckDetails]);

  // Select all controllers by default once they load (runs in render, not in effect,
  // to avoid a flicker frame where no cards are selected).
  const [initialised, setInitialised] = useState(false);
  if (!initialised && controllers.length > 0) {
    setInitialised(true);
    setSelectedLetters(new Set(controllers.map((c) => c.controllerLetter)));
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  const SESSION_MODE_KEY = "wc_pending_mode";
  function consumePendingMode(): "service" | "inspection" {
    try {
      const raw = sessionStorage.getItem(SESSION_MODE_KEY);
      sessionStorage.removeItem(SESSION_MODE_KEY);
      if (raw === "inspection") return "inspection";
    } catch {
      // sessionStorage unavailable
    }
    return "service";
  }

  const startMutation = useMutation({
    mutationFn: async () => {
      const mode = consumePendingMode();
      // 1. Create the wet check record. The server is authoritative for numControllers —
      //    it derives it from customer.totalControllers, so we do not pass it here.
      //    branchName is included so the server scopes the check and bootstraps the
      //    correct controller bucket (Task #315).
      const wc = await apiRequest("/api/wet-checks", "POST", {
        customerId,
        weather: weather ?? null,
        notes: notes.trim() || null,
        mode,
        ...(branchName ? { branchName } : {}),
      }) as WetCheckWithDetails;

      const wetCheckId = wc.id;

      // Zone records are created lazily on first interaction — no pre-seeding.
      const selectedCtrlList = controllers
        .filter((c) => selectedLetters.has(c.controllerLetter))
        .sort((a, b) => a.controllerLetter.localeCompare(b.controllerLetter));

      const firstLetter = selectedCtrlList[0]?.controllerLetter ?? null;
      return { wetCheckId, firstLetter };
    },
    onSuccess: ({ wetCheckId, firstLetter }) => {
      const query = firstLetter ? `?controller=${firstLetter}&zone=1` : "";
      navigate(`/wet-checks/${wetCheckId}${query}`);
    },
    onError: (e: any) => {
      toast({
        title: "Could not start inspection",
        description: e?.message ?? "Please try again",
        variant: "destructive",
      });
    },
  });

  // Blank-start mutation: sends blankStart=true so the server skips
  // ensurePropertyControllers and records numControllers=0.
  const blankStartMutation = useMutation({
    mutationFn: async () => {
      const mode = consumePendingMode();
      const wc = await apiRequest("/api/wet-checks", "POST", {
        customerId,
        weather: weather ?? null,
        notes: notes.trim() || null,
        blankStart: true,
        mode,
        ...(branchName ? { branchName } : {}),
      }) as WetCheckWithDetails;
      return { wetCheckId: wc.id };
    },
    onSuccess: ({ wetCheckId }) => {
      navigate(`/wet-checks/${wetCheckId}`);
    },
    onError: (e: any) => {
      toast({
        title: "Could not start inspection",
        description: e?.message ?? "Please try again",
        variant: "destructive",
      });
    },
  });

  // ── Toggle controller selection ───────────────────────────────────────────

  function toggleController(letter: string) {
    setSelectedLetters((prev) => {
      const next = new Set(prev);
      if (next.has(letter)) next.delete(letter);
      else next.add(letter);
      return next;
    });
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  const isLoading = loadingCustomer || loadingControllers;

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto py-10 px-3 sm:px-4 flex justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const hasControllers = controllers.length > 0;
  const canBegin = selectedLetters.size > 0;
  const isBusy = startMutation.isPending || blankStartMutation.isPending;

  return (
    <div className="max-w-3xl mx-auto py-4 px-3 sm:px-4 pb-nav-safe">

      {/* ── Sticky property header ── */}
      <div
        className="sticky top-0 z-30 -mx-3 sm:-mx-4 px-3 sm:px-4 py-2 bg-white/95 backdrop-blur border-b shadow-sm mb-4"
        data-testid="property-context-header"
      >
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 truncate" data-testid="property-context-customer">
              {customer?.name ?? "…"}
            </span>
            {/* Task #315 — show branch badge when a branch is selected */}
            {branchName && (
              <Badge
                className="bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs shrink-0 flex items-center gap-1"
                data-testid="branch-context-badge"
              >
                <GitBranch className="h-3 w-3" />
                {branchName}
              </Badge>
            )}
          </div>
          <div className="text-xs text-gray-600 truncate" data-testid="property-context-address">
            {customer?.address ?? "—"}
          </div>
        </div>
      </div>

      {/* ── Back button ── */}
      <button
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 mb-4"
        onClick={() => navigate(`/wet-checks/c/${customerId}`)}
        data-testid="back-to-hub"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Property Hub
      </button>

      {/* ── Page title ── */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Start Inspection</h1>
        {/* Task #315 — surface the branch name clearly in the page title area */}
        {branchName ? (
          <p className="text-sm text-indigo-700 mt-0.5 flex items-center gap-1.5 font-medium">
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {branchName}
          </p>
        ) : (
          <p className="text-sm text-gray-500 mt-0.5 flex items-start gap-1.5">
            <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-gray-400" />
            <span>{customer?.address ?? "No address on file"}</span>
          </p>
        )}
      </div>

      {/* ── Controller grid ── */}
      {hasControllers ? (
        <>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">
              Controllers
              <span className="ml-1.5 text-gray-400 font-normal">
                ({selectedLetters.size} of {controllers.length} selected)
              </span>
            </h2>
            <button
              type="button"
              className="text-xs text-blue-600 hover:underline"
              onClick={() => {
                if (selectedLetters.size === controllers.length) {
                  setSelectedLetters(new Set());
                } else {
                  setSelectedLetters(new Set(controllers.map((c) => c.controllerLetter)));
                }
              }}
            >
              {selectedLetters.size === controllers.length ? "Deselect all" : "Select all"}
            </button>
          </div>

          <div
            className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6"
            data-testid="controller-grid"
          >
            {controllers.map((ctrl) => (
              <ControllerCard
                key={ctrl.controllerLetter}
                controller={ctrl}
                selected={selectedLetters.has(ctrl.controllerLetter)}
                lastCheckedAt={controllerMeta[ctrl.controllerLetter]?.lastCheckedAt ?? null}
                hadIssues={controllerMeta[ctrl.controllerLetter]?.hadIssues ?? false}
                onToggle={() => toggleController(ctrl.controllerLetter)}
              />
            ))}
          </div>
        </>
      ) : (
        /* ── No controllers fallback ── */
        <div
          className="flex flex-col items-center gap-3 py-8 text-center bg-gray-50 rounded-xl border border-gray-200 mb-6"
          data-testid="no-controllers-message"
        >
          <Map className="h-10 w-10 text-gray-300" />
          <div>
            <p className="text-sm font-medium text-gray-700">No site map controllers on file</p>
            <p className="text-xs text-gray-500 mt-1 max-w-xs">
              Add controllers to the site map first for a guided inspection with pre-loaded
              zones. Or start a blank inspection and add zones as you go.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/customers/${customerId}/site-maps`)}
            data-testid="btn-go-to-site-maps"
          >
            Open Site Map
          </Button>
        </div>
      )}

      {/* ── Weather selector ── */}
      <div className="mb-5">
        <label className="block text-sm font-semibold text-gray-700 mb-2">
          Weather <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <div className="flex gap-2 flex-wrap" data-testid="weather-selector">
          {WEATHER_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setWeather(weather === value ? null : value)}
              className={[
                "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-all",
                weather === value
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50",
              ].join(" ")}
              data-testid={`weather-${value}`}
              aria-pressed={weather === value}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Notes ── */}
      <div className="mb-6">
        <label
          htmlFor="inspection-notes"
          className="block text-sm font-semibold text-gray-700 mb-1.5"
        >
          Notes <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <Textarea
          id="inspection-notes"
          placeholder="e.g. back gate code, areas to skip, special instructions…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="min-h-[80px] text-sm resize-none"
          data-testid="notes-input"
        />
      </div>

      {/* ── CTA ── */}
      {hasControllers ? (
        <div className="space-y-2">
          {!canBegin && (
            <p className="text-xs text-center text-amber-700 flex items-center justify-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Select at least one controller to begin
            </p>
          )}
          <Button
            className="w-full h-12 text-base font-semibold"
            disabled={!canBegin || isBusy}
            onClick={() => startMutation.mutate()}
            data-testid="btn-begin-inspection"
          >
            {isBusy ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Droplets className="h-5 w-5 mr-2" />
                Begin Inspection
              </>
            )}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-full h-12 text-base font-medium"
          disabled={isBusy}
          onClick={() => blankStartMutation.mutate()}
          data-testid="btn-blank-start"
        >
          {isBusy ? (
            <>
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Starting…
            </>
          ) : (
            <>
              <Droplets className="h-5 w-5 mr-2" />
              Start Blank Inspection
            </>
          )}
        </Button>
      )}
    </div>
  );
}
