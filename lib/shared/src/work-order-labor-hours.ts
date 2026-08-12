/**
 * Shared labor-hours computation for per_part work orders.
 *
 * Background (Woodglenn WO-1783955816671-314 / Task #1933):
 *   On inspection-derived work order items the `laborHours` column stores a
 *   LINE TOTAL — all findings for the same part/zone are merged into one row
 *   and their hours are accumulated (see inspection-estimate-items.ts).
 *   Multiplying that line total by `quantity` double-counts the hours.
 *
 *   Field-added items store per-unit hours and must be multiplied by quantity.
 *
 * Discriminator — inspection-derived vs. field-added:
 *   Two signals are checked; either one being present marks the row as a
 *   line-total row:
 *
 *   1. `issueType` (primary, reliable today): non-null on every
 *      inspection-derived row because the wet-check finding always carries an
 *      issue type, and inspection-estimate-items.ts propagates it through
 *      estimate items → work order items. Null on field-added rows.
 *
 *   2. `findingId` (secondary, future): the Slice 3 lineage FK linking a WO
 *      item back to the individual wet-check finding. Not yet populated during
 *      estimate→WO conversion (see schema comment on workOrderItems.laborHours),
 *      but checked here so callers that do populate it also benefit.
 *
 * Rule: if issueType is non-null OR findingId is non-null → line total (no ×qty).
 *       Otherwise → per-unit (multiply by quantity).
 *
 * This function is only called from a per_part branch; flat mode never reaches
 * it and must not be added as a case.
 */

export interface LaborHoursItem {
  laborHours?: string | number | null;
  quantity?: string | number | null;
  /** Wet-check issue type. Non-null on all inspection-derived rows. */
  issueType?: string | null;
  /** Slice 3 lineage FK. Non-null when the finding ID has been propagated. */
  findingId?: number | null;
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Sum completion labor hours for a per_part work order.
 *
 * For each item:
 *   - Inspection-derived rows (issueType or findingId non-null): add laborHours
 *     directly — it is already a line total accumulated during the merge.
 *   - Field-added rows (both null): add laborHours × quantity (per-unit).
 */
export function sumCompletionLaborHours(items: LaborHoursItem[]): number {
  return items.reduce((total, it) => {
    const hours = num(it.laborHours);
    if (it.issueType != null || it.findingId != null) {
      // Inspection-derived line total — do not multiply by quantity.
      return total + hours;
    }
    // Field-added per-unit — multiply by quantity.
    return total + hours * num(it.quantity);
  }, 0);
}
