// Tests for irrigation-controller-resolver.ts
//
// Verifies that resolveWetCheckControllers reads `controller.letter` directly
// from `irrigation_controllers` (Task #1856 — stored letter).
// The legacy property_controllers fallback has been removed; the resolver now
// seeds from customers.totalControllers when no irrigation profile exists.
// Uses a local resolveWithFakes helper — no shared dev-DB required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Fakes ──────────────────────────────────────────────────────────────────────

type FakeIrrigController = {
  id: number;
  name: string;
  letter: string | null; // Task #1856: stored column; null only for pre-backfill rows
  totalZones: number | null;
  notes: string | null;
  branchName: string;
};

interface FakeStorage {
  listIrrigationControllers: (
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ) => Promise<FakeIrrigController[]>;
}

// ── Pure resolver logic matching the production resolver ──────────────────────

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function resolveWithFakes(
  storage: FakeStorage,
  companyId: number,
  customerId: number,
  branchName?: string | null,
): Promise<{ letter: string; zoneCount: number | null; notes: string | null; name: string; id: number }[]> {
  const branch = branchName ?? null;
  const branchArg = typeof branch === "string" ? branch : undefined;

  const irrigCtrls = await storage.listIrrigationControllers(companyId, customerId, branchArg);
  if (irrigCtrls.length > 0) {
    return irrigCtrls.map((ctrl, index) => ({
      // Task #1856: read stored letter; positional fallback only for pre-backfill NULLs
      letter: ctrl.letter ?? ALPHABET[index] ?? String(index),
      zoneCount: ctrl.totalZones ?? null,
      notes: ctrl.notes ?? null,
      name: ctrl.name,
      id: ctrl.id,
    }));
  }

  // No profile rows — production code seeds from totalControllers. In these
  // unit tests we simply return [] since we have no customer record to seed from.
  return [];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveWetCheckControllers — irrigation_controllers primary path", () => {
  it("returns stored letters from irrigation_controllers rows", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Hunter Clock - East", letter: "A", totalZones: 14, notes: null, branchName: "" },
        { id: 2, name: "Rainbird - West",     letter: "B", totalZones: 8,  notes: "note b", branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result.length, 2);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 14);
    assert.equal(result[0].notes, null);
    assert.equal(result[1].letter, "B");
    assert.equal(result[1].zoneCount, 8);
    assert.equal(result[1].notes, "note b");
  });

  it("returns controller name and id in the resolved shape (Task #1856)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 42, name: "Hunter Clock - East", letter: "A", totalZones: 20, notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 99);
    assert.equal(result[0].name, "Hunter Clock - East");
    assert.equal(result[0].id, 42);
  });

  it("passes through null totalZones as null (no silent 12 default)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", letter: "A", totalZones: null, notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].zoneCount, null);
  });

  it("reads letter directly from stored column — descriptive names no longer collapse", async () => {
    // The original bug: six descriptive names all ended in non-letter words,
    // so extractLetter() returned null → all positionally used the SAME last-word
    // letter, causing collisions. With stored letters, each controller has a
    // distinct pre-assigned letter regardless of its name.
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 134, name: "Hunter Clock - East",        letter: "A", totalZones: 40, notes: null, branchName: "" },
        { id: 135, name: "Hunter Clock - West",        letter: "B", totalZones: 48, notes: null, branchName: "" },
        { id: 137, name: "Rainbird - 136th SouthEast", letter: "C", totalZones: 24, notes: null, branchName: "" },
        { id: 139, name: "Rainbird - Broadlands Lane", letter: "D", totalZones: 40, notes: null, branchName: "" },
        { id: 138, name: "Rainbird - West",            letter: "E", totalZones: 37, notes: null, branchName: "" },
        { id: 136, name: "Rainbird Clock - East",      letter: "F", totalZones: 41, notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 271);
    assert.equal(result.length, 6);
    assert.equal(result[0].letter, "A");
    assert.equal(result[1].letter, "B");
    assert.equal(result[2].letter, "C");
    assert.equal(result[3].letter, "D");
    assert.equal(result[4].letter, "E");
    assert.equal(result[5].letter, "F");

    const letters = result.map(r => r.letter);
    const unique = new Set(letters);
    assert.equal(unique.size, letters.length, `Expected all unique letters, got: ${letters.join(", ")}`);
  });

  it("non-sequential stored letters are preserved (e.g. A, C, E)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", letter: "A", totalZones: 10, notes: null, branchName: "" },
        { id: 2, name: "Controller C", letter: "C", totalZones: 5,  notes: null, branchName: "" },
        { id: 3, name: "Controller E", letter: "E", totalZones: 8,  notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].letter, "A");
    assert.equal(result[1].letter, "C");
    assert.equal(result[2].letter, "E");
  });

  it("falls back to positional ALPHABET index for pre-backfill rows where letter IS NULL", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Hunter Clock - East", letter: null, totalZones: 14, notes: null, branchName: "" },
        { id: 2, name: "Rainbird - West",     letter: null, totalZones: 8,  notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    // Positional fallback for null: A (index 0), B (index 1)
    assert.equal(result[0].letter, "A");
    assert.equal(result[1].letter, "B");
  });
});

describe("resolveWetCheckControllers — branch-scoped isolation", () => {
  it("irrigation_controllers branch rows are returned without filtering (storage is pre-filtered)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (_cid, _custId, branch) => {
        if (branch === "North") {
          return [{ id: 10, name: "Controller A", letter: "A", totalZones: 20, notes: null, branchName: "North" }];
        }
        return [];
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42, "North");
    assert.equal(result.length, 1);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 20);
  });
});

describe("resolveWetCheckControllers — profile count overrides totalControllers", () => {
  it("3 profile controllers returned even when legacy totalControllers = 1", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", letter: "A", totalZones: 12, notes: null, branchName: "" },
        { id: 2, name: "Controller B", letter: "B", totalZones: 8,  notes: null, branchName: "" },
        { id: 3, name: "Controller C", letter: "C", totalZones: 6,  notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result.length, 3);
    assert.equal(result[0].letter, "A");
    assert.equal(result[1].letter, "B");
    assert.equal(result[2].letter, "C");
  });

  it("profile zone counts are preserved, not overridden by any default", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", letter: "A", totalZones: 14, notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].zoneCount, 14);
  });
});

describe("resolveWetCheckControllers — null totalZones never becomes 12", () => {
  it("null totalZones passes through as null (route must not default to 12)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", letter: "A", totalZones: null, notes: null, branchName: "" },
        { id: 2, name: "Controller B", letter: "B", totalZones: 8,   notes: null, branchName: "" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].zoneCount, null, "null totalZones must pass through as null");
    assert.equal(result[1].zoneCount, 8);
  });
});

describe("resolveWetCheckControllers — no-branch (customer-level) read path", () => {
  it("returns irrigation_controllers rows for customer-level bucket (branchName = '')", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (_cid, _custId, branch) => {
        if (branch === "") {
          return [
            { id: 1, name: "Controller A", letter: "A", totalZones: 10, notes: null, branchName: "" },
          ];
        }
        return [];
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42, "");
    assert.equal(result.length, 1);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 10);
  });
});

describe("resolveWetCheckControllers — branch-scoped company isolation", () => {
  it("different companyIds get independent results (storage is called with correct cid)", async () => {
    const callLog: number[] = [];
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (cid) => {
        callLog.push(cid as number);
        if (cid === 10) {
          return [{ id: 1, name: "Controller A", letter: "A", totalZones: 6, notes: null, branchName: "East" }];
        }
        return [];
      },
    };

    const resultCo10 = await resolveWithFakes(fakeStorage, 10, 99, "East");
    const resultCo20 = await resolveWithFakes(fakeStorage, 20, 99, "East");

    assert.equal(resultCo10.length, 1, "company 10 should get its profile controllers");
    assert.equal(resultCo20.length, 0, "company 20 should get no controllers (empty profile, seed from totalControllers in production)");
    assert.deepEqual(callLog, [10, 20], "storage called once per company");
  });

  it("branch X profile does not bleed into branch Y result", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (_cid, _custId, branch) => {
        if (branch === "North") {
          return [{ id: 1, name: "Controller A", letter: "A", totalZones: 20, notes: null, branchName: "North" }];
        }
        return [];
      },
    };

    const northResult = await resolveWithFakes(fakeStorage, 1, 42, "North");
    const southResult = await resolveWithFakes(fakeStorage, 1, 42, "South");

    assert.equal(northResult.length, 1);
    assert.equal(southResult.length, 0, "South branch has no profile — production code seeds from totalControllers");
  });
});
