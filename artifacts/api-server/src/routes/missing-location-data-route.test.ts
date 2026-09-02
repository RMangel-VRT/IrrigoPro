import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  registerMissingLocationDataRoute,
  type MissingLocationDataStorage,
} from "./missing-location-data-route";

const rules = [
  {
    id: 1,
    companyId: 1,
    code: "zone_repair",
    label: "Zone repair",
    requiresController: true,
    requiresZone: true,
    requiresDetails: false,
    sortOrder: 10,
    active: true,
    createdAt: new Date(),
  },
  {
    id: 2,
    companyId: 1,
    code: "mainline_repair",
    label: "Mainline repair",
    requiresController: false,
    requiresZone: false,
    requiresDetails: false,
    sortOrder: 20,
    active: true,
    createdAt: new Date(),
  },
  {
    id: 3,
    companyId: 1,
    code: "other",
    label: "Other",
    requiresController: false,
    requiresZone: false,
    requiresDetails: true,
    sortOrder: 30,
    active: false,
    createdAt: new Date(),
  },
];

function workOrder(overrides: Record<string, unknown>) {
  return {
    id: 1,
    companyId: 1,
    workOrderNumber: "WO-1",
    customerId: 10,
    customerName: "Acme",
    branchName: "North",
    assignedTechnicianId: 101,
    assignedTechnicianName: "Alex Tech",
    scheduledDate: new Date("2024-01-10T12:00:00Z"),
    createdAt: new Date("2020-01-01T00:00:00Z"),
    status: "cancelled",
    workLocationLat: null,
    workLocationLng: null,
    fieldWorkType: null,
    fieldWorkTypeDetails: null,
    controllerLetter: null,
    zoneNumber: null,
    workLocationSource: null,
    workLocationGpsError: null,
    ...overrides,
  };
}

function billingSheet(overrides: Record<string, unknown>) {
  return {
    id: 11,
    companyId: 1,
    billingNumber: "BS-11",
    customerId: 10,
    customerName: "Acme",
    branchName: "North",
    technicianId: 101,
    technicianName: "Alex Tech",
    workDate: new Date("2024-01-11T12:00:00Z"),
    createdAt: new Date("2024-01-11T12:00:00Z"),
    status: "billed",
    workLocationLat: "39.7",
    workLocationLng: "-104.9",
    fieldWorkType: "other",
    fieldWorkTypeDetails: null,
    controllerLetter: null,
    zoneNumber: null,
    workLocationSource: "gps",
    workLocationGpsError: null,
    ...overrides,
  };
}

function makeStorage() {
  const workOrdersByCompany: Record<number, any[]> = {
    1: [
      workOrder({ id: 1, workOrderNumber: "WO-LEGACY" }),
      workOrder({
        id: 2,
        workOrderNumber: "WO-CURRENT-BILLED",
        scheduledDate: new Date("2026-09-02T12:00:00Z"),
        createdAt: new Date("2026-09-02T11:00:00Z"),
        status: "billed",
        workLocationLat: "39.7",
        workLocationLng: "-104.9",
        fieldWorkType: "zone_repair",
        workLocationSource: "gps",
      }),
      workOrder({
        id: 3,
        workOrderNumber: "WO-VALID",
        status: "completed",
        workLocationLat: "39.7",
        workLocationLng: "-104.9",
        fieldWorkType: "zone_repair",
        controllerLetter: "A",
        zoneNumber: 4,
        workLocationSource: "gps",
      }),
      workOrder({
        id: 4,
        workOrderNumber: "WO-LOW",
        scheduledDate: new Date("2024-02-01T12:00:00Z"),
        workLocationLat: "39.7",
        workLocationLng: "-104.9",
        fieldWorkType: "mainline_repair",
        workLocationSource: "manual",
        workLocationGpsError: "permission_denied",
      }),
    ],
    2: [
      workOrder({
        id: 20,
        companyId: 2,
        workOrderNumber: "WO-COMPANY-2",
        customerName: "Other Tenant",
        assignedTechnicianId: 202,
        assignedTechnicianName: "Taylor Tech",
      }),
    ],
  };
  const billingByCompany: Record<number, any[]> = {
    1: [
      billingSheet({}),
      billingSheet({
        id: 12,
        billingNumber: "BS-VALID",
        fieldWorkTypeDetails: "Near loading dock",
      }),
    ],
    2: [],
  };
  const calls: Array<[string, number | null]> = [];
  const storage: MissingLocationDataStorage = {
    async getWorkOrders(companyId) {
      calls.push(["workOrders", companyId]);
      return companyId === null
        ? Object.values(workOrdersByCompany).flat()
        : workOrdersByCompany[companyId] ?? [];
    },
    async getAllBillingSheets(companyId) {
      calls.push(["billingSheets", companyId]);
      return companyId === null
        ? Object.values(billingByCompany).flat()
        : billingByCompany[companyId] ?? [];
    },
    async getFieldWorkTypes(companyId) {
      calls.push(["rules", companyId]);
      if (companyId === 2) {
        return rules.map((rule) => ({ ...rule, companyId: 2 }));
      }
      return rules;
    },
    async getCompanies() {
      return [
        { id: 1, name: "Company One" },
        { id: 2, name: "Company Two" },
      ];
    },
  };
  return { storage, calls };
}

function makeApp(
  role: string,
  companyId: number | null,
  storage: MissingLocationDataStorage,
) {
  const app = express();
  const requireAuthentication = (req: any, _res: any, next: any) => {
    req.authenticatedUserRole = role;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
  registerMissingLocationDataRoute(app, storage, requireAuthentication);
  return app;
}

describe("missing location data report", () => {
  it("includes legacy and current violations across statuses and keeps low-confidence pins separate", async () => {
    const { storage } = makeStorage();
    const response = await request(makeApp("company_admin", 1, storage))
      .get("/api/reports/missing-location-data");

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.rows.map((row: any) => row.ticketNumber),
      ["WO-CURRENT-BILLED", "WO-LOW", "BS-11", "WO-LEGACY"],
    );
    assert.deepEqual(response.body.rows[0].violations, [
      "controller_missing",
      "zone_missing",
    ]);
    assert.deepEqual(
      response.body.rows.find((row: any) => row.ticketNumber === "BS-11").violations,
      ["details_missing"],
    );
    assert.deepEqual(
      response.body.rows.find((row: any) => row.ticketNumber === "WO-LEGACY").violations,
      ["pin_missing", "work_type_missing"],
    );
    const low = response.body.rows.find((row: any) => row.ticketNumber === "WO-LOW");
    assert.equal(low.confidence, "low");
    assert.deepEqual(low.violations, []);
    assert.equal(low.canonicalPath, "/work-orders?openWorkOrder=4");
    assert.equal(
      response.body.rows.find((row: any) => row.ticketNumber === "BS-11").canonicalPath,
      "/billing-sheets?openSheet=11",
    );
    assert.ok(!response.body.rows.some((row: any) => row.ticketNumber === "WO-VALID"));
    assert.ok(!response.body.rows.some((row: any) => row.ticketNumber === "BS-VALID"));
  });

  it("applies type, technician, inclusive date, and low-confidence filters", async () => {
    const { storage } = makeStorage();
    const app = makeApp("billing_manager", 1, storage);

    const type = await request(app)
      .get("/api/reports/missing-location-data?ticketType=billing_sheet");
    assert.deepEqual(type.body.rows.map((row: any) => row.ticketNumber), ["BS-11"]);

    const exactTicket = await request(app)
      .get("/api/reports/missing-location-data?ticketType=work_order&ticketId=4");
    assert.deepEqual(exactTicket.body.rows.map((row: any) => row.ticketNumber), ["WO-LOW"]);

    const technician = await request(app)
      .get("/api/reports/missing-location-data?technician=alex");
    assert.equal(technician.body.count, 4);

    const technicianId = await request(app)
      .get("/api/reports/missing-location-data?technicianId=999");
    assert.equal(technicianId.body.count, 0);

    const dates = await request(app)
      .get("/api/reports/missing-location-data?from=2024-01-11&to=2024-02-01");
    assert.deepEqual(
      dates.body.rows.map((row: any) => row.ticketNumber),
      ["WO-LOW", "BS-11"],
    );

    const low = await request(app)
      .get("/api/reports/missing-location-data?lowConfidenceOnly=true");
    assert.deepEqual(low.body.rows.map((row: any) => row.ticketNumber), ["WO-LOW"]);
  });

  it("derives ordinary scope only from authentication and rejects missing company context", async () => {
    const { storage, calls } = makeStorage();
    const response = await request(makeApp("bookkeeper", 1, storage))
      .get("/api/reports/missing-location-data?companyId=2");

    assert.equal(response.status, 200);
    assert.ok(response.body.rows.every((row: any) => row.companyId === 1));
    assert.ok(calls.some((call) => call[0] === "workOrders" && call[1] === 1));
    assert.ok(!calls.some((call) => call[1] === 2));

    const missingCompany = await request(makeApp("bookkeeper", null, storage))
      .get("/api/reports/missing-location-data");
    assert.equal(missingCompany.status, 403);
  });

  it("lets Super Admin audit every company with company identity on every row", async () => {
    const { storage, calls } = makeStorage();
    const response = await request(makeApp("super_admin", null, storage))
      .get("/api/reports/missing-location-data");

    assert.equal(response.status, 200);
    assert.ok(response.body.rows.some((row: any) => row.companyId === 2));
    assert.ok(response.body.rows.every((row: any) => typeof row.companyName === "string"));
    assert.ok(calls.some((call) => call[0] === "workOrders" && call[1] === null));
    assert.ok(calls.some((call) => call[0] === "rules" && call[1] === 2));
  });

  it("uses the report-read capability allowlist", async () => {
    for (const role of [
      "company_admin",
      "billing_manager",
      "irrigation_manager",
      "bookkeeper",
      "super_admin",
    ]) {
      const { storage } = makeStorage();
      const companyId = role === "super_admin" ? null : 1;
      const response = await request(makeApp(role, companyId, storage))
        .get("/api/reports/missing-location-data?ticketType=work_order");
      assert.equal(response.status, 200, role);
    }

    const { storage } = makeStorage();
    const denied = await request(makeApp("field_tech", 1, storage))
      .get("/api/reports/missing-location-data");
    assert.equal(denied.status, 403);
  });

  it("rejects invalid filters before reading storage", async () => {
    const { storage, calls } = makeStorage();
    const app = makeApp("company_admin", 1, storage);
    assert.equal(
      (await request(app).get("/api/reports/missing-location-data?ticketType=invoice")).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/reports/missing-location-data?technicianId=abc")).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/reports/missing-location-data?ticketId=0")).status,
      400,
    );
    assert.equal(
      (await request(app).get("/api/reports/missing-location-data?from=2024-02-02&to=2024-02-01")).status,
      400,
    );
    assert.deepEqual(calls, []);
  });
});