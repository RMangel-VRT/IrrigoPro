import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsername,
  hasInvisibleCharacters,
  describeUsername,
} from "./normalize-username";

describe("normalizeUsername", () => {
  test("strips the U+202D that locked the bookkeeper out of production", () => {
    // The exact stored value: "3035480337" + LEFT-TO-RIGHT OVERRIDE.
    const stored = "3035480337\u202D";
    assert.equal(stored.length, 11, "precondition: the stored value is 11 chars");
    assert.equal(normalizeUsername(stored), "3035480337");
  });

  test("a typed username and a pasted corrupted one normalise to the same thing", () => {
    // This equality is the whole fix: it is what makes typing the digits work.
    const typed = "3035480337";
    const pasted = "3035480337\u202D";
    assert.notEqual(typed, pasted, "precondition: they differ before normalising");
    assert.equal(normalizeUsername(typed), normalizeUsername(pasted));
  });

  test("removes every invisible format character that survives copy/paste", () => {
    const cases: Array<[string, string]> = [
      ["user\u200B", "zero-width space"],
      ["user\u200C", "zero-width non-joiner"],
      ["user\u200D", "zero-width joiner"],
      ["user\u200E", "left-to-right mark"],
      ["user\u200F", "right-to-left mark"],
      ["user\u202A", "left-to-right embedding"],
      ["user\u202B", "right-to-left embedding"],
      ["user\u202C", "pop directional formatting"],
      ["user\u202D", "left-to-right override"],
      ["user\u202E", "right-to-left override"],
      ["user\u2060", "word joiner"],
      ["user\uFEFF", "byte order mark"],
      ["user\u00AD", "soft hyphen"],
    ];
    for (const [input, label] of cases) {
      assert.equal(normalizeUsername(input), "user", `failed to strip ${label}`);
    }
  });

  test("strips invisible characters wherever they sit, not just at the end", () => {
    assert.equal(normalizeUsername("\u202D3035480337"), "3035480337");
    assert.equal(normalizeUsername("303\u200B548\u200B0337"), "3035480337");
  });

  test("trims surrounding whitespace, including a pasted no-break space", () => {
    assert.equal(normalizeUsername("  bmangel  "), "bmangel");
    assert.equal(normalizeUsername("\u00A0bmangel\u00A0"), "bmangel");
    assert.equal(normalizeUsername("\tbmangel\n"), "bmangel");
  });

  test("folds full-width digits onto ASCII so a phone keyboard cannot fork an account", () => {
    assert.equal(normalizeUsername("７２０４１２５２５０"), "7204125250");
  });

  test("leaves already-clean usernames exactly as they are", () => {
    for (const clean of [
      "superadmin",
      "bmangel",
      "bkrisher",
      "7204125250",
      "randy@highplainsprop.com",
      "mike@highplainsprop.com",
    ]) {
      assert.equal(normalizeUsername(clean), clean);
    }
  });

  test("preserves case — the SQL lookup is what compares case-insensitively", () => {
    assert.equal(normalizeUsername("BMangel"), "BMangel");
  });

  test("is idempotent", () => {
    const once = normalizeUsername("3035480337\u202D");
    assert.equal(normalizeUsername(once), once);
  });

  test("non-string input yields an empty string, never a coincidental match", () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      assert.equal(normalizeUsername(bad), "");
    }
  });

  test("an all-invisible username collapses to empty rather than matching anything", () => {
    assert.equal(normalizeUsername("\u202D\u200B"), "");
  });
});

describe("hasInvisibleCharacters", () => {
  test("flags the corrupted production value and clears the clean ones", () => {
    assert.equal(hasInvisibleCharacters("3035480337\u202D"), true);
    assert.equal(hasInvisibleCharacters("3035480337"), false);
    assert.equal(hasInvisibleCharacters("bmangel"), false);
  });

  test("flags stray whitespace too, since it breaks lookup the same way", () => {
    assert.equal(hasInvisibleCharacters(" bmangel"), true);
  });

  test("is false for non-strings", () => {
    assert.equal(hasInvisibleCharacters(null), false);
  });
});

describe("describeUsername", () => {
  test("makes the invisible character visible for logs and admin screens", () => {
    assert.equal(describeUsername("3035480337\u202D"), "3035480337<U+202D>");
  });

  test("leaves a clean username untouched", () => {
    assert.equal(describeUsername("bmangel"), "bmangel");
  });
});
