import { AlertTriangle, CheckCircle2, Camera } from "lucide-react";
import { asArray } from "@/lib/queryClient";
import { tintForControllerLetter } from "@workspace/shared";
import type { WetCheckZoneRecord, WetCheckFinding } from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";

export type ZoneRecordWithFindings = WetCheckZoneRecord & { findings: WetCheckFinding[] };

// ─── ZoneStatusGrid ───────────────────────────────────────────────────────────
// Shared color-coded zone grid used by:
//   • WetCheckInspectionSummary — the Slice 5 pre-submit review screen
//   • ZoneOverviewSheet          — the Slice 4 bottom-sheet "View All" overlay
//
// Color scheme:
//   green  → checked_ok
//   amber  → checked_with_issues
//   gray   → not_applicable
//   white + amber border + ⚠ icon → not_checked (skipped / never visited)
//
// Optional props:
//   activeLetter / activeZone — highlight the currently active zone with a
//     blue ring (used by ZoneOverviewSheet to show where the tech is).
//   showPhotoCounts / photos  — overlay a tiny photo-count badge on each cell.
//   onCellClick               — called when the user taps a zone cell.

export function ZoneStatusGrid({
  controllers,
  zoneRecords,
  activeLetter,
  activeZone,
  showPhotoCounts = false,
  photos = [],
  onCellClick,
}: {
  controllers: CustomerController[];
  zoneRecords: ZoneRecordWithFindings[];
  activeLetter?: string | null;
  activeZone?: number | null;
  showPhotoCounts?: boolean;
  photos?: { zoneRecordId: number | null; findingId: number | null }[];
  onCellClick?: (letter: string, zone: number) => void;
}) {
  const recordMap = new Map(
    zoneRecords.map((r) => [`${r.controllerLetter}-${r.zoneNumber}`, r]),
  );

  function photoCountForZone(r: ZoneRecordWithFindings | undefined): number {
    if (!r || !showPhotoCounts) return 0;
    const findingIds = new Set(asArray(r.findings).map((f) => f.id));
    return photos.filter(
      (p) =>
        p.zoneRecordId === r.id ||
        (p.findingId != null && findingIds.has(p.findingId)),
    ).length;
  }

  function cellClass(r: ZoneRecordWithFindings | undefined, letter: string, zone: number): string {
    const isActive = letter === activeLetter && zone === activeZone;
    const ring = isActive ? " ring-2 ring-blue-500 ring-offset-1" : "";
    const base =
      "relative aspect-square min-h-[44px] text-xs font-semibold rounded transition-transform active:scale-95";

    const status = r?.status ?? "not_checked";
    if (status === "checked_ok") return `${base} bg-green-500 text-white${ring}`;
    if (status === "checked_with_issues") return `${base} bg-amber-500 text-white${ring}`;
    if (status === "not_applicable") return `${base} bg-gray-400 text-white${ring}`;
    // not_checked — white cell with amber warning border
    return `${base} bg-white border-2 border-amber-400 text-amber-700${ring}`;
  }

  return (
    <div className="space-y-5" data-testid="zone-status-grid">
      {controllers.map((ctrl) => {
        const tint = tintForControllerLetter(ctrl.controllerLetter);
        return (
          <div key={ctrl.controllerLetter}>
            <div className={`text-xs uppercase tracking-wide font-bold mb-2 ${tint.label}`}>
              Controller {ctrl.controllerLetter}
            </div>
            <div className="grid grid-cols-6 sm:grid-cols-10 gap-1.5">
              {Array.from({ length: ctrl.zoneCount ?? 0 }, (_, i) => i + 1).map((n) => {
                const r = recordMap.get(`${ctrl.controllerLetter}-${n}`);
                const status = r?.status ?? "not_checked";
                const isMarkedComplete =
                  status === "checked_with_issues" && r?.markedCompleteAt != null;
                const photoCount = photoCountForZone(r);

                return (
                  <button
                    key={n}
                    className={cellClass(r, ctrl.controllerLetter, n)}
                    onClick={() => onCellClick?.(ctrl.controllerLetter, n)}
                    data-testid={`grid-zone-${ctrl.controllerLetter}-${n}`}
                    aria-label={`Controller ${ctrl.controllerLetter} Zone ${n}${
                      r ? ` — ${r.status}` : " — not checked"
                    }`}
                  >
                    {n}

                    {/* Unchecked warning icon */}
                    {status === "not_checked" && (
                      <span
                        className="absolute -top-1 -right-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-amber-400 text-white shadow"
                        aria-hidden
                      >
                        <AlertTriangle className="w-2 h-2" strokeWidth={3} />
                      </span>
                    )}

                    {/* Marked-complete check badge */}
                    {isMarkedComplete && (
                      <span
                        className="absolute -top-1 -right-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white text-green-600 shadow ring-1 ring-green-600"
                        aria-hidden
                      >
                        <CheckCircle2 className="w-2.5 h-2.5" strokeWidth={3} />
                      </span>
                    )}

                    {/* Photo count badge */}
                    {photoCount > 0 && (
                      <span
                        className="absolute -bottom-1 -right-1 inline-flex items-center justify-center min-w-[12px] h-3 px-0.5 rounded-full bg-white text-[8px] font-bold text-gray-800 shadow ring-1 ring-gray-400"
                        aria-hidden
                      >
                        <Camera className="w-1.5 h-1.5 mr-px" />
                        {photoCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
