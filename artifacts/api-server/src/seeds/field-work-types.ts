import { db } from "../db";
import {
  fieldWorkTypes,
  type FieldWorkType,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

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
    label: "Controller Repair",
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

type FieldWorkTypeSeedExecutor = Pick<typeof db, "insert">;

export async function seedFieldWorkTypesForCompany(
  companyId: number,
  executor: FieldWorkTypeSeedExecutor = db,
): Promise<number> {
  let inserted = 0;
  for (const seed of FIELD_WORK_TYPE_SEEDS) {
    const [row] = await executor
      .insert(fieldWorkTypes)
      .values({ ...seed, companyId })
      .onConflictDoNothing({
        target: [fieldWorkTypes.companyId, fieldWorkTypes.code],
      })
      .returning({ id: fieldWorkTypes.id });
    if (row) inserted++;
  }
  return inserted;
}

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
      eq(fieldWorkTypes.active, true),
      ...(companyId == null ? [] : [eq(fieldWorkTypes.companyId, companyId)]),
    ))
    .limit(1);
  return row ?? null;
}