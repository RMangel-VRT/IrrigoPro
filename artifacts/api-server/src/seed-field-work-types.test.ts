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

  it("inserts all seven defaults once and never resets tenant customizations", async () => {
    assert.equal(await seedFieldWorkTypesForCompany(companyId), 7);
    assert.equal(await seedFieldWorkTypesForCompany(companyId), 0);

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

    assert.equal(await seedFieldWorkTypesForCompany(companyId), 0);
    const [customized] = await db
      .select()
      .from(fieldWorkTypes)
      .where(and(
        eq(fieldWorkTypes.companyId, companyId),
        eq(fieldWorkTypes.code, "backflow"),
      ));
    assert.equal(customized.label, "Tenant Backflow");
    assert.equal(customized.sortOrder, 3);
    assert.equal(customized.active, false);
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