// Reconcile seam — Slice 6 + Task #1856 (stored letter).
//
// `resolveWetCheckControllers` is the single call site that the wet-check
// capture and grid screens use to determine which controllers/zones to display
// for a customer+branch. It reads from `irrigation_controllers` (the canonical
// post-unification table). When no rows exist yet for the customer+branch,
// it seeds from `customers.totalControllers` (clamped 1–26) via
// `ensureIrrigationControllers` rather than reading the now-dropped
// `property_controllers` table.
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

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Returns the controllers that should drive the wet-check grid for a given
 * customer+branch combination.
 *
 * 1. `irrigation_controllers` for this (companyId, customerId, branchName) tuple —
 *    the canonical post-unification source.
 * 2. When no rows exist, seed from `customers.totalControllers` (clamped 1–26)
 *    so customers that have never had a wet check still get a grid.
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

  // 2. No irrigation profile yet — seed from customers.totalControllers.
  //    This handles customers that have no irrigation_controllers rows at all
  //    (the legacy table is gone; this is the only seeding path).
  const customer = await storage.getCustomer(customerId);
  const numCtrl = Math.min(26, Math.max(1, customer?.totalControllers ?? 1));
  const seedConfigs = Array.from({ length: numCtrl }, (_, i) => ({
    name: `Controller ${ALPHABET[i]}`,
    zoneCount: null as number | null,
  }));
  const seeded = await storage.ensureIrrigationControllers(
    companyId,
    customerId,
    seedConfigs,
    branchArg ?? null,
  );
  return seeded.map((ctrl, index) => ({
    letter: ctrl.letter ?? ALPHABET[index] ?? String(index),
    zoneCount: ctrl.totalZones ?? null,
    notes: ctrl.notes ?? null,
    name: ctrl.name,
    id: ctrl.id,
  }));
}
