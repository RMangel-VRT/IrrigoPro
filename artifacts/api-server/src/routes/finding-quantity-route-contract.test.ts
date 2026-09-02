import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "routes.ts"), "utf8");
const marker = 'app.patch("/api/wet-check-billings/:id/finding-quantity"';
const start = source.indexOf(marker);
const route = start < 0 ? "" : source.slice(start, start + 7000);

describe("WC Snapshot finding quantity route contract", () => {
  it("registers the authenticated PATCH route with the exact lifecycle action", () => {
    assert.ok(start >= 0, "finding quantity PATCH route is missing");
    assert.match(route, /requireAuthentication/);
    assert.match(route, /wet_check_billing\.finding_quantity_edited/);
  });

  it("uses the billing-manager/admin allowlist and 1..999 integer validation", () => {
    for (const role of ["billing_manager", "company_admin", "super_admin"]) {
      assert.ok(route.includes(`role !== "${role}"`));
    }
    assert.match(source.slice(Math.max(0, start - 1000), start), /\.int\(\)\.min\(1\)\.max\(999\)/);
  });

  it("returns the storage mutation response and keeps audit failure non-fatal", () => {
    assert.match(route, /storage\.setWcbFindingQuantity/);
    assert.match(route, /catch \(auditErr\)/);
    assert.ok(route.indexOf("res.json(result.updated)") > route.indexOf("catch (auditErr)"));
  });

  it("records finding, quantity, zone labor, and manual replacement state", () => {
    for (const field of ["findingId", "issueType", "quantity", "zoneLaborHours", "laborWasManual"]) {
      assert.ok(route.includes(field), `missing audit field ${field}`);
    }
    assert.match(route, /laborWasManual:\s*!!result\.updated\.zoneRecord\.repairLaborManuallySet/);
  });
});
