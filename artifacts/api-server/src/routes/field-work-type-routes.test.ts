import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { registerFieldWorkTypeRoutes } from "./field-work-type-routes";

function makeApp(
  auth: { role: string; companyId: number | null },
  routeStorage: any,
  requireAdmin?: any,
) {
  const app = express();
  app.use(express.json());
  const requireAuthentication = (req: any, _res: any, next: any) => {
    req.authenticatedUserRole = auth.role;
    req.authenticatedUserCompanyId = auth.companyId;
    next();
  };
  registerFieldWorkTypeRoutes(app, {
    requireAuthentication,
    storage: routeStorage,
    requireAdmin,
  });
  return app;
}

describe("field work type routes", () => {
  it("derives active-list scope only from the authenticated company", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "field_tech", companyId: 41 },
      {
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return [{ id: 1, companyId: 41, code: "other", label: "Other" }];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );
    const response = await request(app)
      .get("/api/field-work-types?companyId=999")
      .set("x-user-company-id", "999");
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [[41, true]]);
    assert.equal(response.body[0].companyId, 41);
  });

  it("answers a super admin for the named customer's tenant, not every tenant", async () => {
    // The location gate fails open for a company with no active work types.
    // A super admin has no company of their own, so the unscoped read would
    // hand back another tenant's types and make the client re-impose a gate
    // the server has already waived for this customer.
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "super_admin", companyId: null },
      {
        async getCustomerById(id: number) {
          return id === 500 ? { id: 500, companyId: 88 } : undefined;
        },
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return companyId === 88 ? [] : [{ id: 1, companyId: 41, code: "other" }];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );

    const scoped = await request(app).get("/api/field-work-types?customerId=500");
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.body, []);

    // An unknown or absent customer keeps the previous unscoped behaviour.
    const unknown = await request(app).get("/api/field-work-types?customerId=999");
    assert.equal(unknown.status, 200);
    const unscoped = await request(app).get("/api/field-work-types");
    assert.equal(unscoped.status, 200);

    assert.deepEqual(calls, [[88, true], [null, true], [null, true]]);
  });

  it("never lets the customer parameter move a tenant's own scope", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "company_admin", companyId: 41 },
      {
        async getCustomerById() {
          throw new Error("must not be called for a scoped caller");
        },
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );

    const response = await request(app).get("/api/field-work-types?customerId=500");
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [[41, true]]);
  });

  it("answers with retired rows only when the caller asks for them", async () => {
    // A surface that has to render or evaluate a code already stored on a
    // record needs the full registry; the default stays active-only so no
    // existing caller starts seeing types nobody may choose.
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "field_tech", companyId: 41 },
      {
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return activeOnly
            ? [{ id: 1, companyId: 41, code: "other", label: "Other", active: true }]
            : [
                { id: 1, companyId: 41, code: "other", label: "Other", active: true },
                { id: 2, companyId: 41, code: "zone_repair", label: "Zone Repair", active: false },
              ];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );

    const full = await request(app).get("/api/field-work-types?includeRetired=true");
    assert.equal(full.status, 200);
    assert.deepEqual(
      full.body.map((row: any) => [row.code, row.active]),
      [["other", true], ["zone_repair", false]],
    );

    const byDefault = await request(app).get("/api/field-work-types");
    assert.equal(byDefault.status, 200);
    assert.deepEqual(byDefault.body.map((row: any) => row.code), ["other"]);

    // Anything that is not an explicit opt-in stays active-only.
    const noise = await request(app).get("/api/field-work-types?includeRetired=maybe");
    assert.equal(noise.status, 200);

    assert.deepEqual(calls, [[41, false], [41, true], [41, true]]);
  });

  it("keeps the customer scope when the full registry is requested", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "super_admin", companyId: null },
      {
        async getCustomerById(id: number) {
          return id === 500 ? { id: 500, companyId: 88 } : undefined;
        },
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );

    const response = await request(app)
      .get("/api/field-work-types?customerId=500&includeRetired=true");
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [[88, false]]);
  });

  it("capability-gates admin reads", async () => {
    const app = makeApp(
      { role: "field_tech", companyId: 41 },
      {
        async getFieldWorkTypes() {
          throw new Error("must not be called");
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );
    const response = await request(app).get("/api/admin/field-work-types");
    assert.equal(response.status, 403);
  });

  it("refuses a company admin the registry entirely", async () => {
    // Work types are a preset list owned by code plus the seed migration. A
    // company admin renaming a preset or flipping its requirement flags is the
    // per-company drift that decision rules out, so both the admin read and
    // the patch answer a clean 403 rather than quietly accepting the edit.
    const app = makeApp(
      { role: "company_admin", companyId: 41 },
      {
        async getFieldWorkTypes() {
          throw new Error("must not be called");
        },
        async getFieldWorkTypeById() {
          throw new Error("must not be called");
        },
        async updateFieldWorkType() {
          throw new Error("must not be called");
        },
      },
    );

    const read = await request(app).get("/api/admin/field-work-types");
    assert.equal(read.status, 403);

    const patch = await request(app)
      .patch("/api/admin/field-work-types/1")
      .send({ label: "Our own name for it", requiresZone: false });
    assert.equal(patch.status, 403);
  });

  it("returns 404 without disclosing a cross-company patch target", async () => {
    // The route's own tenant scoping is a separate question from the
    // capability: a refusal on your own company's data is a 403, while a
    // target that is not yours to see must stay a 404 rather than confirming
    // it exists. The guard is stubbed here so this asserts only the scoping.
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "company_admin", companyId: 41 },
      {
        async getFieldWorkTypes() {
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType(id: number, companyId: number | null, patch: unknown) {
          calls.push([id, companyId, patch]);
          return undefined;
        },
      },
      (_req: any, _res: any, next: any) => next(),
    );
    const response = await request(app)
      .patch("/api/admin/field-work-types/902")
      .send({ label: "Company A label" });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, [[902, 41, { label: "Company A label" }]]);
  });

  it("still 404s a super admin patching a row that does not exist", async () => {
    const app = makeApp(
      { role: "super_admin", companyId: null },
      {
        async getFieldWorkTypes() {
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {
          return undefined;
        },
      },
    );
    const response = await request(app)
      .patch("/api/admin/field-work-types/902")
      .send({ label: "Renamed preset" });
    assert.equal(response.status, 404);
  });

  it("rejects attempts to edit immutable code or company scope", async () => {
    const app = makeApp(
      { role: "super_admin", companyId: null },
      {
        async getFieldWorkTypes() {
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {
          throw new Error("must not be called");
        },
      },
    );
    const response = await request(app)
      .patch("/api/admin/field-work-types/1")
      .send({ code: "foreign", companyId: 999 });
    assert.equal(response.status, 400);
  });

  it("allows a super admin to list and patch across tenants explicitly", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "super_admin", companyId: null },
      {
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push(["list", companyId, activeOnly]);
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType(id: number, companyId: number | null, patch: unknown) {
          calls.push(["patch", id, companyId, patch]);
          return {
            id,
            companyId: 99,
            code: "other",
            label: "Other work",
            requiresController: false,
            requiresZone: false,
            requiresDetails: true,
            sortOrder: 70,
            active: true,
            createdAt: new Date(),
          };
        },
      },
    );
    assert.equal((await request(app).get("/api/admin/field-work-types")).status, 200);
    assert.equal(
      (await request(app)
        .patch("/api/admin/field-work-types/7")
        .send({ label: "Other work" })).status,
      200,
    );
    assert.deepEqual(calls, [
      ["list", null, false],
      ["patch", 7, null, { label: "Other work" }],
    ]);
  });
});