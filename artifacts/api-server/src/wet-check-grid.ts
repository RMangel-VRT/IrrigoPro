/**
 * Wet-check controller grid building.
 *
 * This module owns the decision logic for how many controllers and zones go into
 * a wet-check or controller-read grid:
 *
 *   1. If irrigation_controllers rows exist for the (company, customer, branch)
 *      triple → use them as the authoritative source (profile path).
 *   2. Otherwise → fall back to `customers.totalControllers` (clamped 1–26) plus
 *      the `property_controllers` zone-count map (legacy path, unchanged behaviour).
 *
 * The logic is extracted here so it can be covered by isolated tests without
 * standing up a full Express + database integration harness.
 */

export interface IrrigationControllerRow {
  name: string;
  totalZones: number | null;
  /** Stored letter (Task #1856). Present for profile-path rows after backfill. */
  letter?: string | null;
}

export interface PropertyControllerRow {
  branchName: string | null;
  controllerLetter: string;
  zoneCount: number | null;
}

export interface GridSeedConfig {
  name: string;
  zoneCount: number | null;
  /** Letter to store on the controller row. Sourced from property_controllers
   *  in the legacy path so we honour existing stored letters rather than
   *  re-deriving them positionally. */
  letter?: string;
}

export interface GridResult {
  numControllers: number;
  seedConfigs: GridSeedConfig[];
}

// Alphabet constant — avoids String.fromCharCode(65+i) throughout this module.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Build the seed-config array used to call `ensureIrrigationControllers`.
 *
 * @param irrigCtrls   Rows from `listIrrigationControllers` for this
 *                     (companyId, customerId, branchKey) triple.
 *                     Pass the **already-scoped** list — branchKey="" for
 *                     customer-level, a string for branch-level.
 * @param totalControllers  `customers.totalControllers` integer (legacy fallback count).
 * @param legacyPCs    All `property_controllers` rows for this customer (any branch).
 * @param branchKey    The bucket key used for `irrigation_controllers` queries.
 *                     "" for customer-level, a named string for branch-level.
 *                     Used only for legacy-path branch filtering of `legacyPCs`.
 */
export function buildWetCheckGrid(
  irrigCtrls: IrrigationControllerRow[],
  totalControllers: number | null | undefined,
  legacyPCs: PropertyControllerRow[],
  branchKey: string,
): GridResult {
  if (irrigCtrls.length > 0) {
    // Profile path: count and zone configs come entirely from irrigation_controllers.
    // Zone counts are passed through as-is — null is NOT defaulted to 12.
    // Letters come from the stored letter column (Task #1856); fall back to
    // positional assignment only for pre-backfill rows where letter IS NULL.
    return {
      numControllers: irrigCtrls.length,
      seedConfigs: irrigCtrls.map((ctrl, index) => ({
        name: ctrl.name,
        zoneCount: ctrl.totalZones ?? null,
        letter: ctrl.letter ?? ALPHABET[index],
      })),
    };
  }

  // Legacy path: keep the exact behaviour that existed before this module was
  // introduced. Count = clamp(customers.totalControllers, 1, 26).
  // Zone counts come from property_controllers rows that match the branch bucket.
  // Letters are read directly from property_controllers.controllerLetter so we
  // never re-derive them positionally.
  const numControllers = Math.max(1, Math.min(26, Number(totalControllers ?? 1)));
  const pcsForBranch = legacyPCs
    .filter(r => (r.branchName ?? "") === branchKey)
    .sort((a, b) => a.controllerLetter.localeCompare(b.controllerLetter));

  const seedConfigs: GridSeedConfig[] = [];
  for (let i = 0; i < numControllers; i++) {
    const letter = ALPHABET[i];
    const pc = pcsForBranch.find(r => r.controllerLetter === letter);
    seedConfigs.push({
      name: `Controller ${letter}`,
      zoneCount: pc?.zoneCount ?? null,
      letter,
    });
  }
  return { numControllers, seedConfigs };
}
