/**
 * wcb-invoice-gate.test.ts
 *
 * Invariant: invoice-construction filter sites use `wcbIsEligible(wcb)` which
 * gates on `unroutedFindingsCount === 0` (every finding on the parent wet check
 * triaged or auto-billed) rather than the old blunt `wetCheckStatus === 'converted'`
 * check which blocked partially_converted wet checks even when all findings were
 * actually routed.
 *
 * Visibility paths must NOT gate on wetCheckStatus so that partially-converted-
 * parent WCBs are still reachable by billing managers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesSrc = readFileSync(
  path.join(__dirname, "routes.ts"),
  "utf8",
);
const storageSrc = readFileSync(
  path.join(__dirname, "..", "storage.ts"),
  "utf8",
);
const predicatesSrc = readFileSync(
  path.join(__dirname, "..", "lib", "finding-predicates.ts"),
  "utf8",
);
// Task #1898 — the billing-preview customer list was batched and its
// assembly moved out of routes.ts into this module. The visibility invariant
// below follows it there; it is not weakened, just re-anchored.
const previewSrc = readFileSync(
  path.join(__dirname, "..", "billing-preview-sources.ts"),
  "utf8",
);

/**
 * Return the N characters around the first occurrence of `anchor` in `src`.
 */
function nearby(src: string, anchor: string, window = 800): string | null {
  const idx = src.indexOf(anchor);
  if (idx < 0) return null;
  return src.slice(Math.max(0, idx - window / 2), idx + window / 2);
}

describe("WCB invoice-gate: wcbIsEligible guard", () => {
  // Invoice-construction paths — must use wcbIsEligible (not the old converted check).
  const invoiceConstructionSites = [
    // 3. Invoice preview: eligibleWcbs filter
    "eligibleWcbs = allWcbsForPreview.filter",
    // 4. Monthly invoice: eligibleWcbsMonthly filter
    "eligibleWcbsMonthly = allWcbsForMonthly.filter",
  ];

  // Visibility paths — converted gate must be ABSENT (partial-parent WCBs must
  // still surface so billing managers can act on them).
  const visibilitySites: Array<{ src: string; anchor: string }> = [
    // 1. Billing-preview customer list: WCBs fed into computeUnbilledPartition
    //    straight from the batched loader, no converted gate applied.
    //    (Task #1898 — assembly lives in billing-preview-sources.ts now.)
    { src: previewSrc, anchor: "wetCheckBillings," },
    // 2. Single-customer billing page: unbilledWetCheckBillings derives from
    //    computeUnbilledPartition output (detailPartition.approvedWetCheckBillings).
    { src: routesSrc, anchor: "unbilledWetCheckBillings = detailPartition.approvedWetCheckBillings" },
  ];

  for (const anchor of invoiceConstructionSites) {
    it(`invoice-construction filter at "${anchor.slice(0, 50)}…" calls wcbIsEligible`, () => {
      const region = nearby(routesSrc, anchor, 800);
      assert.ok(region, `anchor not found: ${anchor}`);
      assert.ok(
        region.includes("wcbIsEligible"),
        `Expected wcbIsEligible call near "${anchor.slice(0, 60)}…"\n\nActual region:\n${region}`,
      );
    });

    it(`invoice-construction filter at "${anchor.slice(0, 50)}…" does NOT use old wetCheckStatus === 'converted' guard`, () => {
      const region = nearby(routesSrc, anchor, 400);
      assert.ok(region, `anchor not found: ${anchor}`);
      assert.ok(
        !region.includes("wetCheckStatus === 'converted'"),
        `Old blunt wetCheckStatus guard must be removed from "${anchor.slice(0, 60)}…"\n\nActual region:\n${region}`,
      );
    });
  }

  it("both invoice-construction filter sites exist in routes.ts", () => {
    let found = 0;
    for (const anchor of invoiceConstructionSites) {
      if (routesSrc.includes(anchor)) found++;
    }
    assert.equal(found, 2, `Expected 2 invoice-construction filter sites, found ${found}`);
  });

  for (const { src, anchor } of visibilitySites) {
    it(`visibility filter at "${anchor.slice(0, 50)}…" must NOT gate on wetCheckStatus`, () => {
      const region = nearby(src, anchor, 800);
      assert.ok(region, `anchor not found: ${anchor}`);
      // The gate must be absent from the filter expression itself.
      // We look for the closing ')' of the filter callback to bound the search.
      // Use a tighter 400-char window so we don't accidentally catch a nearby comment.
      const tightRegion = nearby(src, anchor, 400) ?? "";
      assert.ok(
        !tightRegion.includes("wetCheckStatus === 'converted'"),
        `wetCheckStatus === 'converted' must NOT appear in the visibility filter near "${anchor.slice(0, 60)}…"\n\nActual region:\n${tightRegion}`,
      );
    });
  }

  it("both visibility filter sites still exist", () => {
    let found = 0;
    for (const { src, anchor } of visibilitySites) {
      if (src.includes(anchor)) found++;
    }
    assert.equal(found, 2, `Expected 2 visibility filter sites, found ${found}`);
  });

  it("getWetCheckBillingsByCustomer implementation JOINs wet_checks and exposes wetCheckStatus and unroutedFindingsCount", () => {
    const implAnchor = "async getWetCheckBillingsByCustomer(";
    const region = nearby(storageSrc, implAnchor, 3000);
    assert.ok(region, `implementation anchor not found: ${implAnchor}`);
    assert.ok(
      region.includes("WetCheckBillingListItem"),
      "getWetCheckBillingsByCustomer must return WetCheckBillingListItem[] (which carries wetCheckStatus)",
    );
    assert.ok(
      region.includes("wetCheckStatus"),
      "getWetCheckBillingsByCustomer implementation must JOIN wet_checks and expose wetCheckStatus",
    );
    assert.ok(
      region.includes("unroutedFindingsCount"),
      "getWetCheckBillingsByCustomer must compute unroutedFindingsCount via sub-query for the billing gate",
    );
  });

  it("wcbIsEligible in finding-predicates.ts gates on unroutedFindingsCount === 0", () => {
    assert.ok(
      predicatesSrc.includes("unroutedFindingsCount === 0"),
      "wcbIsEligible must gate on unroutedFindingsCount === 0, not wetCheckStatus",
    );
    assert.ok(
      !predicatesSrc.includes("wetCheckStatus"),
      "wcbIsEligible must not gate on wetCheckStatus (use unroutedFindingsCount instead)",
    );
  });

  it("partially_converted WCB at approved_passed_to_billing appears in billing-preview visibility filter", () => {
    // Regression case: WCBs flow from getWetCheckBillingsByCustomer into
    // computeUnbilledPartition without a wetCheckStatus === 'converted' gate.
    // computeUnbilledPartition uses WCB_APPROVED ('approved_passed_to_billing')
    // as its approved-bucket criterion, so partially-converted-parent WCBs
    // with that status are included in approvedTotal.
    //
    // Verify via the billing-unbilled-selectors source which defines WCB_APPROVED.
    const selectorsSrc = readFileSync(
      path.join(__dirname, "..", "billing-unbilled-selectors.ts"),
      "utf8",
    );
    assert.ok(
      selectorsSrc.includes("WCB_APPROVED = 'approved_passed_to_billing'"),
      "billing-unbilled-selectors must classify WCB_APPROVED as 'approved_passed_to_billing' — not gated on wetCheckStatus",
    );
    assert.ok(
      !selectorsSrc.includes("wetCheckStatus === 'converted'"),
      "billing-unbilled-selectors must not gate on wetCheckStatus === 'converted'",
    );
    // Also verify the single-customer billing page derives unbilledWetCheckBillings
    // from the partition (computeUnbilledPartition) output, not from a hard filter.
    const anchor = "unbilledWetCheckBillings = detailPartition.approvedWetCheckBillings";
    assert.ok(
      routesSrc.includes(anchor),
      `Single-customer billing page must derive unbilledWetCheckBillings from computeUnbilledPartition output (anchor: "${anchor}")`,
    );
  });

  it("needs-review endpoint uses isUnroutedFinding (not the old loose predicate)", () => {
    const anchor = "const unroutedFindings = wFindings.filter";
    const region = nearby(routesSrc, anchor, 800);
    assert.ok(region, `anchor not found: ${anchor}`);
    assert.ok(
      region.includes("isUnroutedFinding"),
      "needs-review handler must call isUnroutedFinding so the count agrees with CombinedReviewSurface",
    );
    // The old loose predicate looked for routing FKs but did not call isNeedsReview.
    // Verify it's gone by checking the old sentinel phrase is absent.
    assert.ok(
      !region.includes("documented_only"),
      "Old loose predicate (checking resolution !== 'documented_only') must be replaced by isUnroutedFinding",
    );
  });
});
