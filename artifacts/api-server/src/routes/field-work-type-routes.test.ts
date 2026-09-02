import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { registerFieldWorkTypeRoutes } from "./field-work-type-routes";

function makeApp(
  auth: { role: string; companyId: number | null },
  routeStorage: any,
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

  it("lets a company admin read inactive rows in their own company", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      { role: "company_admin", companyId: 41 },
      {
        async getFieldWorkTypes(companyId: number | null, activeOnly: boolean) {
          calls.push([companyId, activeOnly]);
          return [];
        },
        async getFieldWorkTypeById() {},
        async updateFieldWorkType() {},
      },
    );
    const response = await request(app).get("/api/admin/field-work-types");
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [[41, false]]);
  });

  it("returns 404 without disclosing a cross-company patch target", async () => {
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
    );
    const response = await request(app)
      .patch("/api/admin/field-work-types/902")
      .send({ label: "Company A label" });
    assert.equal(response.status, 404);
    assert.deepEqual(calls, [[902, 41, { label: "Company A label" }]]);
  });

  it("rejects attempts to edit immutable code or company scope", async () => {
    const app = makeApp(
      { role: "company_admin", companyId: 41 },
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