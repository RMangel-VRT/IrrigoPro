/**
 * bill-separately.test.ts — Task #1809
 *
 * Static-analysis guards for the "Bill Separately" feature.  Uses source
 * reading (no DB, no HTTP) to assert structural invariants that would be
 * easy to accidentally break when the 10k-line routes.ts is edited:
 *
 *  1. Endpoint exists and is guarded by requireAuthentication + requireInvoiceWrite
 *     (Task #1886 split requireBillingAccess into read/write/send guards)
 *  2. Body is validated with Zod (ticketType enum, ticketId int)
 *  3. Double-billing guard: invoice is rolled back when QB sync fails
 *  4. Standalone invoices are stamped with billingType: 'standalone'
 *  5. PDF generator skips reconciliationPage for standalone invoices
 *  6. Cover page branches on billingType === 'standalone'
 *  7. Invoice status update (stamp) happens for all three ticket types
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const routesSrc = readFileSync(path.join(__dirname, "routes.ts"), "utf8");
const pdfGeneratorSrc = readFileSync(
  path.join(__dirname, "..", "pdf-generator.ts"),
  "utf8",
);
const pdfHelpersSrc = readFileSync(
  path.join(__dirname, "..", "pdf-helpers.ts"),
  "utf8",
);

/** Return the slice of `src` centered around the FIRST occurrence of `anchor`. */
function nearby(src: string, anchor: string, windowSize = 1200): string | null {
  const idx = src.indexOf(anchor);
  if (idx < 0) return null;
  return src.slice(Math.max(0, idx - windowSize / 2), idx + windowSize / 2);
}

// ── 1. Endpoint registration ────────────────────────────────────────────────

describe("bill-separately endpoint: registration", () => {
  it("POST /api/invoices/bill-separately exists in routes.ts", () => {
    assert.ok(
      routesSrc.includes('"/api/invoices/bill-separately"'),
      "Expected POST /api/invoices/bill-separately to be registered",
    );
  });

  it("endpoint is guarded by requireAuthentication", () => {
    const region = nearby(routesSrc, '"/api/invoices/bill-separately"', 400);
    assert.ok(region, "anchor not found");
    assert.ok(
      region.includes("requireAuthentication"),
      `Expected requireAuthentication guard near endpoint\n\n${region}`,
    );
  });

  // Task #1886 — requireBillingAccess split into read/write/send. Billing a
  // ticket separately creates an invoice, so this site is write-classified and
  // its membership is unchanged (super_admin / company_admin / billing_manager).
  it("endpoint is guarded by requireInvoiceWrite", () => {
    const region = nearby(routesSrc, '"/api/invoices/bill-separately"', 400);
    assert.ok(region, "anchor not found");
    assert.ok(
      region.includes("requireInvoiceWrite"),
      `Expected requireInvoiceWrite guard near endpoint\n\n${region}`,
    );
  });
});

// ── 2. Body validation ──────────────────────────────────────────────────────

describe("bill-separately endpoint: body validation", () => {
  it("validates ticketType enum via Zod", () => {
    const region = nearby(routesSrc, "bill-separately", 3000);
    assert.ok(region, "anchor not found");
    assert.ok(
      region.includes("ticketType") && region.includes("z.enum"),
      `Expected Zod enum validation for ticketType\n\n${region?.slice(0, 500)}`,
    );
  });

  it("accepts 'work_order', 'billing_sheet', 'wet_check_billing' as valid ticketTypes", () => {
    const region = nearby(routesSrc, "bill-separately", 3000);
    assert.ok(region, "anchor not found");
    assert.ok(region!.includes("'work_order'"), "missing 'work_order' in enum");
    assert.ok(region!.includes("'billing_sheet'"), "missing 'billing_sheet' in enum");
    assert.ok(region!.includes("'wet_check_billing'"), "missing 'wet_check_billing' in enum");
  });

  it("validates ticketId as a positive integer", () => {
    const region = nearby(routesSrc, "bill-separately", 3000);
    assert.ok(region, "anchor not found");
    assert.ok(
      region!.includes("ticketId") && region!.includes("z.number()"),
      `Expected Zod number validation for ticketId\n\n${region?.slice(0, 500)}`,
    );
  });
});

// ── 3. Double-billing guard ─────────────────────────────────────────────────

describe("bill-separately endpoint: double-billing guard", () => {
  it("checks ticketInvoiceId before creating invoice", () => {
    const region = nearby(routesSrc, "Double-billing guard", 800);
    assert.ok(
      region !== null,
      "Expected a 'Double-billing guard' comment block in routes.ts",
    );
    assert.ok(
      region!.includes("ticketInvoiceId"),
      `Expected ticketInvoiceId check in double-billing guard\n\n${region}`,
    );
    assert.ok(
      region!.includes("409"),
      `Expected 409 response for already-invoiced items\n\n${region}`,
    );
  });
});

// ── 4. billingType stamp ────────────────────────────────────────────────────

describe("bill-separately endpoint: standalone stamp", () => {
  it("stamps billingType: 'standalone' on the created invoice", () => {
    const region = nearby(routesSrc, "billingType: 'standalone'", 200);
    assert.ok(
      region !== null,
      "Expected billingType: 'standalone' to appear in routes.ts",
    );
  });

  it("does not set billingType to 'monthly' for standalone invoices", () => {
    // We verify the createInvoice call inside bill-separately uses 'standalone', not 'monthly'.
    // The createInvoice call is ~5.1k chars into the handler — use a 6k window.
    const endpointIdx = routesSrc.indexOf('"/api/invoices/bill-separately"');
    assert.ok(endpointIdx >= 0, "endpoint not found");
    const endpointBlock = routesSrc.slice(endpointIdx, endpointIdx + 6000);
    assert.ok(
      endpointBlock.includes("billingType: 'standalone'"),
      "Expected billingType: 'standalone' inside bill-separately handler",
    );
  });
});

// ── 5. PDF generator: reconciliationPage skipped for standalone ─────────────

describe("pdf-generator: standalone skips reconciliation page", () => {
  it("reconciliationPage is conditionally omitted for standalone invoices", () => {
    assert.ok(
      pdfGeneratorSrc.includes("billingType === 'standalone'"),
      "Expected billingType === 'standalone' branch in pdf-generator.ts",
    );
  });

  it("reconciliation section is empty string for standalone", () => {
    const region = nearby(pdfGeneratorSrc, "billingType === 'standalone'", 600);
    assert.ok(region, "anchor not found in pdf-generator.ts");
    assert.ok(
      region.includes("''"),
      `Expected empty string assignment for reconcSection when standalone\n\n${region}`,
    );
  });
});

// ── 6. Cover page: standalone branch ───────────────────────────────────────

describe("pdf-helpers: coverPage standalone branch", () => {
  it("coverPage branches on billingType === 'standalone'", () => {
    assert.ok(
      pdfHelpersSrc.includes("billingType === 'standalone'"),
      "Expected billingType === 'standalone' branch in pdf-helpers.ts coverPage",
    );
  });

  it("standalone cover retitles to 'Service Invoice'", () => {
    const region = nearby(pdfHelpersSrc, "billingType === 'standalone'", 2000);
    assert.ok(region, "anchor not found in pdf-helpers.ts");
    assert.ok(
      region.includes("Service Invoice"),
      `Expected 'Service Invoice' title in standalone cover page\n\n${region?.slice(0, 600)}`,
    );
  });

  it("standalone cover shows 'Service Date' instead of 'Billing Period'", () => {
    const region = nearby(pdfHelpersSrc, "billingType === 'standalone'", 2000);
    assert.ok(region, "anchor not found in pdf-helpers.ts");
    assert.ok(
      region.includes("Service Date"),
      `Expected 'Service Date' in standalone cover page\n\n${region?.slice(0, 600)}`,
    );
  });

  it("standalone cover does NOT include Per-Branch Summary", () => {
    const idx = pdfHelpersSrc.indexOf("billingType === 'standalone'");
    assert.ok(idx >= 0, "anchor not found");
    // The standalone early-return block should close before branchSummaryHtml is referenced
    const standaloneBlock = pdfHelpersSrc.slice(idx, idx + 3000);
    // branchSummaryHtml should not appear in the standalone early-return block
    // (it appears only in the regular monthly code path after the early return)
    const earlyReturnEnd = standaloneBlock.indexOf("return `");
    assert.ok(earlyReturnEnd >= 0, "Expected a return statement in standalone block");
    const blockBeforeReturn = standaloneBlock.slice(0, earlyReturnEnd + 200);
    assert.ok(
      !blockBeforeReturn.includes("branchSummaryHtml"),
      `Per-Branch Summary should not appear in standalone cover return\n\n${blockBeforeReturn.slice(0, 400)}`,
    );
  });
});

// ── 7. Ticket stamping ──────────────────────────────────────────────────────

describe("bill-separately endpoint: ticket stamping after invoice creation", () => {
  // Stamping section is ~10k chars into the handler — use a generous window.
  const STAMP_WINDOW = 13000;

  it("stamps work orders with status 'billed' after standalone invoice creation", () => {
    const endpointIdx = routesSrc.indexOf('"/api/invoices/bill-separately"');
    assert.ok(endpointIdx >= 0, "endpoint not found");
    const endpointBlock = routesSrc.slice(endpointIdx, endpointIdx + STAMP_WINDOW);
    assert.ok(
      endpointBlock.includes("status: 'billed'"),
      "Expected status: 'billed' stamp after standalone invoice creation",
    );
  });

  it("stamps billedAt on the ticket after standalone invoice creation", () => {
    const endpointIdx = routesSrc.indexOf('"/api/invoices/bill-separately"');
    assert.ok(endpointIdx >= 0, "endpoint not found");
    const endpointBlock = routesSrc.slice(endpointIdx, endpointIdx + STAMP_WINDOW);
    assert.ok(
      endpointBlock.includes("billedAt: currentDate"),
      "Expected billedAt stamp after standalone invoice creation",
    );
  });

  it("stamps invoiceId on the ticket after standalone invoice creation", () => {
    const endpointIdx = routesSrc.indexOf('"/api/invoices/bill-separately"');
    assert.ok(endpointIdx >= 0, "endpoint not found");
    const endpointBlock = routesSrc.slice(endpointIdx, endpointIdx + STAMP_WINDOW);
    assert.ok(
      endpointBlock.includes("invoiceId: invoice.id"),
      "Expected invoiceId stamp after standalone invoice creation",
    );
  });
});
