import { db } from "../db";
import {
  fieldWorkTypes,
  type FieldWorkType,
} from "@workspace/db";
import { and, count, eq } from "drizzle-orm";

export type FieldWorkTypeSeed = Pick<
  FieldWorkType,
  | "code"
  | "label"
  | "requiresController"
  | "requiresZone"
  | "requiresDetails"
  | "sortOrder"
  | "active"
>;

export const FIELD_WORK_TYPE_SEEDS: readonly FieldWorkTypeSeed[] = [
  {
    code: "zone_repair",
    label: "Zone Repair",
    requiresController: true,
    requiresZone: true,
    requiresDetails: false,
    sortOrder: 10,
    active: true,
  },
  {
    code: "head_replacement",
    label: "Head Replacement",
    requiresController: true,
    requiresZone: true,
    requiresDetails: false,
    sortOrder: 20,
    active: true,
  },
  {
    code: "valve_repair",
    label: "Valve Repair",
    requiresController: true,
    requiresZone: true,
    requiresDetails: false,
    sortOrder: 30,
    active: true,
  },
  {
    code: "controller_repair",
    label: "Controller/Clock Repair",
    requiresController: true,
    requiresZone: false,
    requiresDetails: false,
    sortOrder: 40,
    active: true,
  },
  {
    code: "backflow",
    label: "Backflow",
    requiresController: false,
    requiresZone: false,
    requiresDetails: false,
    sortOrder: 50,
    active: true,
  },
  {
    code: "mainline_repair",
    label: "Mainline Repair",
    requiresController: false,
    requiresZone: false,
    requiresDetails: false,
    sortOrder: 60,
    active: true,
  },
  {
    code: "other",
    label: "Other",
    requiresController: false,
    requiresZone: false,
    requiresDetails: true,
    sortOrder: 70,
    active: true,
  },
];

/**
 * The columns the seed OWNS and reconciles back to this file on every run.
 *
 * `active` is deliberately absent, and the type forbids adding it: retirement
 * is the tenant's decision, recorded in the database and nowhere else. If the
 * reconcile ever wrote `active`, a single re-run would silently un-retire every
 * work type anyone had ever turned off — and the picker would start offering
 * them again. `code` is absent for the opposite reason: it is the join key
 * every saved ticket and gate rule carries, so it identifies a row rather than
 * being reconciled on one.
 */
export type FieldWorkTypeReconciledColumn = Exclude<
  keyof FieldWorkTypeSeed,
  "code" | "active"
>;

export const FIELD_WORK_TYPE_RECONCILED_COLUMNS: readonly FieldWorkTypeReconciledColumn[] = [
  "label",
  "requiresController",
  "requiresZone",
  "requiresDetails",
  "sortOrder",
];

/** An existing row, read with exactly the columns the reconcile compares. */
export type FieldWorkTypeExistingRow = Pick<
  FieldWorkType,
  "code" | FieldWorkTypeReconciledColumn
>;

export type FieldWorkTypeFieldChange = {
  column: FieldWorkTypeReconciledColumn;
  from: string | number | boolean;
  to: string | number | boolean;
};

export type FieldWorkTypeDrift = {
  code: string;
  /** The label the row carries today — how an operator recognises it. */
  currentLabel: string;
  changes: FieldWorkTypeFieldChange[];
};

export type FieldWorkTypeSeedPlan = {
  /** Presets this company does not have at all; they will be inserted. */
  missing: FieldWorkTypeSeed[];
  /** Presets it has, but whose owned columns disagree with this file. */
  drifted: FieldWorkTypeDrift[];
};

/**
 * What a company's rows owe this file: rows to insert, rows to correct.
 *
 * Pure so the preview, the status and the reconcile all answer from one
 * comparison — the preview cannot promise a change the run does not make.
 */
export function diffFieldWorkTypeSeeds(
  existing: readonly FieldWorkTypeExistingRow[],
): FieldWorkTypeSeedPlan {
  const byCode = new Map(existing.map((row) => [row.code, row]));
  const missing: FieldWorkTypeSeed[] = [];
  const drifted: FieldWorkTypeDrift[] = [];

  for (const seed of FIELD_WORK_TYPE_SEEDS) {
    const row = byCode.get(seed.code);
    if (!row) {
      missing.push(seed);
      continue;
    }
    const changes: FieldWorkTypeFieldChange[] = [];
    for (const column of FIELD_WORK_TYPE_RECONCILED_COLUMNS) {
      if (row[column] !== seed[column]) {
        changes.push({ column, from: row[column], to: seed[column] });
      }
    }
    if (changes.length > 0) {
      drifted.push({ code: seed.code, currentLabel: row.label, changes });
    }
  }

  return { missing, drifted };
}

/** Human-readable single-row summary for previews and warnings. */
export function describeFieldWorkTypeDrift(drift: FieldWorkTypeDrift): string {
  const changes = drift.changes
    .map((change) => `${change.column} ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)
    .join(", ");
  return `${drift.code} (${drift.currentLabel}): ${changes}`;
}

/**
 * The values written to an existing row. Typed to the owned columns so
 * `active` cannot be slipped in here by a later edit.
 */
function reconciledValues(
  seed: FieldWorkTypeSeed,
): Pick<FieldWorkTypeSeed, FieldWorkTypeReconciledColumn> {
  return {
    label: seed.label,
    requiresController: seed.requiresController,
    requiresZone: seed.requiresZone,
    requiresDetails: seed.requiresDetails,
    sortOrder: seed.sortOrder,
  };
}

export type FieldWorkTypeSeedResult = {
  /** Presets the company did not have, now inserted. */
  inserted: number;
  /** Existing rows brought back into line with this file. */
  updated: number;
};

type FieldWorkTypeSeedExecutor = Pick<typeof db, "insert" | "select" | "update">;

/**
 * Bring one company's work types into line with `FIELD_WORK_TYPE_SEEDS`.
 *
 * These are presets owned by this file, not tenant content: a missing row is
 * inserted and an existing row is *corrected*, so a label or requirement-flag
 * edit here reaches companies that were seeded before it. Insertions and
 * updates are counted separately because they are different promises to an
 * operator — an update changes what the location gate demands of every ticket
 * saved afterwards.
 *
 * The one thing never written on an existing row is `active`; see
 * `FIELD_WORK_TYPE_RECONCILED_COLUMNS`.
 */
export async function seedFieldWorkTypesForCompany(
  companyId: number,
  executor: FieldWorkTypeSeedExecutor = db,
): Promise<FieldWorkTypeSeedResult> {
  const existing = await executor
    .select({
      code: fieldWorkTypes.code,
      label: fieldWorkTypes.label,
      requiresController: fieldWorkTypes.requiresController,
      requiresZone: fieldWorkTypes.requiresZone,
      requiresDetails: fieldWorkTypes.requiresDetails,
      sortOrder: fieldWorkTypes.sortOrder,
    })
    .from(fieldWorkTypes)
    .where(eq(fieldWorkTypes.companyId, companyId));

  const { missing, drifted } = diffFieldWorkTypeSeeds(existing);

  let inserted = 0;
  for (const seed of missing) {
    const [row] = await executor
      .insert(fieldWorkTypes)
      .values({ ...seed, companyId })
      .onConflictDoNothing({
        target: [fieldWorkTypes.companyId, fieldWorkTypes.code],
      })
      .returning({ id: fieldWorkTypes.id });
    if (row) inserted++;
  }

  let updated = 0;
  for (const drift of drifted) {
    const seed = FIELD_WORK_TYPE_SEEDS.find((entry) => entry.code === drift.code);
    if (!seed) continue;
    const [row] = await executor
      .update(fieldWorkTypes)
      .set(reconciledValues(seed))
      .where(and(
        eq(fieldWorkTypes.companyId, companyId),
        eq(fieldWorkTypes.code, seed.code),
      ))
      .returning({ id: fieldWorkTypes.id });
    if (row) updated++;
  }

  return { inserted, updated };
}

/**
 * How many active work types the tenant actually has.
 *
 * The gate's fail-open needs this as a plain number so the shared policy can
 * stay pure. Company scoping matches `getFieldWorkTypeRule`: a null companyId
 * means "unscoped", which counts across tenants and therefore keeps the gate
 * on rather than disabling it on an unresolved scope.
 */
export async function countActiveFieldWorkTypes(
  companyId: number | null,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(fieldWorkTypes)
    .where(and(
      eq(fieldWorkTypes.active, true),
      ...(companyId == null ? [] : [eq(fieldWorkTypes.companyId, companyId)]),
    ));
  return Number(row?.value ?? 0);
}

/**
 * What a stored work type code demands — controller, zone, details.
 *
 * Deliberately reads the **full** registry, retired rows included. Selection is
 * a different question from resolution: a retired type can never be chosen for
 * new work, so resolving its rule cannot loosen or tighten anything going
 * forward. It only lets a record that already carries the code be evaluated
 * against exactly the requirements it was saved under. Filtering to active rows
 * here made the save-time gate read "no rule" for such a record and reject it
 * as "work type missing", while the Missing Location Data report — which reads
 * the full registry — insisted the same ticket was complete. All three
 * resolvers (report, server gate, client gate) now answer identically.
 *
 * The active-only *count* in `countActiveFieldWorkTypes` is unrelated and stays
 * active-only: "can anyone in this company still pick a work type?" is what the
 * empty-registry fail-open asks, and retired rows must not answer yes to it.
 */
export async function getFieldWorkTypeRule(
  companyId: number | null,
  code: string | null | undefined,
): Promise<Pick<FieldWorkType, "code" | "requiresController" | "requiresZone" | "requiresDetails"> | null> {
  if (typeof code !== "string" || code.trim() === "") return null;
  const [row] = await db
    .select({
      code: fieldWorkTypes.code,
      requiresController: fieldWorkTypes.requiresController,
      requiresZone: fieldWorkTypes.requiresZone,
      requiresDetails: fieldWorkTypes.requiresDetails,
    })
    .from(fieldWorkTypes)
    .where(and(
      eq(fieldWorkTypes.code, code.trim()),
      ...(companyId == null ? [] : [eq(fieldWorkTypes.companyId, companyId)]),
    ))
    .limit(1);
  return row ?? null;
}