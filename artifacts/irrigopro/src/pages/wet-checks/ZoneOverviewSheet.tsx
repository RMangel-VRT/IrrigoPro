import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { ZoneStatusGrid, type ZoneRecordWithFindings } from "./ZoneStatusGrid";
import type { CustomerController } from "@/lib/controller-types";

export function ZoneOverviewSheet({
  open,
  onClose,
  controllers,
  zoneRecords,
  activeLetter,
  activeZone,
  onNavigate,
  photos,
}: {
  open: boolean;
  onClose: () => void;
  controllers: CustomerController[];
  zoneRecords: ZoneRecordWithFindings[];
  activeLetter: string;
  activeZone: number;
  onNavigate: (letter: string, zone: number) => void;
  photos: { zoneRecordId: number | null; findingId: number | null }[];
}) {
  const recordMap = new Map(
    zoneRecords.map((r) => [`${r.controllerLetter}-${r.zoneNumber}`, r]),
  );

  let okCount = 0;
  let needsWorkCount = 0;
  let naCount = 0;
  let uncheckedCount = 0;

  for (const c of controllers) {
    for (let z = 1; z <= (c.zoneCount ?? 0); z++) {
      const r = recordMap.get(`${c.controllerLetter}-${z}`);
      if (!r || r.status === "not_checked") uncheckedCount++;
      else if (r.status === "checked_ok") okCount++;
      else if (r.status === "checked_with_issues") needsWorkCount++;
      else if (r.status === "not_applicable") naCount++;
    }
  }

  return (
    <Sheet open={open} onOpenChange={(b) => { if (!b) onClose(); }}>
      <SheetContent
        side="bottom"
        className="h-[80vh] sm:h-[70vh] overflow-y-auto pb-safe"
        data-testid="zone-overview-sheet"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>All Zones</SheetTitle>
        </SheetHeader>

        <div className="flex flex-wrap items-center gap-1.5 mb-4 text-xs">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500 text-white font-semibold">
            ✓ OK · {okCount}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-white font-semibold">
            ! Needs work · {needsWorkCount}
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-400 text-white font-semibold">
            N/A · {naCount}
          </span>
          {uncheckedCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border-2 border-amber-400 text-amber-700 font-semibold">
              <AlertTriangle className="w-3 h-3" />
              Remaining · {uncheckedCount}
            </span>
          )}
        </div>

        <ZoneStatusGrid
          controllers={controllers}
          zoneRecords={zoneRecords}
          activeLetter={activeLetter}
          activeZone={activeZone}
          showPhotoCounts
          photos={photos}
          onCellClick={(letter, zone) => {
            onNavigate(letter, zone);
            onClose();
          }}
        />

        <div className="pt-4">
          <Button variant="outline" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
