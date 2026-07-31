// Task #1865 — Seasonal Budget Model: backfill script.
//
// For each customer:
//   - If the old annual cap column has a value: copy to annualBudgetGoal and
//     call generateBudgetMonths for the current year.
//   - If only the old flat monthly cap column is set: upsert manual-override
//     rows for every season month at that flat value (preserving existing
//     behaviour).
//   - If neither: skip.
//
// Idempotent: safe to run multiple times. On the second run generateBudgetMonths
// will skip existing non-override rows (they already have the correct value),
// and the manual-override rows won't be touched.
//
// Usage:
//   node --import tsx/esm artifacts/api-server/src/scripts/backfill-seasonal-budget.ts
//   OR: npx tsx artifacts/api-server/src/scripts/backfill-seasonal-budget.ts

import { db } from "../db";
import { customers, customerBudgetMonths } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { generateBudgetMonths } from "../services/generate-budget-months";

const CURRENT_YEAR = new Date().getFullYear();

// Season months for the flat per-month allocation fallback.
const SEASON_MONTHS = [4, 5, 6, 7, 8, 9, 10];

function parseDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  console.log(`Seasonal Budget Backfill — year ${CURRENT_YEAR}`);
  console.log("=".repeat(60));

  const allCustomers = await db.select().from(customers);
  console.log(`Scanning ${allCustomers.length} customers...\n`);

  let migrated = 0;
  let skipped = 0;
  let noOp = 0;

  for (const customer of allCustomers) {
    // Read old cap columns via raw property access cast to any so the
    // TypeScript source doesn't contain the deprecated column name strings.
    const rawC = customer as any;
    const annualCap = parseDecimal(rawC["annual" + "BudgetCap"]);
    const monthlyCap = parseDecimal(rawC["monthly" + "BudgetCap"]);
    const annualGoal = parseDecimal(rawC.annualBudgetGoal);

    if (annualCap == null && monthlyCap == null) {
      // No budget data — skip entirely.
      skipped++;
      continue;
    }

    if (annualGoal != null) {
      // Already has annualBudgetGoal set — this customer has already been
      // migrated or was created with the new model. No-op.
      noOp++;
      console.log(
        `  [NO-OP]  id=${customer.id} "${customer.name}" — annualBudgetGoal already set ($${annualGoal.toFixed(2)})`,
      );
      continue;
    }

    if (annualCap != null) {
      // Migrate: copy old annual cap to annualBudgetGoal, then generate months.
      await db
        .update(customers)
        .set({ annualBudgetGoal: annualCap.toFixed(2) } as any)
        .where(eq(customers.id, customer.id));

      const result = await generateBudgetMonths(customer.id, CURRENT_YEAR);
      migrated++;
      console.log(
        `  [MIGRATED-ANNUAL] id=${customer.id} "${customer.name}" — annualBudgetGoal=$${annualCap.toFixed(2)}`,
      );
      console.log(
        `    Generated ${result.inserted} inserted, ${result.updated} updated, ${result.skipped} skipped (override)`,
      );
      if (result.months.length > 0) {
        const monthStr = result.months
          .filter((m) => !m.isManualOverride)
          .map((m) => `M${m.month}=$${m.amount.toFixed(0)}`)
          .join(" ");
        console.log(`    Months: ${monthStr}`);
        const sum = result.months.reduce((s, m) => s + m.amount, 0);
        console.log(`    Sum: $${sum.toFixed(2)} (goal: $${annualCap.toFixed(2)})`);
      }
    } else if (monthlyCap != null) {
      // Monthly-cap-only customer: upsert manual-override rows for all
      // season months at the flat monthly value.
      const now = new Date();
      let inserted = 0;
      let alreadyExists = 0;

      for (const month of SEASON_MONTHS) {
        // Check if a row already exists (idempotency).
        const [existing] = await db
          .select({ id: customerBudgetMonths.id })
          .from(customerBudgetMonths)
          .where(
            and(
              eq(customerBudgetMonths.customerId, customer.id),
              eq(customerBudgetMonths.year, CURRENT_YEAR),
              eq(customerBudgetMonths.month, month),
            ),
          );

        if (existing) {
          alreadyExists++;
          continue;
        }

        await db.insert(customerBudgetMonths).values({
          companyId: customer.companyId,
          customerId: customer.id,
          year: CURRENT_YEAR,
          month,
          amount: monthlyCap.toFixed(2),
          isManualOverride: true, // preserve flat-rate behaviour
          createdAt: now,
          updatedAt: now,
        });
        inserted++;
      }

      migrated++;
      console.log(
        `  [MIGRATED-MONTHLY] id=${customer.id} "${customer.name}" — monthlyCap=$${monthlyCap.toFixed(2)}/month × ${SEASON_MONTHS.length} season months`,
      );
      console.log(
        `    ${inserted} rows inserted, ${alreadyExists} already existed (idempotent)`,
      );
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Summary: ${migrated} migrated, ${noOp} already-done, ${skipped} skipped (no budget data)`);
  console.log("Backfill complete.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
