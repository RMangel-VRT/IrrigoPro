import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";

const tag = `wcb-qty-${Date.now()}`;
let companyId: number;
let otherCompanyId: number;
let customerId: number;
let userId: number;
let partId: number;
const wetCheckIds: number[] = [];
const invoiceIds: number[] = [];

async function insertedId(query: Promise<{ rows: unknown[] }>): Promise<number> {
  const result = await query;
  return Number((result.rows[0] as { id: number }).id);
}

async function createScenario(
  mode: "service" | "inspection",
  options: { status?: string; invoiceId?: number | null; laborOnly?: boolean } = {},
) {
  const wetCheckId = await insertedId(db.execute(sql`
    INSERT INTO wet_checks (
      company_id, customer_id, technician_id, technician_name, customer_name,
      num_controllers, status, labor_mode, total_labor_hours, mode
    ) VALUES (
      ${companyId}, ${customerId}, ${userId}, 'Quantity Tech', 'Quantity Customer',
      1, 'converted', 'flat', '1.00', ${mode}
    ) RETURNING id
  `));
  wetCheckIds.push(wetCheckId);

  const zoneRecordId = await insertedId(db.execute(sql`
    INSERT INTO wet_check_zone_records (
      wet_check_id, controller_letter, zone_number,
      repair_labor_hours, repair_labor_manually_set
    ) VALUES (${wetCheckId}, 'F', 2, '49.30', true)
    RETURNING id
  `));

  const wcbId = await insertedId(db.execute(sql`
    INSERT INTO wet_check_billings (
      billing_number, customer_id, customer_name, property_address, work_date,
      technician_name, technician_id, wet_check_id, status, total_hours,
      labor_rate, applied_labor_rate, labor_subtotal, parts_subtotal, total_amount,
      invoice_id
    ) VALUES (
      ${`WC-${tag}-${wetCheckId}`}, ${customerId}, 'Quantity Customer', '100 Test Way', NOW(),
      'Quantity Tech', ${userId}, ${wetCheckId}, ${options.status ?? "approved_passed_to_billing"}, '50.30',
      '60.00', '80.00', '4024.00', '1925.00', '5949.00',
      ${options.invoiceId ?? null}
    ) RETURNING id
  `));

  const findingId = await insertedId(db.execute(sql`
    INSERT INTO wet_check_findings (
      zone_record_id, wet_check_id, wet_check_billing_id, issue_type, issue_group,
      part_id, part_name, part_price, quantity, no_part_needed, labor_hours,
      resolution, tech_disposition
    ) VALUES (
      ${zoneRecordId}, ${wetCheckId}, ${wcbId}, 'nozzle_replace', 'quick_fix',
      ${options.laborOnly ? null : partId}, ${options.laborOnly ? null : "Nozzle"},
      ${options.laborOnly ? null : "10.00"}, ${options.laborOnly ? 0 : 192},
      ${options.laborOnly ?? false}, '0.25', 'repaired_in_field', 'completed_in_field'
    ) RETURNING id
  `));

  if (!options.laborOnly) {
    await db.execute(sql`
      INSERT INTO wet_check_findings (
        zone_record_id, wet_check_id, wet_check_billing_id, issue_type, issue_group,
        part_id, part_name, part_price, quantity, no_part_needed, labor_hours,
        resolution, tech_disposition
      ) VALUES (
        ${zoneRecordId}, ${wetCheckId}, ${wcbId}, 'valve_adjustment', 'quick_fix',
        ${partId}, 'Adjustment Kit', '5.00', 1, false, '0.80',
        'repaired_in_field', 'completed_in_field'
      )
    `);
  }

  return { wetCheckId, zoneRecordId, wcbId, findingId };
}

describe("setWcbFindingQuantity", () => {
  before(async () => {
    companyId = await insertedId(db.execute(sql`
      INSERT INTO companies (name, subscription, is_active)
      VALUES (${`Quantity Co ${tag}`}, 'basic', true) RETURNING id
    `));
    otherCompanyId = await insertedId(db.execute(sql`
      INSERT INTO companies (name, subscription, is_active)
      VALUES (${`Other Quantity Co ${tag}`}, 'basic', true) RETURNING id
    `));
    customerId = await insertedId(db.execute(sql`
      INSERT INTO customers (company_id, name, email)
      VALUES (${companyId}, 'Quantity Customer', ${`${tag}@example.test`}) RETURNING id
    `));
    userId = await insertedId(db.execute(sql`
      INSERT INTO users (username, password, name, role, company_id, is_active)
      VALUES (${tag}, 'hashed', 'Quantity Tech', 'field_tech', ${companyId}, true)
      RETURNING id
    `));
    partId = await insertedId(db.execute(sql`
      INSERT INTO parts (company_id, name, price, sku, category)
      VALUES (${companyId}, 'Nozzle', '10.00', ${tag}, 'Sprinkler')
      RETURNING id
    `));
    await db.execute(sql`
      INSERT INTO issue_type_configs (
        company_id, issue_type, issue_group, display_label, default_labor_hours
      ) VALUES
        (${companyId}, 'nozzle_replace', 'quick_fix', 'Nozzle Replace', '0.25'),
        (${companyId}, 'valve_adjustment', 'quick_fix', 'Valve Adjustment', '0.80')
    `);
  });

  after(async () => {
    if (wetCheckIds.length) {
      await db.execute(sql`DELETE FROM wet_check_findings WHERE wet_check_id IN ${sql.raw(`(${wetCheckIds.join(",")})`)}`);
      await db.execute(sql`DELETE FROM wet_check_billings WHERE wet_check_id IN ${sql.raw(`(${wetCheckIds.join(",")})`)}`);
      await db.execute(sql`DELETE FROM wet_check_zone_records WHERE wet_check_id IN ${sql.raw(`(${wetCheckIds.join(",")})`)}`);
      await db.execute(sql`DELETE FROM wet_checks WHERE id IN ${sql.raw(`(${wetCheckIds.join(",")})`)}`);
    }
    for (const invoiceId of invoiceIds) {
      await db.execute(sql`DELETE FROM invoices WHERE id = ${invoiceId}`);
    }
    await db.execute(sql`DELETE FROM issue_type_configs WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM parts WHERE id = ${partId}`);
    await db.execute(sql`DELETE FROM customers WHERE id = ${customerId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await db.execute(sql`DELETE FROM companies WHERE id IN (${companyId}, ${otherCompanyId})`);
  });

  for (const mode of ["service", "inspection"] as const) {
    it(`atomically realigns parts, catalog labor, and totals in ${mode} mode`, async () => {
      const scenario = await createScenario(mode);
      const result = await storage.setWcbFindingQuantity(
        scenario.wcbId,
        scenario.findingId,
        2,
        companyId,
      );

      assert.ok(result);
      assert.equal(result.before.finding.quantity, 192);
      assert.equal(result.before.zoneRecord.repairLaborManuallySet, true);
      assert.equal(result.updated.finding.quantity, 2);
      assert.equal(result.updated.finding.resolution, "repaired_in_field");
      assert.equal(result.updated.finding.techDisposition, "completed_in_field");
      assert.equal(result.updated.zoneRecord.repairLaborManuallySet, false);
      assert.equal(result.updated.zoneRecord.repairLaborHours, "1.30");
      assert.equal(result.updated.wcb.partsSubtotal, "25.00");
      assert.equal(result.updated.wcb.totalHours, "2.30");
      assert.equal(result.updated.wcb.laborSubtotal, "184.00");
      assert.equal(result.updated.wcb.totalAmount, "209.00");
    });
  }

  it("returns no result for cross-company and out-of-snapshot attempts", async () => {
    const first = await createScenario("service");
    const second = await createScenario("service");
    assert.equal(
      await storage.setWcbFindingQuantity(first.wcbId, first.findingId, 2, otherCompanyId),
      undefined,
    );
    assert.equal(
      await storage.setWcbFindingQuantity(second.wcbId, first.findingId, 2, companyId),
      undefined,
    );
    const row = await db.execute(sql`
      SELECT quantity FROM wet_check_findings WHERE id = ${first.findingId}
    `);
    assert.equal(Number((row.rows[0] as { quantity: number }).quantity), 192);
  });

  it("serializes concurrent edits so the final WCB totals include both changes", async () => {
    const scenario = await createScenario("service");
    const secondZoneId = await insertedId(db.execute(sql`
      INSERT INTO wet_check_zone_records (
        wet_check_id, controller_letter, zone_number,
        repair_labor_hours, repair_labor_manually_set
      ) VALUES (${scenario.wetCheckId}, 'F', 3, '0.25', false)
      RETURNING id
    `));
    const secondFindingId = await insertedId(db.execute(sql`
      INSERT INTO wet_check_findings (
        zone_record_id, wet_check_id, wet_check_billing_id, issue_type, issue_group,
        part_id, part_name, part_price, quantity, no_part_needed, labor_hours,
        resolution, tech_disposition
      ) VALUES (
        ${secondZoneId}, ${scenario.wetCheckId}, ${scenario.wcbId}, 'nozzle_replace', 'quick_fix',
        ${partId}, 'Nozzle', '10.00', 1, false, '0.25',
        'repaired_in_field', 'completed_in_field'
      ) RETURNING id
    `));

    await Promise.all([
      storage.setWcbFindingQuantity(scenario.wcbId, scenario.findingId, 2, companyId),
      storage.setWcbFindingQuantity(scenario.wcbId, secondFindingId, 2, companyId),
    ]);
    const final = await db.execute(sql`
      SELECT parts_subtotal, total_hours, labor_subtotal, total_amount
      FROM wet_check_billings WHERE id = ${scenario.wcbId}
    `);
    assert.deepEqual(final.rows[0], {
      parts_subtotal: "45.00",
      total_hours: "2.80",
      labor_subtotal: "224.00",
      total_amount: "269.00",
    });
  });

  it("rejects labor-only findings and invalid ranges without changing the row", async () => {
    const laborOnly = await createScenario("service", { laborOnly: true });
    await assert.rejects(
      storage.setWcbFindingQuantity(laborOnly.wcbId, laborOnly.findingId, 2, companyId),
      /labor-only/,
    );
    for (const quantity of [0, 1000, 1.5]) {
      await assert.rejects(
        storage.setWcbFindingQuantity(laborOnly.wcbId, laborOnly.findingId, quantity, companyId),
        /whole number from 1 through 999/,
      );
    }
  });

  it("rejects billed and invoiced snapshots with zone-labor lock semantics", async () => {
    const billed = await createScenario("service", { status: "billed" });
    await assert.rejects(
      storage.setWcbFindingQuantity(billed.wcbId, billed.findingId, 2, companyId),
      /is billed and cannot be edited/,
    );

    const invoiceId = await insertedId(db.execute(sql`
      INSERT INTO invoices (
        invoice_number, company_id, customer_id, customer_name, customer_email,
        invoice_month, invoice_year, period_start, period_end,
        status, parts_subtotal, labor_subtotal, total_amount
      ) VALUES (
        ${`INV-${tag}`}, ${companyId}, ${customerId}, 'Quantity Customer', 'quantity@example.test',
        9, 2026, NOW(), NOW(), 'sent', '0.00', '0.00', '0.00'
      ) RETURNING id
    `));
    invoiceIds.push(invoiceId);
    const invoiced = await createScenario("service", { invoiceId });
    await assert.rejects(
      storage.setWcbFindingQuantity(invoiced.wcbId, invoiced.findingId, 2, companyId),
      /already invoiced and cannot be edited/,
    );
  });
});
