// Reconcile seam — Slice 6.
//
// `resolveWetCheckControllers` is the single call site that the wet-check
// capture and grid screens use to determine which controllers/zones to display
// for a customer+branch. It now reads from `irrigation_controllers` first
// (the canonical post-unification table), falling back to the legacy
// `property_controllers` table only when no irrigation profile exists for
// the customer+branch yet (pre-seed state).
//
// Mapping from irrigation_controllers → wet-check grid shape:
//   name:        "Controller A" → letter: "A"
//              OR any descriptive name  → sequential letter A, B, C… by DB sort order
//   totalZones:  integer | null → zoneCount: number | null (null passed through; no fallback)
//   notes:       string | null  → notes: string | null
//
// NOTE: `extractLetter` only matches names where the last word is a single
// letter (the "Controller A" / "Controller B" convention). Customers whose
// irrigation_controllers were seeded with descriptive names such as
// "Hunter Clock - East" or "Rainbird - West" previously returned the last
// character of the last word (e.g. "t" → "T"), which collapsed all cardinal-
// direction-suffixed controllers to the same letter and caused findings to
// bleed across unrelated zones. The resolver now falls back to sequential
// assignment (A, B, C…) for any name that doesn't match the single-letter
// convention, preserving the DB sort order (ORDER BY name, id).

import { storage } from "./storage";

export interface ResolvedController {
  letter: string;
  zoneCount: number | null;
  notes: string | null;
}

/**
 * Extract the single uppercase letter from a controller name.
 *
 * Recognises two forms:
 *  1. A single-character name:            "A"              → "A"
 *  2. "[word] [single-letter]" at start:  "Controller A"   → "A"
 *                                         "Controller B - Hunter Clock West" → "B"
 *                                         "Ctrl C"         → "C"
 *
 * Returns `null` for descriptive names where the second word is not a single
 * letter (e.g. "Hunter Clock - East", "Rainbird - West"). In that case the
 * caller assigns letters sequentially (A, B, C…) by the position of the
 * controller in the DB-sorted result set.
 */
function extractLetter(name: string): string | null {
  const trimmed = name.trim();
  // Single-character name (e.g. bare "A")
  if (trimmed.length === 1 && /^[A-Z]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  // "[word] [single-letter]" — the letter is the second whitespace token,
  // e.g. "Controller A", "Controller A - 136th Southeast", "Ctrl B".
  // The \b after the capture group ensures we don't match "C" from "Clock".
  const m = trimmed.match(/^[A-Za-z]+\s+([A-Z])\b/i);
  if (m) return m[1].toUpperCase();
  return null;
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
    return irrigCtrls.map((ctrl, index) => ({
      // extractLetter returns null for descriptive names (e.g. "Hunter Clock - East").
      // Fall back to A, B, C… by position so every controller gets a unique letter
      // regardless of its human-readable name.
      letter: extractLetter(ctrl.name) ?? String.fromCharCode(65 + index),
      zoneCount: ctrl.totalZones ?? null,
      notes: ctrl.notes ?? null,
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
  }));
}
