import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WetCheckZoneRecord } from "@workspace/db/schema";
import type { CustomerController } from "@/lib/controller-types";

export function ControllerHeader({
  controller,
  customerId,
  readOnly,
  zoneRecords = [],
  customerName,
  propertyAddress,
}: {
  controller: CustomerController | undefined;
  customerId: number;
  readOnly: boolean;
  zoneRecords?: WetCheckZoneRecord[];
  customerName?: string | null;
  propertyAddress?: string;
}) {
  const { toast } = useToast();
  const [zc, setZc] = useState<string>(controller?.zoneCount != null ? String(controller.zoneCount) : "");
  useEffect(() => { setZc(controller?.zoneCount != null ? String(controller.zoneCount) : ""); }, [controller?.zoneCount]);

  const updateMut = useMutation({
    mutationFn: (n: number) =>
      apiRequest(`/api/properties/${customerId}/controllers`, "PATCH", { controllerLetter: controller!.controllerLetter, zoneCount: n }),
    onSuccess: () => {
      toast({ title: "Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/properties", customerId, "controllers"] });
    },
    onError: (e: any) => toast({ title: "Failed", description: e?.message, variant: "destructive" }),
  });

  if (!controller) return null;

  const ok = zoneRecords.filter(r => r.status === "checked_ok").length;
  const issues = zoneRecords.filter(r => r.status === "checked_with_issues").length;
  const totalZones = controller.zoneCount ?? null;
  const gray = totalZones != null ? Math.max(0, totalZones - ok - issues) : 0;
  const total = ok + issues + gray;
  const okPct = total > 0 ? Math.round((ok / total) * 100) : 0;
  const issPct = total > 0 ? Math.round((issues / total) * 100) : 0;
  const grayPct = total > 0 ? Math.max(0, 100 - okPct - issPct) : 100;

  return (
    <div className="space-y-3">
      {/* Controller name card + property context + zone-count adjuster */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xl font-semibold text-gray-900">
              Controller {controller.controllerLetter}
            </div>
            {(customerName || propertyAddress) && (
              <div className="text-xs text-gray-500 mt-0.5 truncate">
                {[customerName, propertyAddress].filter(Boolean).join(" · ")}
              </div>
            )}
            <div className="text-xs text-gray-400 mt-0.5">
              {controller.zoneCount != null ? `${controller.zoneCount} zones` : "Zone count not set"}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={zc}
              onChange={(e) => setZc(e.target.value)}
              className="w-20 h-10 text-base"
              disabled={readOnly}
              data-testid="input-zone-count"
            />
            <Button
              size="sm"
              disabled={readOnly || updateMut.isPending}
              onClick={() => {
                const n = parseInt(zc);
                if (!Number.isFinite(n) || n < 1 || n > 100) return;
                updateMut.mutate(n);
              }}
              data-testid="btn-save-zone-count"
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-center">
          <div className="text-xl font-bold text-green-600" data-testid="ctrl-header-ok">{ok}</div>
          <div className="text-xs text-gray-500 mt-0.5">Ran OK</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-center">
          <div className="text-xl font-bold text-red-600" data-testid="ctrl-header-issues">{issues}</div>
          <div className="text-xs text-gray-500 mt-0.5">Needs work</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-center">
          <div className="text-xl font-bold text-gray-400" data-testid="ctrl-header-na">{gray}</div>
          <div className="text-xs text-gray-500 mt-0.5">N/A</div>
        </div>
      </div>

      {/* Thin stacked health bar */}
      <div className="flex h-2 rounded-full overflow-hidden w-full gap-px bg-gray-100">
        {ok > 0 && <div className="bg-green-500 transition-all" style={{ width: `${okPct}%` }} />}
        {issues > 0 && <div className="bg-red-500 transition-all" style={{ width: `${issPct}%` }} />}
        {grayPct > 0 && <div className="bg-gray-200 transition-all" style={{ width: `${grayPct}%` }} />}
      </div>
    </div>
  );
}
