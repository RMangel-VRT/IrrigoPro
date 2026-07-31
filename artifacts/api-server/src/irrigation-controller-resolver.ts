// Reconcile seam — Slice 6 + Task #1856 (stored letter).
//
// `resolveWetCheckControllers` is the single call site that the wet-check
// capture and grid screens use to determine which controllers/zones to display
// for a customer+branch. It now reads from `irrigation_controllers` first
// (the canonical post-unification table), falling back to the legacy
// `property_controllers` table only when no irrigation profile exists for
// the customer+branch yet (pre-seed state).
//
// Mapping from irrigation_controllers → wet-check grid shape:
//   letter:      stored column (Task #1856) — never derived from name
//   totalZones:  integer | null → zoneCount: number | null (null passed through; no fallback)
//   notes:       string | null  → notes: string | null

import { storage } from "./storage";

export interface ResolvedController {
  letter: string;
  zoneCount: number | null;
  notes: string | null;
  name: string;
  id: number;
}

/**
 * Returns the controllers that should drive the wet-check grid for a given
 * customer+branch combination.
 *
 * Priority:
 *  1. `irrigation_controllers` for this (companyId, customerId, branchName) tuple —
 *     the canonical post-unification source.
 *  2. Legacy `property_controllers` — only when no irrigation profile exists yet
 *     (pre-seed state, before the admin migration or lazy-seed has run).
 */
export async function resolveWetCheckControllers(
  companyId: number,
  customerId: number,
  branchName?: string | null,
): Promise<ResolvedController[]> {
  const branch = branchName ?? null;
  const branchArg = typeof branch === "string" ? branch : undefined;

  // 1. Try irrigation_controllers first (single source of truth).
  const irrigCtrls = await storage.listIrrigationControllers(
    companyId,
    customerId,
    branchArg,
  );

  if (irrigCtrls.length > 0) {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    return irrigCtrls.map((ctrl, index) => ({
      // Use stored letter (Task #1856). Fall back to positional A,B,C only
      // for rows that predate the backfill (letter IS NULL).
      letter: ctrl.letter ?? ALPHABET[index] ?? String(index),
      zoneCount: ctrl.totalZones ?? null,
      notes: ctrl.notes ?? null,
      name: ctrl.name,
      id: ctrl.id,
    }));
  }

  // 2. Fall back to property_controllers (legacy pre-seed state).
  const legacyRows = await storage.listPropertyControllers(companyId, customerId);
  const filtered = branch !== null
    ? legacyRows.filter((r) => (r.branchName || null) === branch)
    : legacyRows;

  return filtered.map((r) => ({
    letter: r.controllerLetter,
    zoneCount: r.zoneCount,
    notes: r.notes ?? null,
    name: `Controller ${r.controllerLetter}`,
    id: 0,
  }));
}
