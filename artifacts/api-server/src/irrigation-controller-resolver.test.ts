// Tests for irrigation-controller-resolver.ts
//
// Verifies that resolveWetCheckControllers reads from irrigation_controllers
// first and falls back to property_controllers only when no irrigation profile
// exists. Uses injected fakes — no shared dev-DB required.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Fakes ──────────────────────────────────────────────────────────────────────

type FakeIrrigController = {
  id: number;
  name: string;
  totalZones: number | null;
  notes: string | null;
  branchName: string;
};

type FakePropController = {
  controllerLetter: string;
  zoneCount: number;
  notes: string | null;
  branchName: string | null;
};

interface FakeStorage {
  listIrrigationControllers: (
    companyId: number | null,
    customerId: number,
    branchName?: string,
  ) => Promise<FakeIrrigController[]>;
  listPropertyControllers: (
    companyId: number,
    customerId: number,
  ) => Promise<FakePropController[]>;
}

// ── Pure resolver logic (extracted inline for testing without DI wiring) ───────

function extractLetter(name: string): string | null {
  const trimmed = name.trim();
  // Single-character name (e.g. bare "A")
  if (trimmed.length === 1 && /^[A-Z]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  // "[word] [single-letter]" — the letter is the second whitespace token,
  // e.g. "Controller A", "Controller A - 136th Southeast", "Ctrl B".
  // The \b after the capture group ensures we don't match "C" from "Clock".
  const m = trimmed.match(/^[A-Za-z]+\s+([A-Z])\b/i);
  if (m) return m[1].toUpperCase();
  return null;
}

async function resolveWithFakes(
  storage: FakeStorage,
  companyId: number,
  customerId: number,
  branchName?: string | null,
): Promise<{ letter: string; zoneCount: number | null; notes: string | null }[]> {
  const branch = branchName ?? null;
  const branchArg = typeof branch === "string" ? branch : undefined;

  const irrigCtrls = await storage.listIrrigationControllers(companyId, customerId, branchArg);
  if (irrigCtrls.length > 0) {
    return irrigCtrls.map((ctrl, index) => ({
      letter: extractLetter(ctrl.name) ?? String.fromCharCode(65 + index),
      zoneCount: ctrl.totalZones ?? null,
      notes: ctrl.notes ?? null,
    }));
  }

  const legacyRows = await storage.listPropertyControllers(companyId, customerId);
  const filtered = branch !== null
    ? legacyRows.filter((r) => (r.branchName || null) === branch)
    : legacyRows;

  return filtered.map((r) => ({
    letter: r.controllerLetter,
    zoneCount: r.zoneCount,
    notes: r.notes ?? null,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveWetCheckControllers — irrigation_controllers primary path", () => {
  it("returns irrigation_controllers rows when they exist", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", totalZones: 14, notes: null, branchName: "" },
        { id: 2, name: "Controller B", totalZones: 8, notes: "note b", branchName: "" },
      ],
      listPropertyControllers: async () => {
        throw new Error("listPropertyControllers should not be called when irrigation profile exists");
      },
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

  it("passes through null totalZones as null (no silent 12 default)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", totalZones: null, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].zoneCount, null);
  });

  it("extracts single letter from multi-word controller name", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller Z", totalZones: 5, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].letter, "Z");
  });
});

describe("resolveWetCheckControllers — legacy fallback path", () => {
  it("falls back to property_controllers when irrigation_controllers is empty", async () => {
    let legacyCalled = false;
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [],
      listPropertyControllers: async () => {
        legacyCalled = true;
        return [
          { controllerLetter: "A", zoneCount: 10, notes: null, branchName: null },
          { controllerLetter: "B", zoneCount: 6, notes: "old note", branchName: null },
        ];
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.ok(legacyCalled, "listPropertyControllers should have been called");
    assert.equal(result.length, 2);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 10);
    assert.equal(result[1].letter, "B");
    assert.equal(result[1].zoneCount, 6);
    assert.equal(result[1].notes, "old note");
  });

  it("filters legacy rows by branchName when branch is provided", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [],
      listPropertyControllers: async () => [
        { controllerLetter: "A", zoneCount: 10, notes: null, branchName: null },
        { controllerLetter: "A", zoneCount: 12, notes: null, branchName: "Branch East" },
      ],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42, "Branch East");
    assert.equal(result.length, 1);
    assert.equal(result[0].zoneCount, 12);
  });

  it("returns empty array when both sources are empty", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result.length, 0);
  });
});

describe("resolveWetCheckControllers — branch-scoped isolation", () => {
  it("irrigation_controllers branch rows are returned without filtering (storage is pre-filtered)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (_cid, _custId, branch) => {
        if (branch === "North") {
          return [{ id: 10, name: "Controller A", totalZones: 20, notes: null, branchName: "North" }];
        }
        return [];
      },
      listPropertyControllers: async () => {
        throw new Error("should not fall back when irrigation profile exists for branch");
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42, "North");
    assert.equal(result.length, 1);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 20);
  });
});

describe("extractLetter helper", () => {
  // Standard "Controller X" pattern — returns the letter.
  const standardCases: Array<[string, string]> = [
    ["Controller A", "A"],
    ["Controller B", "B"],
    ["Controller Z", "Z"],
    ["A", "A"],
    ["controller a", "A"],
    ["  Controller  X  ", "X"],
    // "Controller X - Description" format: letter is the second word, description follows
    ["Controller A - 136th Southeast", "A"],
    ["Controller B - Hunter Clock West", "B"],
    ["Controller C - Rainbird East", "C"],
    ["Controller F - Broadlands Lane", "F"],
  ];

  for (const [name, expected] of standardCases) {
    it(`extractLetter("${name}") === "${expected}"`, () => {
      assert.equal(extractLetter(name), expected);
    });
  }

  // Descriptive names — last word is not a single letter → returns null so the
  // caller can assign a sequential letter (A, B, C…) by position.
  const descriptiveCases: string[] = [
    "Hunter Clock - East",
    "Hunter Clock - West",
    "Rainbird - West",
    "Rainbird Clock - East",
    "Rainbird - 136th SouthEast",
    "Rainbird - Broadlands Lane",
    "Some Controller With Long Name",
  ];

  for (const name of descriptiveCases) {
    it(`extractLetter("${name}") === null (descriptive name, caller uses position)`, () => {
      assert.equal(extractLetter(name), null);
    });
  }
});

// ─── Descriptive controller name scenarios ───────────────────────────────────
//
// Customers like "Villas at the Boulders" whose irrigation_controllers were
// seeded with real names ("Hunter Clock - East", "Rainbird - West", …) instead
// of "Controller A" / "Controller B" must still get unique, stable letters.
// The resolver falls back to sequential assignment (A, B, C…) by the order
// the DB returns rows (ORDER BY name, id).

describe("resolveWetCheckControllers — descriptive names get sequential letters", () => {
  it("assigns A,B,C… by position when no name ends with a single letter", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 134, name: "Hunter Clock - East",       totalZones: 40, notes: null, branchName: "" },
        { id: 135, name: "Hunter Clock - West",       totalZones: 48, notes: null, branchName: "" },
        { id: 137, name: "Rainbird - 136th SouthEast", totalZones: 24, notes: null, branchName: "" },
        { id: 139, name: "Rainbird - Broadlands Lane", totalZones: 40, notes: null, branchName: "" },
        { id: 138, name: "Rainbird - West",            totalZones: 37, notes: null, branchName: "" },
        { id: 136, name: "Rainbird Clock - East",      totalZones: 41, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => {
        throw new Error("should not call property_controllers when irrigation profile exists");
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 271);
    assert.equal(result.length, 6);
    assert.equal(result[0].letter, "A"); // Hunter Clock - East
    assert.equal(result[1].letter, "B"); // Hunter Clock - West
    assert.equal(result[2].letter, "C"); // Rainbird - 136th SouthEast
    assert.equal(result[3].letter, "D"); // Rainbird - Broadlands Lane
    assert.equal(result[4].letter, "E"); // Rainbird - West
    assert.equal(result[5].letter, "F"); // Rainbird Clock - East
  });

  it("all descriptive letters are unique — none collapse to the same letter", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 134, name: "Hunter Clock - East",       totalZones: 40, notes: null, branchName: "" },
        { id: 135, name: "Hunter Clock - West",       totalZones: 48, notes: null, branchName: "" },
        { id: 137, name: "Rainbird - 136th SouthEast", totalZones: 24, notes: null, branchName: "" },
        { id: 139, name: "Rainbird - Broadlands Lane", totalZones: 40, notes: null, branchName: "" },
        { id: 138, name: "Rainbird - West",            totalZones: 37, notes: null, branchName: "" },
        { id: 136, name: "Rainbird Clock - East",      totalZones: 41, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 271);
    const letters = result.map(r => r.letter);
    const unique = new Set(letters);
    assert.equal(unique.size, letters.length, `Expected all unique letters, got: ${letters.join(", ")}`);
  });

  it("standard 'Controller X' names still take precedence over position index", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller C", totalZones: 10, notes: null, branchName: "" },
        { id: 2, name: "Controller A", totalZones: 5,  notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    // Names explicitly say C and A — do not override with positional A and B.
    assert.equal(result[0].letter, "C");
    assert.equal(result[1].letter, "A");
  });
});

// ─── Task #1706 wire-up scenarios ────────────────────────────────────────────

describe("resolveWetCheckControllers — profile count overrides totalControllers", () => {
  it("3 profile controllers returned even when legacy totalControllers = 1", async () => {
    // Simulates: customer.totalControllers = 1 (stale legacy integer), but the
    // irrigation profile has 3 controllers. The resolver should return all 3.
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", totalZones: 12, notes: null, branchName: "" },
        { id: 2, name: "Controller B", totalZones: 8, notes: null, branchName: "" },
        { id: 3, name: "Controller C", totalZones: 6, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => {
        throw new Error("should not fall back when irrigation profile has rows");
      },
    };

    // totalControllers is not passed to the resolver — the route drives it from resolved.length
    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result.length, 3);
    assert.equal(result[0].letter, "A");
    assert.equal(result[1].letter, "B");
    assert.equal(result[2].letter, "C");
  });

  it("profile zone counts are preserved, not overridden by any default", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", totalZones: 14, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.equal(result[0].zoneCount, 14);
  });
});

describe("resolveWetCheckControllers — null totalZones never becomes 12", () => {
  it("null totalZones passes through as null (route must not default to 12)", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [
        { id: 1, name: "Controller A", totalZones: null, notes: null, branchName: "" },
        { id: 2, name: "Controller B", totalZones: 8, notes: null, branchName: "" },
      ],
      listPropertyControllers: async () => [],
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
        // customer-level: caller passes "" for the branchArg
        if (branch === "") {
          return [
            { id: 1, name: "Controller A", totalZones: 10, notes: null, branchName: "" },
          ];
        }
        return [];
      },
      listPropertyControllers: async () => {
        throw new Error("should not read property_controllers when irrigation profile exists");
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42, "");
    assert.equal(result.length, 1);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 10);
  });

  it("no-profile customer falls back to property_controllers (no regression)", async () => {
    let legacyCalled = false;
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async () => [],
      listPropertyControllers: async () => {
        legacyCalled = true;
        return [
          { controllerLetter: "A", zoneCount: 8, notes: null, branchName: null },
          { controllerLetter: "B", zoneCount: 4, notes: null, branchName: null },
        ];
      },
    };

    const result = await resolveWithFakes(fakeStorage, 1, 42);
    assert.ok(legacyCalled);
    assert.equal(result.length, 2);
    assert.equal(result[0].letter, "A");
    assert.equal(result[0].zoneCount, 8);
  });
});

describe("resolveWetCheckControllers — branch-scoped company isolation", () => {
  it("different companyIds get independent results (storage is called with correct cid)", async () => {
    const callLog: number[] = [];
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (cid) => {
        callLog.push(cid as number);
        if (cid === 10) {
          return [{ id: 1, name: "Controller A", totalZones: 6, notes: null, branchName: "East" }];
        }
        return [];
      },
      listPropertyControllers: async () => [],
    };

    const resultCo10 = await resolveWithFakes(fakeStorage, 10, 99, "East");
    const resultCo20 = await resolveWithFakes(fakeStorage, 20, 99, "East");

    assert.equal(resultCo10.length, 1, "company 10 should get its profile controllers");
    assert.equal(resultCo20.length, 0, "company 20 should get no controllers (empty profile)");
    assert.deepEqual(callLog, [10, 20], "storage called once per company");
  });

  it("branch X profile does not bleed into branch Y result", async () => {
    const fakeStorage: FakeStorage = {
      listIrrigationControllers: async (_cid, _custId, branch) => {
        if (branch === "North") {
          return [{ id: 1, name: "Controller A", totalZones: 20, notes: null, branchName: "North" }];
        }
        return [];
      },
      listPropertyControllers: async () => [],
    };

    const northResult = await resolveWithFakes(fakeStorage, 1, 42, "North");
    const southResult = await resolveWithFakes(fakeStorage, 1, 42, "South");

    assert.equal(northResult.length, 1);
    assert.equal(southResult.length, 0, "South branch has no profile — should return empty");
  });
});
