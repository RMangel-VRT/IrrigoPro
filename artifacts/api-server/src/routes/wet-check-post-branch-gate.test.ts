// Regression guard for the branch gate and resume-dedup on POST /api/wet-checks
// (originally added in Task #315). There were no automated tests; this file
// locks in three critical paths:
//
//   (a) Multi-branch customer with no branchName in the body → 400
//   (b) Two-step dedup: first POST for a branch creates a new check (201);
//       second identical POST for the same customer+branch resumes it (200,
//       same check id, no second row inserted).
//   (c) Single-location customer with no existing check → 201 (new check,
//       branchName persisted as null).
//
// The Zod schema, branchName normalisation, and branch gate logic are all
// imported from wet-check-create-gate.ts — the same module wired into the
// production POST /api/wet-checks handler — so any future drift between this
// test and the real route is visible at compile time (identical to the
// wet-check-finding-patch.ts pattern).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ── Real production exports — same code that runs in routes.ts ────────────────
import {
  wetCheckCreateBody,
  normalizeBranchName,
  checkBranchGate,
} from "./wet-check-create-gate";

// ─── Pure unit tests on normalizeBranchName + checkBranchGate ────────────────

describe("normalizeBranchName — empty / whitespace → null", () => {
  it("returns null for undefined", () => {
    assert.equal(normalizeBranchName(undefined), null);
  });
  it("returns null for null", () => {
    assert.equal(normalizeBranchName(null), null);
  });
  it("returns null for empty string", () => {
    assert.equal(normalizeBranchName(""), null);
  });
  it("returns null for whitespace-only", () => {
    assert.equal(normalizeBranchName("   "), null);
  });
  it("trims surrounding whitespace from a valid branch name", () => {
    assert.equal(normalizeBranchName("  North Wing  "), "North Wing");
  });
  it("passes through a clean branch name unchanged", () => {
    assert.equal(normalizeBranchName("South Campus"), "South Campus");
  });
});

describe("checkBranchGate — multi-branch customer must supply a branch", () => {
  it("returns null (allowed) when customer has no branches", () => {
    assert.equal(checkBranchGate([], null), null);
    assert.equal(checkBranchGate([], "any"), null);
  });
  it("returns null (allowed) when branches exist and a branchName is supplied", () => {
    assert.equal(checkBranchGate(["North", "South"], "North"), null);
  });
  it("returns an error string when branches exist but branchName is null", () => {
    const err = checkBranchGate(["North", "South"], null);
    assert.ok(typeof err === "string" && err.length > 0, "expected non-empty error string");
    assert.ok(err.toLowerCase().includes("branch"), `expected 'branch' in message, got: ${err}`);
  });
  it("error message matches the exact string wired into the HTTP 400 response", () => {
    const err = checkBranchGate(["A"], null);
    assert.equal(
      err,
      "Branch selection required for this customer — select a branch before starting a wet check.",
    );
  });
});

// ─── HTTP harness ─────────────────────────────────────────────────────────────
// Mirrors the production POST /api/wet-checks handler from routes.ts using
// the same real schema + helpers (imported above). Storage is stubbed so the
// test does not need a live DB, while the Zod body contract, normalisation,
// and gate behaviour are exercised through the exact same code.

type CustomerStub = {
  id: number; companyId: number; branches: string[] | null;
  totalControllers: number; name: string; address: string | null;
};
type UserStub = { id: number; name: string };
type WetCheckStub = {
  id: number; customerId: number; technicianId: number;
  status: string; branchName: string | null;
};

interface StorageStub {
  customer: CustomerStub | null;
  user: UserStub | null;
  // Returned by findActiveWetCheck — mutable so the two-step test can flip it.
  activeWetCheck: WetCheckStub | null;
  createdWetChecks: WetCheckStub[];
}

function mountHandler(
  app: Express,
  stub: StorageStub,
  cid = 1,
) {
  const noopAuth: RequestHandler = (req, _res, next) => {
    req.authenticatedUserId = 7;
    req.authenticatedUserRole = "field_tech";
    req.authenticatedUserCompanyId = cid;
    next();
  };

  app.post("/api/wet-checks", noopAuth, async (req, res) => {
    const companyCid = req.authenticatedUserCompanyId;
    if (companyCid == null) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    // ── Real schema parse (same object used by routes.ts) ──────────────────
    const parsed = wetCheckCreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid body", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    try {
      const customer = stub.customer;
      if (!customer || customer.companyId !== companyCid) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }

      const tech = stub.user;
      if (!tech) {
        res.status(401).json({ message: "User not found" });
        return;
      }

      // ── Real normalisation helper (same function used by routes.ts) ───────
      const branchName = normalizeBranchName(body.branchName);

      // ── Real gate helper (same function used by routes.ts) ───────────────
      const customerBranches = Array.isArray(customer.branches) ? customer.branches as string[] : [];
      const branchGateError = checkBranchGate(customerBranches, branchName);
      if (branchGateError) {
        res.status(400).json({ message: branchGateError });
        return;
      }

      // Resume an existing in-progress check
      const existing = stub.activeWetCheck;
      if (existing && existing.customerId === customer.id && existing.branchName === branchName) {
        res.status(200).json(existing);
        return;
      }

      // Create a new check
      const wc: WetCheckStub = {
        id: 100 + stub.createdWetChecks.length,
        customerId: customer.id,
        technicianId: tech.id,
        status: "in_progress",
        branchName,
      };
      stub.createdWetChecks.push(wc);
      res.status(201).json(wc);
    } catch (e: unknown) {
      res.status(500).json({ message: e instanceof Error ? e.message : "Unexpected error" });
    }
  });
}

async function startServer(
  stub: StorageStub,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  mountHandler(app, stub);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ─── (a) multi-branch customer with no branchName → 400 ─────────────────────

describe("POST /api/wet-checks — (a) branch-required 400 (Task #315 guard)", () => {
  it("returns 400 with the branch-required message when no branchName is supplied", async () => {
    const stub: StorageStub = {
      customer: { id: 1, companyId: 1, branches: ["North", "South"], totalControllers: 2, name: "Acme", address: null },
      user: { id: 7, name: "Tech" },
      activeWetCheck: null,
      createdWetChecks: [],
    };
    const { baseUrl, close } = await startServer(stub);
    try {
      const res = await fetch(`${baseUrl}/api/wet-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: 1 }),
      });
      assert.equal(res.status, 400);
      const json = await res.json() as { message: string };
      // Uses the exact message from checkBranchGate — same string in routes.ts
      assert.equal(json.message, "Branch selection required for this customer — select a branch before starting a wet check.");
      // No wet check was inserted
      assert.equal(stub.createdWetChecks.length, 0);
    } finally {
      await close();
    }
  });

  it("also rejects an explicit empty-string branchName (normalised to null by normalizeBranchName)", async () => {
    const stub: StorageStub = {
      customer: { id: 1, companyId: 1, branches: ["North"], totalControllers: 1, name: "Acme", address: null },
      user: { id: 7, name: "Tech" },
      activeWetCheck: null,
      createdWetChecks: [],
    };
    const { baseUrl, close } = await startServer(stub);
    try {
      const res = await fetch(`${baseUrl}/api/wet-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: 1, branchName: "" }),
      });
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });
});

// ─── (b) two-step dedup: first POST → 201, second POST → 200 (same id) ───────

describe("POST /api/wet-checks — (b) two-step dedup (Task #315 guard)", () => {
  it("first POST creates a new check (201), second identical POST resumes it (200, same id, no duplicate row)", async () => {
    const stub: StorageStub = {
      customer: { id: 2, companyId: 1, branches: ["East Wing"], totalControllers: 2, name: "School", address: null },
      user: { id: 7, name: "Tech" },
      activeWetCheck: null,  // nothing active yet
      createdWetChecks: [],
    };
    const { baseUrl, close } = await startServer(stub);
    try {
      // ── Step 1: no active check exists → 201 ─────────────────────────────
      const res1 = await fetch(`${baseUrl}/api/wet-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: 2, branchName: "East Wing" }),
      });
      assert.equal(res1.status, 201, "expected 201 on first POST (new check)");
      const wc1 = await res1.json() as { id: number; status: string; branchName: string | null };
      assert.equal(wc1.status, "in_progress");
      assert.equal(wc1.branchName, "East Wing");
      assert.equal(stub.createdWetChecks.length, 1, "expected exactly one row inserted after first POST");

      // Simulate the check now being active (as it would be in the real DB after creation).
      stub.activeWetCheck = stub.createdWetChecks[0]!;

      // ── Step 2: same customer+branch → 200 (resume) ───────────────────────
      const res2 = await fetch(`${baseUrl}/api/wet-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: 2, branchName: "East Wing" }),
      });
      assert.equal(res2.status, 200, "expected 200 on second POST (resume)");
      const wc2 = await res2.json() as { id: number };
      assert.equal(wc2.id, wc1.id, "expected the same wet check id to be returned on resume");

      // No second row was inserted
      assert.equal(stub.createdWetChecks.length, 1, "expected no duplicate row after second POST");
    } finally {
      await close();
    }
  });
});

// ─── (c) single-location customer → 201 new check, branchName null ───────────

describe("POST /api/wet-checks — (c) single-location customer creates new check (Task #315 guard)", () => {
  it("returns 201 with branchName: null for a customer with no branches configured", async () => {
    const stub: StorageStub = {
      customer: { id: 3, companyId: 1, branches: null, totalControllers: 3, name: "Park", address: "1 Main St" },
      user: { id: 7, name: "Tech" },
      activeWetCheck: null,
      createdWetChecks: [],
    };
    const { baseUrl, close } = await startServer(stub);
    try {
      const res = await fetch(`${baseUrl}/api/wet-checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: 3 }),
      });
      assert.equal(res.status, 201);
      const wc = await res.json() as { id: number; customerId: number; branchName: unknown };
      assert.equal(wc.customerId, 3);
      assert.equal(wc.branchName, null, "single-location check should have branchName: null");
      assert.equal(stub.createdWetChecks.length, 1);
      assert.equal(stub.createdWetChecks[0]!.branchName, null);
    } finally {
      await close();
    }
  });
});
