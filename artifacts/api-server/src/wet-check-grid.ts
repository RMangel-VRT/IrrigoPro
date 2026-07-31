/**
 * Wet-check controller grid building.
 *
 * Task #1857 — `irrigation_controllers` is now the single source of truth.
 * The legacy path (property_controllers + customers.totalControllers) is
 * removed. This module simply converts the already-scoped irrigCtrls list
 * into a GridResult used by `ensureIrrigationControllers`.
 */

export interface IrrigationControllerRow {
  name: string;
  totalZones: number | null;
  /** Stored letter (Task #1856). */
  letter?: string | null;
}

export interface GridSeedConfig {
  name: string;
  zoneCount: number | null;
  /** Letter stored on the controller row. */
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
 * @param irrigCtrls  Rows from `listIrrigationControllers` for this
 *                    (companyId, customerId, branchKey) triple.
 *                    Pass the already-scoped list — branchKey="" for
 *                    customer-level, a string for branch-level.
 */
export function buildWetCheckGrid(
  irrigCtrls: IrrigationControllerRow[],
): GridResult {
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
