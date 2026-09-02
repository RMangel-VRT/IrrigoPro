/**
 * Three places resolve what a work type demands, and for a *retired* code they
 * used to disagree.
 *
 *   * The Missing Location Data report reads the full registry, so a ticket
 *     saved complete under a since-retired type stays off the report.
 *   * The save-time gate read active rows only, so the same ticket resolved no
 *     rule at all — which `checkLocationGate` reports as "work_type_missing" —
 *     and the save was refused.
 *
 * The result was a correctly-captured ticket nobody could edit: the wizard
 * blocked, the retired type could not be re-selected, and the report insisted
 * nothing was wrong with it. A report whose job is to predict the gate's
 * verdict must not contradict it, so these tests assert the two **against each
 * other** rather than each against a hand-written expectation.
 *
 * Rule resolution reads the full registry; selection stays active-only, which
 * the empty-registry case at the bottom pins down.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { companies, fieldWorkTypes } from "@workspace/db/schema";
import { storage } from "../storage";
import {
  registerMissingLocationDataRoute,
  type MissingLocationReportResponse,
} from "./missing-location-data-route";
import {
  getBillingLocationViolations,
  resolveBillingLocationPatchGate,
} from "./billing-sheet-location-gate";
import {
  countActiveFieldWorkTypes,
  getFieldWorkTypeRule,
} from "../seeds/field-work-types";

const RETIRED_CODE = "zone_repair";

let companyId: number;
let emptyCompanyId: number;

type SheetFixture = {
  id: number;
  billingNumber: string;
  workLocationLat: string | null;
  workLocationLng: string | null;
  fieldWorkType: string | null;
  fieldWorkTypeDetails: string | null;
  controllerLetter: string | null;
  zoneNumber: number | null;
};

function sheet(fixture: SheetFixture) {
  return {
    ...fixture,
    // Resolved when the report and the gate read it, not at module load: the
    // tenant is created in `before`.
    get companyId() {
      return companyId;
    },
    customerId: 1,
    customerName: "Retired Type Customer",
    branchName: null,
    technicianId: 1,
    technicianName: "Tech",
    workDate: new Date("2026-09-02T00:00:00.000Z"),
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
    status: "submitted",
    workLocationSource: "gps",
    workLocationGpsError: null,
  } as any;
}

// A ticket captured correctly under the type before it was retired.
const COMPLETE = sheet({
  id: 9001,
  billingNumber: "BS-RETIRED-COMPLETE",
  workLocationLat: "39.7392",
  workLocationLng: "-104.9903",
  fieldWorkType: RETIRED_CODE,
  fieldWorkTypeDetails: null,
  controllerLetter: "A",
  zoneNumber: 3,
});

// The same retired type, missing what that type has always required.
const INCOMPLETE = sheet({
  id: 9002,
  billingNumber: "BS-RETIRED-INCOMPLETE",
  workLocationLat: "39.7392",
  workLocationLng: "-104.9903",
  fieldWorkType: RETIRED_CODE,
  fieldWorkTypeDetails: null,
  controllerLetter: null,
  zoneNumber: null,
});

// Referencing no work type at all must be unaffected by any of this.
const NO_WORK_TYPE = sheet({
  id: 9003,
  billingNumber: "BS-NO-WORK-TYPE",
  workLocationLat: "39.7392",
  workLocationLng: "-104.9903",
  fieldWorkType: null,
  fieldWorkTypeDetails: null,
  controllerLetter: null,
  zoneNumber: null,
});

const SHEETS = [COMPLETE, INCOMPLETE, NO_WORK_TYPE];

function makeReportApp() {
  const app = express();
  const requireAuthentication = (req: any, _res: any, next: any) => {
    req.authenticatedUserRole = "company_admin";
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerMissingLocationDataRoute(
    app,
    {
      getWorkOrders: async () => [],
      getAllBillingSheets: async () => SHEETS,
      // Deliberately the real reader: the registry both sides resolve through
      // is the same table, so a stub here would prove nothing.
      getFieldWorkTypes: (scope: number | null, activeOnly: boolean) =>
        storage.getFieldWorkTypes(scope, activeOnly),
      getCompanies: async () => [{ id: companyId, name: "Retired Type Co" }],
    } as any,
    requireAuthentication,
  );
  return app;
}

/** Exactly what the billing-sheet save path does before accepting a write. */
async function saveGateVerdict(ticket: any) {
  const activeCount = await countActiveFieldWorkTypes(ticket.companyId);
  const gate = resolveBillingLocationPatchGate(
    ticket.createdAt,
    { status: "submitted" },
    activeCount,
  );
  if (!gate.enforced) return null;
  const rule = await getFieldWorkTypeRule(ticket.companyId, ticket.fieldWorkType);
  return getBillingLocationViolations(
    {
      workLocationLat: ticket.workLocationLat,
      workLocationLng: ticket.workLocationLng,
      fieldWorkType: ticket.fieldWorkType,
      fieldWorkTypeDetails: ticket.fieldWorkTypeDetails,
      controllerLetter: ticket.controllerLetter,
      zoneNumber: ticket.zoneNumber,
    },
    rule,
  );
}

async function reportViolationsById(): Promise<Map<number, string[]>> {
  const response = await request(makeReportApp()).get(
    "/api/reports/missing-location-data",
  );
  assert.equal(response.status, 200);
  const body = response.body as MissingLocationReportResponse;
  return new Map(body.rows.map((row) => [row.ticketId, row.violations as string[]]));
}

describe("retired work type: report and save gate agree", () => {
  before(async () => {
    const stamp = `${process.pid}-${Date.now()}`;
    const [company] = await db
      .insert(companies)
      .values({ name: `Retired work type agreement ${stamp}` })
      .returning({ id: companies.id });
    companyId = company.id;
    const [empty] = await db
      .insert(companies)
      .values({ name: `Retired-only registry ${stamp}` })
      .returning({ id: companies.id });
    emptyCompanyId = empty.id;

    await db.insert(fieldWorkTypes).values([
      {
        companyId,
        code: RETIRED_CODE,
        label: "Zone Repair",
        requiresController: true,
        requiresZone: true,
        requiresDetails: false,
        sortOrder: 10,
        active: false,
      },
      {
        companyId,
        code: "backflow",
        label: "Backflow",
        requiresController: false,
        requiresZone: false,
        requiresDetails: false,
        sortOrder: 50,
        active: true,
      },
      {
        companyId: emptyCompanyId,
        code: RETIRED_CODE,
        label: "Zone Repair",
        requiresController: true,
        requiresZone: true,
        requiresDetails: false,
        sortOrder: 10,
        active: false,
      },
    ]);
  });

  after(async () => {
    for (const id of [companyId, emptyCompanyId]) {
      if (!id) continue;
      await db.delete(fieldWorkTypes).where(eq(fieldWorkTypes.companyId, id));
      await db.delete(companies).where(eq(companies.id, id));
    }
  });

  it("resolves a retired type's original requirements at save time", async () => {
    const rule = await getFieldWorkTypeRule(companyId, RETIRED_CODE);
    assert.deepEqual(rule, {
      code: RETIRED_CODE,
      requiresController: true,
      requiresZone: true,
      requiresDetails: false,
    });
  });

  it("resolves the same rule the report resolves", async () => {
    const registry = await storage.getFieldWorkTypes(companyId, false);
    const reportRow = registry.find((row) => row.code === RETIRED_CODE);
    assert.ok(reportRow, "the report reads the full registry, retired rows included");
    const gateRule = await getFieldWorkTypeRule(companyId, RETIRED_CODE);
    assert.deepEqual(gateRule, {
      code: reportRow!.code,
      requiresController: reportRow!.requiresController,
      requiresZone: reportRow!.requiresZone,
      requiresDetails: reportRow!.requiresDetails,
    });
  });

  it("agrees, ticket by ticket, on a code that is no longer offered", async () => {
    const reported = await reportViolationsById();

    // Complete under the retired type: the report leaves it alone, and the
    // save gate must let the same record be re-saved after an unrelated edit.
    assert.equal(reported.has(COMPLETE.id), false);
    assert.deepEqual(await saveGateVerdict(COMPLETE), []);

    // Incomplete under the retired type: both name the very same failures.
    const gateViolations = await saveGateVerdict(INCOMPLETE);
    assert.deepEqual(gateViolations, reported.get(INCOMPLETE.id));
    assert.deepEqual(gateViolations, ["controller_missing", "zone_missing"]);
    // Specifically NOT "work_type_missing" — the old active-only lookup
    // resolved no rule and blamed the work type for a ticket that had one.
    assert.equal(gateViolations!.includes("work_type_missing"), false);
  });

  it("agrees on a ticket that references no work type at all", async () => {
    const reported = await reportViolationsById();
    assert.deepEqual(await saveGateVerdict(NO_WORK_TYPE), reported.get(NO_WORK_TYPE.id));
    assert.deepEqual(reported.get(NO_WORK_TYPE.id), ["work_type_missing"]);
  });

  it("still counts a registry of nothing but retired rows as empty", async () => {
    // Resolution reads the full registry; selection does not. A company left
    // holding only retired rows has no work type anyone can pick, so the gate
    // must take the fail-open path rather than demand the impossible.
    assert.equal(await countActiveFieldWorkTypes(emptyCompanyId), 0);
    const full = await storage.getFieldWorkTypes(emptyCompanyId, false);
    assert.deepEqual(full.map((row) => row.code), [RETIRED_CODE]);
    const selectable = await storage.getFieldWorkTypes(emptyCompanyId, true);
    assert.deepEqual(selectable, []);

    const gate = resolveBillingLocationPatchGate(
      new Date("2026-09-02T12:00:00.000Z"),
      { status: "submitted" },
      await countActiveFieldWorkTypes(emptyCompanyId),
    );
    assert.deepEqual(gate, { enforced: false, skippedEmptyRegistry: true });
  });
});
