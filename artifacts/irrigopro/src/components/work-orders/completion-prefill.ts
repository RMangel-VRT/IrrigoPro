/**
 * Pre-fill math for the work order completion form's "Total Hours" field.
 *
 * Bug history (Woodglenn WO-1783955816671-314): the old pre-fill summed
 * `item.laborHours × item.quantity` across all work order items. But each
 * item's laborHours is already the LINE TOTAL — inspection-derived estimates
 * merge findings into one row and SUM their hours (see
 * api-server/src/inspection-estimate-items.ts), so an "Adjust ×4" row's
 * laborHours covers all 4 adjustments. Multiplying by quantity again roughly
 * doubled the hours (72.50 estimated → 140.25 pre-filled), and techs accepted
 * the inflated value into billing.
 *
 * Correct behavior:
 *  - flat mode (the system default): the work order's header totalHours —
 *    carried over from the approved estimate's flat total — is the source of
 *    truth. Fall back to a plain sum of line laborHours (no × quantity) only
 *    when the header is missing/zero.
 *  - per_part mode: delegate to the shared sumCompletionLaborHours function
 *    which correctly handles inspection-derived rows (findingId non-null →
 *    line total, no × quantity) and field-added rows (findingId null →
 *    per-unit × quantity).
 */

import { sumCompletionLaborHours } from "@workspace/shared";

export interface PrefillWorkOrder {
  laborMode?: string | null;
  totalHours?: string | number | null;
}

export interface PrefillItem {
  laborHours?: string | number | null;
  quantity?: string | number | null;
  /** Wet-check issue type — non-null on inspection-derived rows. Primary discriminator. */
  issueType?: string | null;
  /** Slice 3 lineage FK — non-null when findingId has been propagated. Secondary discriminator. */
  findingId?: number | null;
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

export function computeCompletionPrefillHours(
  workOrder: PrefillWorkOrder,
  items: PrefillItem[],
): number {
  if (workOrder.laborMode === "per_part") {
    return sumCompletionLaborHours(items);
  }
  const headerHours = num(workOrder.totalHours);
  if (headerHours > 0) return headerHours;
  // Line laborHours are line totals — never multiply by quantity here.
  return items.reduce((t, it) => t + num(it.laborHours), 0);
}
