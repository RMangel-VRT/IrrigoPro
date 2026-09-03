import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyBulkBudgetGoalRow } from "./budget-routes";

function updateChain(customer: any) {
  return {
    set() {
      return {
        where() {
          return {
            async returning() {
              return customer ? [customer] : [];
            },
          };
        },
      };
    },
  };
}

describe("bulk annual budget per-customer transaction", () => {
  it("runs goal update, month generation, and strict audit on the same transaction", async () => {
    const tx = { update: () => updateChain({ id: 44, name: "Alpha HOA" }) };
    let generatedWith: unknown;
    let auditedWith: unknown;
    let auditedDetails: any;
    const database = {
      async transaction(callback: (executor: any) => Promise<unknown>) {
        return callback(tx);
      },
    };

    const result = await applyBulkBudgetGoalRow({
      req: {
        authenticatedUserId: 7,
        authenticatedUserRole: "company_admin",
        authenticatedUserCompanyId: 10,
      },
      customerId: 44,
      customerName: "Alpha HOA",
      companyId: 10,
      year: 2027,
      beforeGoal: "1000.00",
      nextGoal: 2500,
    }, {
      database: database as any,
      generateMonths: (async (_customerId: number, _year: number, executor: any) => {
        generatedWith = executor;
        return { year: 2027, inserted: 7, updated: 0, skipped: 0, months: [] };
      }) as any,
      audit: (async (_req: any, event: any, options: any) => {
        auditedWith = options.tx;
        auditedDetails = { event, options };
      }) as any,
    });

    assert.equal(generatedWith, tx);
    assert.equal(auditedWith, tx);
    assert.equal(auditedDetails.options.strict, true);
    assert.equal(auditedDetails.event.details.origin, "bulk_budget_goals");
    assert.equal(auditedDetails.event.details.targetYear, 2027);
    assert.equal(auditedDetails.event.details.beforeGoal, "1000.00");
    assert.equal(auditedDetails.event.details.afterGoal, "2500.00");
    assert.equal(result.unchanged, false);
    if (!result.unchanged) assert.equal(result.year, 2027);
  });

  it("rejects the customer transaction when the strict audit insert fails", async () => {
    const tx = { update: () => updateChain({ id: 44, name: "Alpha HOA" }) };
    let transactionRejected = false;
    const database = {
      async transaction(callback: (executor: any) => Promise<unknown>) {
        try {
          return await callback(tx);
        } catch (error) {
          transactionRejected = true;
          throw error;
        }
      },
    };
    await assert.rejects(
      applyBulkBudgetGoalRow({
        req: { authenticatedUserId: 7, authenticatedUserRole: "company_admin" },
        customerId: 44,
        customerName: "Alpha HOA",
        companyId: 10,
        year: 2027,
        beforeGoal: "1000.00",
        nextGoal: 2500,
      }, {
        database: database as any,
        generateMonths: (async () => ({
          year: 2027,
          inserted: 0,
          updated: 7,
          skipped: 0,
          months: [],
        })) as any,
        audit: (async () => {
          throw new Error("audit unavailable");
        }) as any,
      }),
      /audit unavailable/,
    );
    assert.equal(transactionRejected, true);
  });

  it("turns a concurrent same-goal update into a no-op without months or audit", async () => {
    let generated = false;
    let audited = false;
    const tx = {
      update: () => updateChain(null),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ annualBudgetGoal: "2500.00" }],
          }),
        }),
      }),
    };
    const result = await applyBulkBudgetGoalRow({
      req: { authenticatedUserId: 7, authenticatedUserRole: "company_admin", authenticatedUserCompanyId: 10 },
      customerId: 44,
      customerName: "Alpha HOA",
      companyId: 10,
      year: 2027,
      beforeGoal: "1000.00",
      nextGoal: 2500,
    }, {
      database: { transaction: async (callback: any) => callback(tx) } as any,
      generateMonths: (async () => {
        generated = true;
        throw new Error("must not generate");
      }) as any,
      audit: (async () => {
        audited = true;
      }) as any,
    });
    assert.equal(result.unchanged, true);
    assert.equal(generated, false);
    assert.equal(audited, false);
  });
});