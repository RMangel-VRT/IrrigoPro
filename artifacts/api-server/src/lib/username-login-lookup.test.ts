// The login lookup, against a real database row that carries invisible Unicode.
//
// This is the production incident reproduced end to end. A bookkeeper's stored
// username was "3035480337" + U+202D. Because login resolves an account BY
// username, the row matched only when the username was pasted (carrying the
// hidden character) and never when it was typed — which looked like a password
// that worked for one person and not another.
//
// The matrix below is the whole point of the fix, and the reason the deploy is
// safe to ship before the repair migration runs:
//
//                       | typed "3035480337" | pasted "3035480337\u202D"
//   ---------------------+--------------------+--------------------------
//   corrupt row (before) | no match           | MATCHES  ← access preserved
//   repaired row (after) | MATCHES            | MATCHES
//
// The bottom-left cell is what the migration buys. The top-right cell is what
// must not regress on the way there: normalising only the request would have
// locked out the one person who could still get in.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { planRepair } from "./migrations/normalize-usernames";

const LRO = "\u202D"; // LEFT-TO-RIGHT OVERRIDE — the exact production character
const TYPED = `zz-login-fixture-${process.pid}-3035480337`;
const PASTED = `${TYPED}${LRO}`;

let userId: number;

async function setStoredUsername(value: string) {
  await db.execute(sql`UPDATE users SET username = ${value} WHERE id = ${userId}`);
}

before(async () => {
  // Seeded deliberately corrupt, exactly as production was found.
  const res: any = await db.execute(sql`
    INSERT INTO users (username, password, name, role, is_active)
    VALUES (${PASTED}, ${"not-a-real-hash"}, ${"Login Fixture"}, ${"field_tech"}, true)
    RETURNING id
  `);
  const rows = res.rows ?? res;
  userId = Number(rows[0].id);
});

after(async () => {
  if (userId) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
});

describe("login lookup while the stored username is still corrupt", () => {
  it("still finds the account when the username is PASTED — nobody loses access on deploy", async () => {
    const user = await storage.getUserByUsername(PASTED);
    assert.ok(user, "pasted login must keep working before the repair runs");
    assert.equal(user!.id, userId);
  });

  it("does not find it when TYPED — this is the breakage the migration exists to fix", async () => {
    const user = await storage.getUserByUsername(TYPED);
    assert.equal(user, undefined);
  });

  it("does not match some other account by accident", async () => {
    const user = await storage.getUserByUsername(`${TYPED}-nobody`);
    assert.equal(user, undefined);
  });
});

describe("login lookup after the repair migration has run", () => {
  before(async () => {
    // Apply the repair exactly as the migration does: plan it, then write the
    // planned value. If this drifted from the migration the test would be
    // asserting against a fiction.
    const rows = (
      await db.execute(sql`SELECT id, username FROM users WHERE id = ${userId}`)
    ) as any;
    const list = (rows.rows ?? rows).map((r: any) => ({
      id: Number(r.id),
      username: String(r.username),
    }));
    const { repairable } = planRepair(list);
    assert.equal(repairable.length, 1, "the fixture row must be seen as repairable");
    await setStoredUsername(repairable[0].normalized);
  });

  it("finds the account when TYPED — the teammate can sign in", async () => {
    const user = await storage.getUserByUsername(TYPED);
    assert.ok(user, "typed login must work once the row is clean");
    assert.equal(user!.id, userId);
  });

  it("still finds it when PASTED — the person who pastes is not broken by the repair", async () => {
    const user = await storage.getUserByUsername(PASTED);
    assert.ok(user, "pasted login must survive the repair");
    assert.equal(user!.id, userId);
  });

  it("is case-insensitive, as it always was", async () => {
    const user = await storage.getUserByUsername(TYPED.toUpperCase());
    assert.ok(user);
    assert.equal(user!.id, userId);
  });

  it("stores the clean value — the username is readable in admin screens again", async () => {
    const rows = (
      await db.execute(sql`SELECT username FROM users WHERE id = ${userId}`)
    ) as any;
    const stored = String((rows.rows ?? rows)[0].username);
    assert.equal(stored, TYPED);
    assert.equal(stored.length, Buffer.byteLength(stored), "no multi-byte leftovers");
  });
});

// The dangerous case: two SEPARATE accounts whose names differ only by an
// invisible character. Cleaning the submitted value before looking it up would
// collapse them, so a paste of "bob<ZWSP>" would resolve to "bob" — handing back
// the wrong person's account, failing their password, and pointing a password
// reset at a stranger's row. Lookup therefore tries the exact value first
// whenever the submission carried something strippable.
describe("two accounts differing only by an invisible character", () => {
  const ZWSP = "\u200B";
  const CLEAN = `zz-collide-fixture-${process.pid}-bob`;
  const DIRTY = `${CLEAN}${ZWSP}`;
  let cleanId: number;
  let dirtyId: number;

  before(async () => {
    const mk = async (username: string, password: string) => {
      const res: any = await db.execute(sql`
        INSERT INTO users (username, password, name, role, is_active)
        VALUES (${username}, ${password}, ${"Collide Fixture"}, ${"field_tech"}, true)
        RETURNING id
      `);
      return Number((res.rows ?? res)[0].id);
    };
    cleanId = await mk(CLEAN, "hash-clean");
    dirtyId = await mk(DIRTY, "hash-dirty");
  });

  after(async () => {
    for (const id of [cleanId, dirtyId]) {
      if (id) await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    }
  });

  it("resolves a pasted name to its OWN account, not the lookalike", async () => {
    const user = await storage.getUserByUsername(DIRTY);
    assert.ok(user);
    assert.equal(user!.id, dirtyId, "pasted login must not be handed the clean account");
  });

  it("resolves the typed name to the clean account", async () => {
    const user = await storage.getUserByUsername(CLEAN);
    assert.ok(user);
    assert.equal(user!.id, cleanId);
  });

  it("aims a password reset at the account that submitted it, and no other", async () => {
    const updated = await storage.updateUserPassword(DIRTY, "reset-dirty-only");
    assert.ok(updated);
    assert.equal(updated!.id, dirtyId);

    const rows = (
      await db.execute(sql`SELECT id, password FROM users WHERE id IN (${cleanId}, ${dirtyId})`)
    ) as any;
    const byId = new Map(
      (rows.rows ?? rows).map((r: any) => [Number(r.id), String(r.password)])
    );
    assert.equal(byId.get(dirtyId), "reset-dirty-only");
    assert.equal(byId.get(cleanId), "hash-clean", "the lookalike account must be untouched");
  });

  it("is refused by the repair migration rather than merged", async () => {
    const { repairable, colliding } = planRepair([
      { id: cleanId, username: CLEAN },
      { id: dirtyId, username: DIRTY },
    ]);
    assert.equal(repairable.length, 0, "must not rewrite one account on top of another");
    assert.deepEqual(colliding.map((c) => c.id), [dirtyId]);
  });
});

describe("updateUserPassword targets exactly one account", () => {
  it("writes to the row login would have found, and returns it", async () => {
    const updated = await storage.updateUserPassword(TYPED, "hash-one");
    assert.ok(updated);
    assert.equal(updated!.id, userId);
    assert.equal(updated!.password, "hash-one");
  });

  it("accepts a pasted username too, and still writes the same single row", async () => {
    const updated = await storage.updateUserPassword(PASTED, "hash-two");
    assert.ok(updated);
    assert.equal(updated!.id, userId);

    const rows = (
      await db.execute(sql`SELECT password FROM users WHERE id = ${userId}`)
    ) as any;
    assert.equal(String((rows.rows ?? rows)[0].password), "hash-two");
  });

  it("reports no account rather than silently writing nothing", async () => {
    const updated = await storage.updateUserPassword(`${TYPED}-nobody`, "hash-three");
    assert.equal(updated, undefined);
  });

  it("refuses a username that is only invisible characters", async () => {
    const updated = await storage.updateUserPassword(LRO, "hash-four");
    assert.equal(updated, undefined);
  });
});
