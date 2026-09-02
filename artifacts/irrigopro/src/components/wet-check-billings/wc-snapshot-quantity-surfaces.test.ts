import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]) =>
  readFileSync(join(here, "..", ...parts), "utf8");

describe("WC Snapshot quantity editor surface wiring", () => {
  it("the dedicated WCB modal passes its real WCB id and shared edit permission", () => {
    const source = src("wet-check-billings", "wet-check-billing-view-modal.tsx");
    expect(source).toContain("wcbId={wcb.id}");
    expect(source).toContain("canEditQuantity={canEditSnapshotFields}");
    expect(source).toContain("canEditWetCheckBillingFields(getUserRole(), wcb)");
  });

  it("the combined review surface passes its real WCB id and shared edit permission", () => {
    const source = src("wet-check-review", "CombinedReviewSurface.tsx");
    expect(source).toContain("wcbId={wcb.id}");
    expect(source).toContain("canEditQuantity={canEditSnapshotFields}");
    expect(source).toContain("canEditWetCheckBillingFields(getUserRole(), wcb)");
  });

  it("completed work uses payload wetCheckBillingId and never guesses from billing-sheet id", () => {
    const source = src("billing", "completed-work-detail-modal.tsx");
    const marker = source.indexOf("<WetCheckBillingViewComponent");
    expect(marker).toBeGreaterThanOrEqual(0);
    const invocation = source.slice(marker, marker + 900);
    expect(invocation).toContain("wcbId={wetCheckView.wetCheckBillingId}");
    expect(invocation).toContain("canEditQuantity={canEditWetCheckSnapshot}");
    expect(source).toContain("canEditWetCheckBillingFields(userRole");
    expect(invocation).not.toContain("wcbId={id}");
  });

  it("the shared view renders quantity and labor controls read-only when no WCB id exists", () => {
    const source = src("billing", "wet-check-billing-view.tsx");
    expect(source).toContain("wcbId != null ? (");
    expect(source).toContain("FindingQuantityEditInline");
    expect(source).toContain("{wcbId != null ? (");
    expect(source).toContain("<ZoneLaborEditInline");
  });
});
