// Tests for the pure planning half of the username repair migration.
// `planRepair` decides which rows get rewritten and which are too ambiguous to
// touch — that decision is where the risk lives, so it is tested directly
// rather than through the database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planRepair } from "./normalize-usernames";

describe("planRepair", () => {
  it("finds the production bookkeeper row and leaves the clean rows alone", () => {
    // The real production table shape at the time of the incident.
    const rows = [
      { id: 6, username: "superadmin" },
      { id: 11, username: "randy@highplainsprop.com" },
      { id: 15, username: "bmangel" },
      { id: 17, username: "mike@highplainsprop.com" },
      { id: 18, username: "bkrisher" },
      { id: 20, username: "7204125250" },
      { id: 21, username: "7205011702" },
      { id: 22, username: "7202529865" },
      { id: 23, username: "3035480337\u202D" },
    ];

    const { repairable, colliding } = planRepair(rows);

    assert.equal(colliding.length, 0);
    assert.equal(repairable.length, 1, "exactly one row is corrupted");
    assert.equal(repairable[0].id, 23);
    assert.equal(repairable[0].stored, "3035480337\u202D");
    assert.equal(repairable[0].normalized, "3035480337");
    assert.equal(repairable[0].display, "3035480337<U+202D>");
  });

  it("returns nothing to do once the repair has been applied", () => {
    const rows = [
      { id: 15, username: "bmangel" },
      { id: 23, username: "3035480337" },
    ];
    const { repairable, colliding } = planRepair(rows);
    assert.equal(repairable.length, 0);
    assert.equal(colliding.length, 0);
  });

  it("is idempotent — re-planning after a repair finds nothing", () => {
    const before = [{ id: 23, username: "3035480337\u202D" }];
    const { repairable } = planRepair(before);
    const after = [{ id: 23, username: repairable[0].normalized }];
    assert.equal(planRepair(after).repairable.length, 0);
  });

  it("refuses to rewrite a row when the clean name is already taken", () => {
    // Rewriting #2 would produce two accounts that login cannot tell apart.
    const rows = [
      { id: 1, username: "bob" },
      { id: 2, username: "bob\u200B" },
    ];
    const { repairable, colliding } = planRepair(rows);
    assert.equal(repairable.length, 0, "must not rewrite into a collision");
    assert.equal(colliding.length, 1);
    assert.equal(colliding[0].id, 2);
  });

  it("treats a case-only difference as a collision, because login is case-insensitive", () => {
    const rows = [
      { id: 1, username: "Bob" },
      { id: 2, username: "bob\u200B" },
    ];
    const { repairable, colliding } = planRepair(rows);
    assert.equal(repairable.length, 0);
    assert.equal(colliding.length, 1);
    assert.equal(colliding[0].id, 2);
  });

  it("refuses to write an empty username", () => {
    const rows = [{ id: 9, username: "\u202D\u200B" }];
    const { repairable, colliding } = planRepair(rows);
    assert.equal(repairable.length, 0);
    assert.equal(colliding.length, 1);
    assert.equal(colliding[0].normalized, "");
  });

  it("repairs several independent rows in one pass", () => {
    const rows = [
      { id: 1, username: "alice\u200B" },
      { id: 2, username: " bob " },
      { id: 3, username: "carol" },
    ];
    const { repairable, colliding } = planRepair(rows);
    assert.equal(colliding.length, 0);
    assert.deepEqual(
      repairable.map((r) => [r.id, r.normalized]),
      [
        [1, "alice"],
        [2, "bob"],
      ],
    );
  });

  it("handles an empty table", () => {
    const { repairable, colliding } = planRepair([]);
    assert.equal(repairable.length, 0);
    assert.equal(colliding.length, 0);
  });
});
