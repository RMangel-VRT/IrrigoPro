import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { authedPhotoSrc } from "@/lib/queryClient";
import { Wrench, MapPin, StickyNote, Pencil, Camera, Info, Flag, type LucideIcon } from "lucide-react";
import { PartPicker } from "@/components/parts/part-picker";
import { CUSTOM_REVIEW_ISSUE_TYPE } from "@/lib/finding-save-payload";
import type {
  Part, WetCheckFindingWithReason, WetCheckPhoto, WetCheckZoneRecord, IssueTypeConfig,
} from "@workspace/db/schema";

export interface FindingEdits {
  partId: number | null;
  partName: string | null;
  partPrice: string | null;
  quantity: number;
  laborHours: string;
}

interface FindingCardProps {
  finding: WetCheckFindingWithReason;
  zone: WetCheckZoneRecord;
  photos: WetCheckPhoto[];
  parts: Part[];
  issueConfig: IssueTypeConfig | null;
  customerLaborRate: number;
  edits: FindingEdits;
  onChange: (next: FindingEdits) => void;
}

const ISSUE_ICON: Record<string, { icon: LucideIcon; bg: string; text: string }> = {
  quick_fix:     { icon: Wrench, bg: "bg-blue-100",   text: "text-blue-700" },
  advanced:      { icon: Wrench, bg: "bg-amber-100",  text: "text-amber-700" },
  zone_issue:    { icon: Wrench, bg: "bg-purple-100", text: "text-purple-700" },
  custom_review: { icon: Flag,   bg: "bg-rose-100",   text: "text-rose-700" },
};

function displayLabel(finding: WetCheckFindingWithReason, config: IssueTypeConfig | null): string {
  if (finding.issueType === CUSTOM_REVIEW_ISSUE_TYPE) return "Custom — Flagged for Review";
  return config?.displayLabel ?? finding.partName ?? finding.issueType;
}

export function FindingCard({
  finding, zone, photos, parts, issueConfig, customerLaborRate, edits, onChange,
}: FindingCardProps) {
  const isCustom = finding.issueType === CUSTOM_REVIEW_ISSUE_TYPE;
  const groupKey = isCustom
    ? "custom_review"
    : ((finding.issueGroup ?? "advanced") as keyof typeof ISSUE_ICON);
  const icon = ISSUE_ICON[groupKey] ?? ISSUE_ICON.advanced;
  const Icon = icon.icon;

  const total = useMemo(() => {
    const partPrice = parseFloat(edits.partPrice ?? "0") || 0;
    const labor = parseFloat(edits.laborHours ?? "0") || 0;
    return partPrice * (edits.quantity ?? 0) + labor * customerLaborRate;
  }, [edits, customerLaborRate]);

  const [partPickerOpen, setPartPickerOpen] = useState(false);
  // Task #1827 — tracks whether manager has manually typed a price override.
  // When true, part re-selection does NOT clobber the typed value.
  const [priceManuallySet, setPriceManuallySet] = useState(false);

  const choosePart = (p: Part | null) => {
    // No-clobber: only pull price from catalog when the manager hasn't typed
    // a manual override. A "clear part" (p=null) always clears the price.
    const partPrice = p == null
      ? null
      : priceManuallySet
        ? edits.partPrice
        : String(p.price ?? "0");
    onChange({
      ...edits,
      partId: p?.id ?? null,
      partName: p?.name ?? null,
      partPrice,
    });
    setPartPickerOpen(false);
  };

  return (
    <Card className="border-2 border-blue-300" data-testid={`wizard-finding-${finding.id}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className={`${icon.bg} rounded-md p-2`}>
            <Icon className={`w-5 h-5 ${icon.text}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-gray-500">Pending finding</div>
            <h2 className="text-lg font-semibold text-gray-900 truncate flex items-center gap-2" data-testid={`wizard-finding-${finding.id}-title`}>
              <span className="truncate">{displayLabel(finding, issueConfig)}</span>
              {photos.length > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-full px-1.5 py-0.5 shrink-0"
                  data-testid={`wizard-finding-${finding.id}-photo-count`}
                  aria-label={`${photos.length} photo${photos.length === 1 ? "" : "s"} attached`}
                >
                  <Camera className="w-3 h-3" aria-hidden />
                  {photos.length}
                </span>
              )}
            </h2>
            {finding.techDisposition && (
              <Badge
                variant="outline"
                className={`mt-1 text-xs ${
                  finding.techDisposition === "completed_in_field"
                    ? "border-green-300 text-green-700 bg-green-50"
                    : "border-amber-300 text-amber-800 bg-amber-50"
                }`}
                data-testid={`wizard-finding-${finding.id}-disposition`}
              >
                Tech: {finding.techDisposition === "completed_in_field" ? "Completed in field" : "Needs manager review"}
              </Badge>
            )}
            {/* Task #464 — labor-only Mark Complete. Shown so the manager
                can see at a glance why the auto-billed sheet has a
                no-parts line for this finding. */}
            {finding.noPartNeeded && (
              <Badge
                variant="outline"
                className="mt-1 ml-1 text-xs border-blue-300 text-blue-700 bg-blue-50"
                data-testid={`wizard-finding-${finding.id}-no-part-needed`}
              >
                No part needed (labor only)
              </Badge>
            )}
          </div>
        </div>

        {finding.pendingReason && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1"
            data-testid={`wizard-finding-${finding.id}-pending-reason`}
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
              <Info className="w-3.5 h-3.5 shrink-0" aria-hidden />
              Why is this pending?
            </div>
            <p className="text-xs text-amber-700 leading-snug">{finding.pendingReason}</p>
            {finding.partId == null && !finding.noPartNeeded && finding.techDisposition === "completed_in_field" && (
              <p className="text-xs text-amber-600 italic">
                Assign a part above before routing to billing.
              </p>
            )}
          </div>
        )}

        <div className="rounded-md border bg-gray-50 p-3 text-sm flex items-center gap-2">
          <MapPin className="w-4 h-4 text-gray-500 shrink-0" />
          <span>Controller {zone.controllerLetter} · Zone {zone.zoneNumber}</span>
        </div>

        {/* Task #1535 — custom_review: description (stored in notes) shown prominently */}
        {isCustom ? (
          <div
            className="rounded-md border-2 border-rose-200 bg-rose-50 p-3 space-y-1"
            data-testid={`wizard-finding-${finding.id}-description`}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 uppercase tracking-wide">
              <Flag className="w-3.5 h-3.5 shrink-0" aria-hidden />
              Tech description
            </div>
            <p className="text-sm text-rose-900 whitespace-pre-wrap leading-snug">
              {finding.notes && finding.notes.trim()
                ? finding.notes
                : <span className="italic opacity-60">No description provided</span>}
            </p>
          </div>
        ) : (
          <div className="rounded-md border bg-gray-50 p-3 text-sm flex items-start gap-2" data-testid={`wizard-finding-${finding.id}-notes`}>
            <StickyNote className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
            <span className="whitespace-pre-wrap">
              {finding.notes && finding.notes.trim()
                ? finding.notes
                : <span className="text-gray-400 italic">No tech notes</span>}
            </span>
          </div>
        )}

        {photos.length > 0 && (
          <div className="flex gap-2 overflow-x-auto" data-testid={`wizard-finding-${finding.id}-photos`}>
            {photos.map(p => (
              <a key={p.id} href={authedPhotoSrc(p.url, "medium")} target="_blank" rel="noreferrer" className="block shrink-0">
                <img src={authedPhotoSrc(p.url, "thumb")} alt="" className="h-20 w-20 object-cover rounded border" loading="lazy" />
              </a>
            ))}
          </div>
        )}

        <div className="rounded-md border p-3 space-y-3 bg-white">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {issueConfig?.laborOnly ? (
              <div className="sm:col-span-3 space-y-1" data-testid={`wizard-finding-${finding.id}-labor-only`}>
                <div className="text-xs text-gray-500">Part</div>
                <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                  <Info className="w-4 h-4 text-blue-500 shrink-0" aria-hidden />
                  <span className="text-sm text-blue-700 font-medium">Labor only — no part required</span>
                </div>
              </div>
            ) : (
              <div className="sm:col-span-3 space-y-1">
                <div className="text-xs text-gray-500">Part</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 text-sm" data-testid={`wizard-finding-${finding.id}-part-name`}>
                    {edits.partName
                      ? edits.partName
                      : <span className="text-gray-400 italic">No part selected</span>}
                  </div>
                  <Button
                    type="button" variant="outline" size="sm"
                    onClick={() => setPartPickerOpen(true)}
                    data-testid={`wizard-finding-${finding.id}-pick-part`}
                  >
                    <Pencil className="w-3 h-3 mr-1" /> Change
                  </Button>
                </div>
                <div className="text-xs space-y-1">
                  <span className="text-gray-500 block">Unit price ($)</span>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={parseFloat(edits.partPrice ?? "0").toFixed(2)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const val = parseFloat(raw || "0");
                      setPriceManuallySet(true);
                      onChange({
                        ...edits,
                        partPrice: isNaN(val) ? "0" : String(Math.max(0, val)),
                      });
                    }}
                    className="h-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    data-testid={`wizard-finding-${finding.id}-price`}
                    aria-label="Unit price"
                  />
                </div>
              </div>
            )}

            {!issueConfig?.laborOnly && (
              <label className="text-xs space-y-1">
                <span className="text-gray-500 block">Quantity</span>
                <Input
                  type="number" min={1} step={1}
                  value={edits.quantity}
                  onChange={e => onChange({ ...edits, quantity: Math.max(1, parseInt(e.target.value || "1") || 1) })}
                  data-testid={`wizard-finding-${finding.id}-qty`}
                />
              </label>
            )}

            <label className="text-xs space-y-1">
              <span className="text-gray-500 block">Labor hours</span>
              <Input
                type="number" min={0} step={0.25}
                value={edits.laborHours}
                onChange={e => onChange({ ...edits, laborHours: e.target.value })}
                data-testid={`wizard-finding-${finding.id}-labor`}
              />
            </label>

            <div className="text-xs space-y-1">
              <span className="text-gray-500 block">Labor rate (read-only)</span>
              <div className="h-9 flex items-center px-3 bg-gray-50 border rounded text-sm">
                ${customerLaborRate.toFixed(2)}/hr
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-gray-500">Estimated total</span>
            <Badge className="text-sm" data-testid={`wizard-finding-${finding.id}-total`}>
              ${total.toFixed(2)}
            </Badge>
          </div>
        </div>
      </CardContent>

      <PartPicker
        open={partPickerOpen}
        onOpenChange={setPartPickerOpen}
        presentation="dialog"
        selectMode="single"
        keyboardNav
        title="Pick a part"
        categoryFilter={issueConfig?.partCategoryFilter ?? null}
        allowClear
        onClear={() => choosePart(null)}
        onSelectPart={(p) => choosePart(p)}
      />
    </Card>
  );
}
