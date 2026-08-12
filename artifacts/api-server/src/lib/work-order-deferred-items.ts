// Task #1935 — pure diff function: estimate items vs completed work-order items.
//
// No Express or database dependencies — importable by both the route layer
// and tests without side effects.

const NULL_SENTINEL = '\x00';

/**
 * Build a stable matching key for `IS NOT DISTINCT FROM` semantics on the
 * four identity columns.  Two null values compare as equal, matching PostgreSQL
 * IS NOT DISTINCT FROM behaviour for null fields.
 */
export function deferredItemKey(
  partName: string,
  controllerLetter: string | null | undefined,
  zoneNumber: number | null | undefined,
  issueType: string | null | undefined,
): string {
  return [
    partName,
    controllerLetter ?? NULL_SENTINEL,
    zoneNumber != null ? String(zoneNumber) : NULL_SENTINEL,
    issueType ?? NULL_SENTINEL,
  ].join('\x01');
}

export type EstimateItemInput = {
  partId?: number | null;
  partName: string;
  partPrice: string;
  quantity: number;
  laborHours: string;
  controllerLetter?: string | null;
  zoneNumber?: number | null;
  issueType?: string | null;
};

export type CompletedItemInput = {
  partName: string;
  quantity: number;
  controllerLetter?: string | null;
  zoneNumber?: number | null;
  issueType?: string | null;
};

export type DeferredItem = {
  partId: number | null;
  partName: string;
  partPrice: string;
  laborHours: string;
  /** Shortfall quantity (estimate qty minus completed qty, always ≥ 1). */
  quantity: number;
  controllerLetter: string | null;
  zoneNumber: number | null;
  issueType: string | null;
};

/**
 * Compares estimate items against the set of items submitted on a completed
 * work order.  Returns the subset that was not done (or was only partially
 * done), carrying the shortfall quantity.
 *
 * Matching is by partName + controllerLetter + zoneNumber + issueType with
 * IS NOT DISTINCT FROM semantics (nulls compare as equal).
 *
 * Multiset semantics: completed units are "consumed" in estimate-row order.
 * When two estimate rows share the same identity key, each unit of completed
 * work satisfies exactly one estimate row's quantity — it is not applied
 * independently to every matching row.  This preserves the correct residual
 * quantity when the estimate has duplicate rows (e.g. two lines for the same
 * repair type, each with qty=1, and only one was completed → one deferred).
 *
 * Pure: no side effects, no I/O.
 */
export function computeDeferredItems(
  estimateItems: EstimateItemInput[],
  completedItems: CompletedItemInput[],
): DeferredItem[] {
  // Build a mutable budget of remaining completed units keyed by identity.
  // Each unit is consumed exactly once as we walk the estimate rows in order.
  const remainingByKey = new Map<string, number>();
  for (const item of completedItems) {
    const key = deferredItemKey(
      item.partName,
      item.controllerLetter ?? null,
      item.zoneNumber ?? null,
      item.issueType ?? null,
    );
    remainingByKey.set(key, (remainingByKey.get(key) ?? 0) + item.quantity);
  }

  const deferred: DeferredItem[] = [];
  for (const item of estimateItems) {
    const key = deferredItemKey(
      item.partName,
      item.controllerLetter ?? null,
      item.zoneNumber ?? null,
      item.issueType ?? null,
    );
    const available = remainingByKey.get(key) ?? 0;
    const consumed = Math.min(available, item.quantity);
    remainingByKey.set(key, available - consumed); // consume the units used here
    const shortfall = item.quantity - consumed;
    if (shortfall <= 0) continue; // fully satisfied by remaining budget

    deferred.push({
      partId: item.partId ?? null,
      partName: item.partName,
      partPrice: item.partPrice,
      laborHours: item.laborHours,
      quantity: shortfall,
      controllerLetter: item.controllerLetter ?? null,
      zoneNumber: item.zoneNumber ?? null,
      issueType: item.issueType ?? null,
    });
  }

  return deferred;
}
