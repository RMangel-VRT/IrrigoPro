import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db";
import { companies, fieldWorkTypes, issueTypeConfigs } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import {
  FIELD_WORK_TYPE_SEEDS,
  seedFieldWorkTypesForCompany,
} from "./seeds/field-work-types";

let companyId: number;
let createdCompanyId: number | undefined;

describe("field work type seeding", () => {
  before(async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: `Field work type seed test ${process.pid}-${Date.now()}` })
      .returning({ id: companies.id });
    companyId = company.id;
  });

  after(async () => {
    if (!companyId) return;
    await db.delete(fieldWorkTypes).where(eq(fieldWorkTypes.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    if (createdCompanyId) {
      // createCompany preserves the existing fire-and-forget issue-type seed.
      // It can finish a few milliseconds after the field-work-type invariant,
      // so cleanup retries until that unrelated seeder has settled.
      for (let attempt = 0; attempt < 20; attempt++) {
        await db.delete(issueTypeConfigs).where(eq(issueTypeConfigs.companyId, createdCompanyId));
        await db.delete(fieldWorkTypes).where(eq(fieldWorkTypes.companyId, createdCompanyId));
        try {
          await db.delete(companies).where(eq(companies.id, createdCompanyId));
          break;
        } catch (error: any) {
          if (error?.cause?.code !== "23503" || attempt === 19) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  // Presets are owned by `seeds/field-work-types.ts`. A re-run inserts what is
  // missing AND corrects what has drifted from that file — the only thing it
  // never writes is `active`, because retirement is the tenant's decision.
  it("inserts all seven defaults once, then reconciles drift without un-retiring", async () => {
    assert.deepEqual(await seedFieldWorkTypesForCompany(companyId), { inserted: 7, updated: 0 });
    assert.deepEqual(await seedFieldWorkTypesForCompany(companyId), { inserted: 0, updated: 0 });

    // The label is presentation; the code is the stored key every ticket and
    // gate rule joins on, so a rename must never move it.
    const controllerRepair = FIELD_WORK_TYPE_SEEDS.find(
      (row) => row.code === "controller_repair",
    )!;
    assert.equal(controllerRepair.label, "Controller/Clock Repair");
    const [seededControllerRepair] = await db
      .select()
      .from(fieldWorkTypes)
      .where(and(
        eq(fieldWorkTypes.companyId, companyId),
        eq(fieldWorkTypes.code, "controller_repair"),
      ));
    assert.equal(seededControllerRepair.label, "Controller/Clock Repair");

    const backflow = FIELD_WORK_TYPE_SEEDS.find((row) => row.code === "backflow")!;
    const mainline = FIELD_WORK_TYPE_SEEDS.find((row) => row.code === "mainline_repair")!;
    assert.equal(backflow.requiresController, mainline.requiresController);
    assert.equal(backflow.requiresZone, mainline.requiresZone);

    await db
      .update(fieldWorkTypes)
      .set({ label: "Tenant Backflow", sortOrder: 3, active: false })
      .where(and(
        eq(fieldWorkTypes.companyId, companyId),
        eq(fieldWorkTypes.code, "backflow"),
      ));

    assert.deepEqual(
      await seedFieldWorkTypesForCompany(companyId),
      { inserted: 0, updated: 1 },
      "a drifted row is corrected, and reported as an update rather than an insert",
    );
    const [reconciled] = await db
      .select()
      .from(fieldWorkTypes)
      .where(and(
        eq(fieldWorkTypes.companyId, companyId),
        eq(fieldWorkTypes.code, "backflow"),
      ));
    assert.equal(reconciled.label, backflow.label);
    assert.equal(reconciled.sortOrder, backflow.sortOrder);
    assert.equal(
      reconciled.active,
      false,
      "retirement survives the reconcile — the seed never writes `active`",
    );
  });

  it("makes all seven defaults visible before createCompany resolves", async () => {
    const { storage } = await import("./storage");
    const company = await storage.createCompany({
      name: `Field work type create test ${process.pid}-${Date.now()}`,
    });
    createdCompanyId = company.id;
    const rows = await storage.getFieldWorkTypes(company.id, false);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((row) => row.code), FIELD_WORK_TYPE_SEEDS.map((row) => row.code));
  });
});