/**
 * WC Billing Slice 5 — Zone-grouped billing view component
 *
 * Renders the WetCheckBillingView payload from
 * GET /api/billing-sheets/:id/wet-check-view in a structured
 * zone-grouped layout:
 *   Repairs Summary → per-zone sections → Inspection section → totals footer
 *
 * Suppression rule: $0.00 non-labor-only line items are hidden.
 * Labor-only items (noPartNeeded === true) are always shown.
 */

import { format } from "date-fns";
import { Wrench, MapPin, ClipboardList, DollarSign, CloudSun, Camera, Info } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ZoneLaborEditInline } from "@/components/wet-check-billings/zone-labor-edit-inline";
import { FindingQuantityEditInline } from "@/components/wet-check-billings/finding-quantity-edit-inline";
import { EditableField } from "@/components/ui/editable-field";
import { authedPhotoSrc } from "@/lib/queryClient";

// ─── Mirrored types (match artifacts/api-server/src/wet-check-billing-view.ts) ─

export interface WcvLineItem {
  findingId: number;
  issueType: string;
  /** Human-readable label from issueTypeConfigs; title-cased fallback */
  issueDisplayLabel: string;
  partName: string | null;
  quantity: number;
  unitPrice: string;
  partsTotal: string;
  laborHours: string;
  laborTotal: string;
  lineTotal: string;
  /** True when the finding is labor-only (no part required). Always shown. */
  noPartNeeded: boolean;
  notes: string | null;
  /** URLs of photos attached to this finding. Empty when no photos. */
  findingPhotoUrls: string[];
  /** Catalog default labor per unit, used to preview quantity corrections. */
  catalogLaborHours?: string;
}

export interface WcvZone {
  /** PK of the wet_check_zone_records row. Used by billing-manager labor edits. */
  zoneRecordId: number;
  controllerLetter: string;
  zoneNumber: number;
  /** Formatted label e.g. "A-1" */
  zoneLabel: string;
  /** Authoritative zone-level repair labor hours (Slice 4 Option B) */
  repairLaborHours: string;
  /** True when repairLaborHours was manually overridden (not auto-computed). */
  repairLaborManuallySet: boolean;
  lineItems: WcvLineItem[];
  zonePartsSubtotal: string;
  zoneLaborSubtotal: string;
  zoneTotal: string;
  /** URLs of photos attached at the zone level (not linked to any finding). */
  zonePhotoUrls: string[];
}

export interface WcvInspection {
  wetCheckId: number;
  technicianName: string;
  inspectionDate: string;
  propertyAddress: string | null;
  weather: string | null;
  notes: string | null;
}

export interface WetCheckBillingView {
  billingSheetId?: number;
  /**
   * Set when the findings for this billing sheet originate from a
   * wet_check_billings row (WCB flow). When present, rate-mode mutations
   * should target `/api/wet-check-billings/:wetCheckBillingId/rate-mode`
   * rather than the billing-sheet endpoint.
   */
  wetCheckBillingId?: number;
  wetCheckBillingStatus?: string | null;
  wetCheckBillingInvoiceId?: number | null;
  billingNumber: string;
  customerId: number;
  customerName: string;
  workDate: string;
  laborRate: string;
  inspection: WcvInspection;
  /** Zones already sorted by controllerLetter ASC, zoneNumber ASC */
  zones: WcvZone[];
  /** e.g. "3 repairs across 2 zones" */
  repairsSummary: string;
  partsSubtotal: string;
  laborSubtotal: string;
  grandTotal: string;
  /** Slice 4c — "wcb_snapshot" | "live_derive" */
  totalsSource?: "wcb_snapshot" | "live_derive";
  /** Slice 4c — true when zone labor breakdown is stale vs the snapshot */
  zonesHaveStaleLaborData?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toNum(s: string | null | undefined): number {
  const n = parseFloat(s ?? "0");
  return isNaN(n) ? 0 : n;
}

const currency = (val: number | string | null | undefined) => {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(isNaN(n) ? 0 : n);
};

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  try { return format(new Date(iso), "MMM d, yyyy"); } catch { return "—"; }
};

/**
 * A line item is suppressed when:
 *   - lineTotal is $0.00 (or effectively zero), AND
 *   - the item is NOT labor-only (noPartNeeded === false)
 * Labor-only items are always shown regardless of amount.
 */
function shouldShowLineItem(item: WcvLineItem): boolean {
  if (item.noPartNeeded) return true;
  return toNum(item.lineTotal) !== 0;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Compact inline photo strip used for both zone-level and finding-level photos. */
function PhotoStrip({
  urls,
  label,
}: {
  urls: string[];
  label?: string;
}) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2" data-testid="photo-strip">
      {label && (
        <p className="flex items-center gap-1 text-xs font-medium text-gray-500 mb-1.5">
          <Camera className="w-3 h-3" />
          {label}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <a
            key={i}
            href={authedPhotoSrc(url, "medium")}
            target="_blank"
            rel="noopener noreferrer"
            className="block flex-shrink-0"
            data-testid={`photo-thumb-${i}`}
          >
            <img
              src={authedPhotoSrc(url, "thumb")}
              alt={`Photo ${i + 1}`}
              className="w-20 h-20 object-cover rounded border border-gray-200 hover:opacity-90 transition-opacity"
              loading="lazy"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

function ZoneSection({
  zone,
  canSeePricing,
  wcbId,
  canEditLabor,
  canEditQuantity,
  laborRate,
  billingSheetId,
}: {
  zone: WcvZone;
  canSeePricing: boolean;
  wcbId?: number;
  canEditLabor?: boolean;
  canEditQuantity?: boolean;
  laborRate?: string;
  billingSheetId?: number;
}) {
  const visibleItems = zone.lineItems.filter(shouldShowLineItem);
  const repairLaborNum = toNum(zone.repairLaborHours);
  const zonePhotos = zone.zonePhotoUrls ?? [];

  return (
    <div
      className="border border-gray-200 rounded-lg overflow-hidden"
      data-testid={`zone-section-${zone.zoneLabel}`}
    >
      {/* Zone header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-blue-50 border-b border-blue-100">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-semibold text-blue-900">
            Zone {zone.zoneLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {zonePhotos.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-600">
              <Camera className="w-3 h-3" />
              {zonePhotos.length}
            </span>
          )}
          {canSeePricing && (
            <span className="text-sm font-semibold text-blue-800">
              {currency(zone.zoneTotal)}
            </span>
          )}
        </div>
      </div>

      <div className="p-3 space-y-2">
        {/* Zone-level photos (appear before findings table) */}
        {zonePhotos.length > 0 && (
          <PhotoStrip
            urls={zonePhotos}
            label={`Zone ${zone.zoneLabel} photos`}
          />
        )}

        {/* Line items */}
        {visibleItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid={`zone-items-table-${zone.zoneLabel}`}>
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left pb-1.5 font-medium text-gray-500 pr-3 text-xs uppercase tracking-wide">
                    Repair
                  </th>
                  {canSeePricing && (
                    <>
                      <th className="text-center pb-1.5 font-medium text-gray-500 px-2 text-xs uppercase tracking-wide whitespace-nowrap">
                        Qty
                      </th>
                      <th className="text-right pb-1.5 font-medium text-gray-500 px-2 text-xs uppercase tracking-wide whitespace-nowrap">
                        Unit $
                      </th>
                      <th className="text-right pb-1.5 font-medium text-gray-500 pl-2 text-xs uppercase tracking-wide whitespace-nowrap">
                        Parts
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {visibleItems.map((item) => {
                  const findingPhotos = item.findingPhotoUrls ?? [];
                  return (
                    <tr key={item.findingId} className="hover:bg-gray-50 align-top">
                      <td className="py-2 pr-3">
                        <p
                          className="font-medium text-gray-900 text-sm"
                          data-testid={`line-item-label-${item.findingId}`}
                        >
                          {item.issueDisplayLabel}
                          {item.noPartNeeded && (
                            <span className="ml-1.5 text-xs font-normal text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
                              Labor Only
                            </span>
                          )}
                        </p>
                        {item.partName && !item.noPartNeeded && (
                          <p className="text-xs text-gray-500 mt-0.5">{item.partName}</p>
                        )}
                        {item.notes && (
                          <p className="text-xs text-gray-400 mt-0.5 italic">{item.notes}</p>
                        )}
                        {findingPhotos.length > 0 && (
                          <PhotoStrip urls={findingPhotos} />
                        )}
                      </td>
                      {canSeePricing && (
                        <>
                          <td className="py-2 px-2 text-center text-gray-700 text-sm">
                            {item.noPartNeeded ? "—" : wcbId != null ? (
                              <FindingQuantityEditInline
                                wcbId={wcbId}
                                item={item}
                                zoneLabel={zone.zoneLabel}
                                zoneLaborHours={zone.repairLaborHours}
                                laborRate={laborRate ?? "0"}
                                allItems={zone.lineItems}
                                canEdit={!!canEditQuantity}
                                laborWasManual={zone.repairLaborManuallySet}
                                billingSheetId={billingSheetId}
                              />
                            ) : item.quantity}
                          </td>
                          <td className="py-2 px-2 text-right text-gray-700 text-sm">
                            {item.noPartNeeded ? "—" : currency(item.unitPrice)}
                          </td>
                          <td className="py-2 pl-2 text-right font-medium text-gray-900 text-sm">
                            {item.noPartNeeded ? "—" : currency(item.partsTotal)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-400 italic">No billable parts for this zone.</p>
        )}

        {/* Zone labor row — inline editor when in billing modal context (wcbId present),
            read-only display otherwise. Always rendered regardless of canSeePricing so
            field_tech can see hours and auto/manual badge; dollar value is suppressed
            when canSeePricing=false via the canSeePricing prop on ZoneLaborEditInline. */}
        {wcbId != null ? (
          <ZoneLaborEditInline
            wcbId={wcbId}
            zoneRecordId={zone.zoneRecordId}
            valueHours={zone.repairLaborHours}
            manuallySet={zone.repairLaborManuallySet}
            laborRate={laborRate ?? "0"}
            canEdit={!!canEditLabor}
            canSeePricing={canSeePricing}
          />
        ) : (
          canSeePricing && repairLaborNum > 0 && (
            <div className="flex items-center justify-between pt-1 border-t border-dashed border-gray-200 mt-1">
              <span className="text-xs text-gray-500">
                Repair labor ({repairLaborNum.toFixed(2)} hr{repairLaborNum !== 1 ? "s" : ""})
              </span>
              <span className="text-sm font-medium text-gray-700">
                {currency(zone.zoneLaborSubtotal)}
              </span>
            </div>
          )
        )}

        {/* Zone subtotal */}
        {canSeePricing && (
          <div className="flex items-center justify-between pt-1 border-t border-gray-200 mt-1">
            <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Zone Subtotal</span>
            <span className="text-sm font-bold text-gray-900">{currency(zone.zoneTotal)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface WetCheckBillingViewProps {
  view: WetCheckBillingView;
  canSeePricing: boolean;
  /** When present, the zone-labor inline editor is rendered (billing-manager modal context). */
  wcbId?: number;
  /** True when the current user can edit zone labor (billing_manager+ on unlocked WCB). */
  canEditLabor?: boolean;
  /** True when the current user can edit part-backed finding quantities. */
  canEditQuantity?: boolean;
  /** Applied labor rate for the inline dollar-value calculation, e.g. "80.00". */
  laborRate?: string;
  /** True when the current user can edit inspection notes. */
  canEditInspectionNotes?: boolean;
  /** Callback to persist updated inspection notes. */
  onSaveInspectionNotes?: (notes: string) => Promise<void>;
}

export function WetCheckBillingViewComponent({
  view,
  canSeePricing,
  wcbId,
  canEditLabor,
  canEditQuantity,
  laborRate,
  canEditInspectionNotes,
  onSaveInspectionNotes,
}: WetCheckBillingViewProps) {
  const totalFindings = view.zones.reduce((s, z) => s + z.lineItems.length, 0);

  return (
    <div className="space-y-4" data-testid="wet-check-billing-view">

      {/* Repairs Summary table */}
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
          <Wrench className="w-4 h-4 text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-800">
            Repairs Summary
          </h3>
          <span className="ml-auto text-xs text-gray-500">{view.repairsSummary}</span>
        </div>
        <div className="p-4">
          {view.zones.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="repairs-summary-table">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left pb-2 font-medium text-gray-600 pr-3">Zone</th>
                    <th className="text-center pb-2 font-medium text-gray-600 px-2 whitespace-nowrap">Repairs</th>
                    {canSeePricing && (
                      <>
                        <th className="text-right pb-2 font-medium text-gray-600 px-2 whitespace-nowrap">Parts</th>
                        <th className="text-right pb-2 font-medium text-gray-600 px-2 whitespace-nowrap">Repair Hrs</th>
                        <th className="text-right pb-2 font-medium text-gray-600 pl-2 whitespace-nowrap">Zone Total</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {view.zones.map((zone) => (
                    <tr key={zone.zoneLabel} className="hover:bg-gray-50">
                      <td
                        className="py-2.5 pr-3 font-medium text-gray-900"
                        data-testid={`summary-zone-label-${zone.zoneLabel}`}
                      >
                        Zone {zone.zoneLabel}
                      </td>
                      <td className="py-2.5 px-2 text-center text-gray-700">
                        {zone.lineItems.length}
                      </td>
                      {canSeePricing && (
                        <>
                          <td className="py-2.5 px-2 text-right text-gray-700">
                            {currency(zone.zonePartsSubtotal)}
                          </td>
                          <td className="py-2.5 px-2 text-right text-gray-700">
                            <span className="inline-flex items-center justify-end gap-1.5">
                              {zone.repairLaborManuallySet ? (
                                <span
                                  className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-300"
                                  data-testid={`repair-labor-badge-manual-${zone.zoneLabel}`}
                                >
                                  manual
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200"
                                  data-testid={`repair-labor-badge-auto-${zone.zoneLabel}`}
                                >
                                  auto
                                </span>
                              )}
                              {toNum(zone.repairLaborHours).toFixed(2)}
                            </span>
                          </td>
                          <td className="py-2.5 pl-2 text-right font-semibold text-gray-900">
                            {currency(zone.zoneTotal)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                {canSeePricing && (
                  <tfoot>
                    <tr className="border-t border-gray-200">
                      <td className="pt-2 font-semibold text-gray-700" colSpan={2}>
                        Total
                      </td>
                      <td className="pt-2 text-right font-semibold text-gray-700">
                        {currency(view.partsSubtotal)}
                      </td>
                      <td className="pt-2 text-right font-semibold text-gray-700">
                        {view.zones.reduce((s, z) => s + toNum(z.repairLaborHours), 0).toFixed(2)}
                      </td>
                      <td className="pt-2 text-right font-bold text-blue-700">
                        {currency(view.grandTotal)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-2">No repair zones found.</p>
          )}
        </div>
      </div>

      {/* Per-zone sections */}
      {view.zones.length > 0 && (
        <div className="border border-gray-100 rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
            <MapPin className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-800">
              Zone Details
            </h3>
            <span className="ml-auto text-xs text-gray-500">
              {totalFindings} finding{totalFindings !== 1 ? "s" : ""} across {view.zones.length} zone{view.zones.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="p-4 space-y-3">
            {view.zones.map((zone) => (
              <ZoneSection
                key={zone.zoneLabel}
                zone={zone}
                canSeePricing={canSeePricing}
                wcbId={wcbId}
                canEditLabor={canEditLabor}
                canEditQuantity={canEditQuantity ?? canEditLabor}
                laborRate={laborRate}
        billingSheetId={view.billingSheetId}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inspection section */}
      <div
        className="border border-gray-100 rounded-xl overflow-hidden"
        data-testid="inspection-section"
      >
        <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
          <ClipboardList className="w-4 h-4 text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-800">Inspection</h3>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Technician</p>
            <p className="text-gray-900">{view.inspection.technicianName}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Inspection Date</p>
            <p className="text-gray-900">{fmtDate(view.inspection.inspectionDate)}</p>
          </div>
          {view.inspection.propertyAddress && (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Property Address</p>
              <p className="text-gray-900">{view.inspection.propertyAddress}</p>
            </div>
          )}
          {view.inspection.weather && (
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5 flex items-center gap-1">
                <CloudSun className="w-3 h-3" /> Weather
              </p>
              <p className="text-gray-900">{view.inspection.weather}</p>
            </div>
          )}
          {(view.inspection.notes || canEditInspectionNotes) && (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-0.5">Inspection Notes</p>
              {canEditInspectionNotes && onSaveInspectionNotes ? (
                <EditableField
                  fieldId="inspectionNotes"
                  value={view.inspection.notes ?? ""}
                  onSave={onSaveInspectionNotes}
                  canEdit={true}
                  type="textarea"
                  placeholder="Add technician inspection notes…"
                >
                  <p className="text-gray-800 bg-gray-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap text-sm min-h-[2.5rem]">
                    {view.inspection.notes || <span className="text-gray-400 italic">No inspection notes</span>}
                  </p>
                </EditableField>
              ) : (
                <p className="text-gray-800 bg-gray-50 rounded-lg p-3 leading-relaxed whitespace-pre-wrap text-sm">
                  {view.inspection.notes}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Totals footer */}
      {canSeePricing && (
        <div className="border border-gray-100 rounded-xl overflow-hidden">
          {view.zonesHaveStaleLaborData && (
            <div className="px-4 py-2 text-xs text-amber-700 bg-amber-50 rounded-t-xl flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                Per-zone labor breakdown is approximate for this WCB. The total
                shown below comes from the stored billing snapshot and is what
                the customer is invoiced.
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
            <DollarSign className="w-4 h-4 text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-800">WC Sheet Totals</h3>
          </div>
          <div className="p-4 space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Parts Subtotal</span>
              <span className="font-medium text-gray-900">{currency(view.partsSubtotal)}</span>
            </div>
            <div className="flex justify-between text-sm text-gray-600">
              <span>Repair Labor Subtotal</span>
              <span className="font-medium text-gray-900">{currency(view.laborSubtotal)}</span>
            </div>
            <Separator className="my-2" />
            <div className="flex justify-between items-center">
              <span className="text-base font-semibold text-gray-900">Grand Total</span>
              <span className="text-xl font-bold text-blue-700" data-testid="wc-grand-total">
                {currency(view.grandTotal)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
