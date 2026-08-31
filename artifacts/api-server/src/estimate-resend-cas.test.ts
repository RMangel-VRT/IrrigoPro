/**
 * estimate-resend-cas.test.ts
 *
 * Task #1955 — expiry is a read-time view, so an expired estimate is
 * *persisted* as an ordinary sent row (internalStatus='sent_to_customer',
 * lifecycle='sent', status='pending') whose 30-day window has simply
 * lapsed. `status` only becomes 'expired' in the database if a customer
 * happens to click the dead approval link first.
 *
 * The resend path's conditional UPDATE therefore cannot gate on
 * status='expired': in the normal case it would match zero rows *after*
 * the email had already gone out, leaving the customer holding a token
 * that was never persisted and the manager looking at a 409.
 *
 * These tests hit the real database (like the other estimate storage
 * integration tests) and assert that a resend of a derived-expired row
 * persists the new token and send time — restarting the window — while
 * still rejecting a concurrent second writer.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { companies, db, estimates } from "@workspace/db";
import type { EstimateWithItems } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeLifecycleStatus, ESTIMATE_EXPIRATION_DAYS } from "@workspace/shared";

import { storage } from "./storage";
import {
  registerEstimateRoutes,
  type EstimateRoutesStorage,
} from "./routes/estimate-routes";

const SEED_PROJECT_NAME = "TASK-1955-RESEND-CAS-TEST";

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function cleanupSeed(): Promise<void> {
  await db.delete(estimates).where(eq(estimates.projectName, SEED_PROJECT_NAME));
}

// `estimates.company_id` is a FK, so borrow whatever company the
// environment happens to have rather than assuming an id.
let seedCompanyId: number | null = null;
async function resolveCompanyId(): Promise<number> {
  if (seedCompanyId !== null) return seedCompanyId;
  const [row] = await db.select({ id: companies.id }).from(companies).limit(1);
  if (!row) throw new Error("no company row available to attach the fixture to");
  seedCompanyId = row.id;
  return seedCompanyId;
}

/**
 * Seed a row exactly the way a sent-then-lapsed estimate looks on disk:
 * sent to the customer, lifecycle='sent', status untouched at 'pending',
 * and a send timestamp older than the expiry window.
 */
async function seedLapsedSentEstimate(overrides: {
  status?: string;
  approvalToken?: string | null;
} = {}) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const [row] = await db
    .insert(estimates)
    .values({
      estimateNumber: `EST-TEST-1955-${stamp}`,
      companyId: await resolveCompanyId(),
      customerName: "Test Customer 1955",
      customerEmail: "test1955@example.com",
      projectName: SEED_PROJECT_NAME,
      laborRate: "75.00",
      laborMode: "flat",
      totalLaborHours: "0.00",
      partsSubtotal: "0.00",
      laborSubtotal: "0.00",
      totalAmount: "0.00",
      status: overrides.status ?? "pending",
      internalStatus: "sent_to_customer",
      lifecycle: "sent",
      estimateDate: daysAgo(60),
      approvalSentAt: daysAgo(ESTIMATE_EXPIRATION_DAYS + 10),
      approvalToken:
        overrides.approvalToken === undefined
          ? `old-token-${stamp}`
          : overrides.approvalToken,
      tokenExpiresAt: daysAgo(10),
    })
    .returning();
  return row;
}

// A minimal mount of the real estimate routes so the customer-facing
// token endpoint can be exercised over HTTP. Only the read paths are
// used here; the send flow is driven through storage directly.
const noAuth: RequestHandler = (req: any, _res, next) => {
  req.authenticatedUserRole = "super_admin";
  next();
};

function makeReadOnlyStorage(): EstimateRoutesStorage {
  return {
    async getCustomer() {
      return undefined;
    },
    async getEstimate(id: number) {
      const [row] = await db
        .select()
        .from(estimates)
        .where(eq(estimates.id, id))
        .limit(1);
      return row as unknown as EstimateWithItems | undefined;
    },
    async getEstimates() {
      return (await db.select().from(estimates)) as unknown as EstimateWithItems[];
    },
    async createEstimateFromPayload() {
      throw new Error("not used in this test");
    },
    async updateEstimateWithItems() {
      throw new Error("not used in this test");
    },
  } as unknown as EstimateRoutesStorage;
}

let publicServer: Server;
let publicBaseUrl: string;

describe("resend of a derived-expired estimate (Task #1955)", () => {
  before(async () => {
    await cleanupSeed();
    const app = express();
    app.use(express.json());
    registerEstimateRoutes(app, makeReadOnlyStorage(), noAuth);
    publicServer = createServer(app);
    await new Promise<void>((resolve) => publicServer.listen(0, resolve));
    publicBaseUrl = `http://127.0.0.1:${(publicServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      publicServer.close((err) => (err ? reject(err) : resolve())),
    );
    await cleanupSeed();
  });

  it("reads as expired while the persisted status stays 'pending'", async () => {
    const seeded = await seedLapsedSentEstimate();
    assert.equal(seeded.status, "pending");
    assert.equal(computeLifecycleStatus(seeded), "expired");
  });

  it("persists the new token and send time, restarting the window", async () => {
    const seeded = await seedLapsedSentEstimate();
    const sentAt = new Date();
    const tokenExpiresAt = new Date(sentAt);
    tokenExpiresAt.setDate(tokenExpiresAt.getDate() + ESTIMATE_EXPIRATION_DAYS);

    const persisted = await storage.markEstimateSentToCustomer(seeded.id, {
      approvalToken: "fresh-token-1955",
      tokenExpiresAt,
      approvalSentAt: sentAt,
      newEstimateDate: sentAt,
      isResend: true,
      previousApprovalToken: seeded.approvalToken,
    });

    assert.ok(
      persisted,
      "resend must persist — gating on status='expired' would have matched zero rows here",
    );

    const [row] = await db
      .select()
      .from(estimates)
      .where(eq(estimates.id, seeded.id));
    assert.equal(row.approvalToken, "fresh-token-1955");
    assert.ok(
      row.approvalSentAt && row.approvalSentAt.getTime() >= sentAt.getTime() - 1000,
      "send time must be re-stamped",
    );
    assert.equal(row.internalStatus, "sent_to_customer");
    assert.equal(row.lifecycle, "sent");
    // The customer's link and the estimate now agree on a live window.
    assert.equal(computeLifecycleStatus(row), "sent");
    assert.ok(
      row.tokenExpiresAt && row.tokenExpiresAt.getTime() > Date.now(),
      "the approval link must be usable",
    );
  });

  it("gives the customer a usable link again after they hit the dead one", async () => {
    // A customer who clicked the expired link persists status='expired',
    // and every public token endpoint reads a non-pending status as
    // "already responded" — so a resend must hand the window back.
    const seeded = await seedLapsedSentEstimate({ status: "expired" });
    const sentAt = new Date();
    const persisted = await storage.markEstimateSentToCustomer(seeded.id, {
      approvalToken: "fresh-token-1955-b",
      tokenExpiresAt: new Date(sentAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      approvalSentAt: sentAt,
      newEstimateDate: sentAt,
      isResend: true,
      previousApprovalToken: seeded.approvalToken,
    });
    assert.ok(persisted, "the legacy status='expired' shape must keep working");

    const [row] = await db
      .select()
      .from(estimates)
      .where(eq(estimates.id, seeded.id));
    assert.equal(row.approvalToken, "fresh-token-1955-b");
    assert.equal(computeLifecycleStatus(row), "sent");
    assert.equal(
      row.status,
      "pending",
      "customer-facing status must be renewed, or the new token is refused",
    );

    // Prove it end-to-end through the public token endpoint the emailed
    // link lands on.
    const res = await fetch(
      `${publicBaseUrl}/api/estimates/view-by-token/fresh-token-1955-b`,
    );
    assert.equal(res.status, 200, `view-by-token returned ${res.status}`);
    const body = (await res.json()) as { alreadyResponded: boolean; status: string };
    assert.equal(
      body.alreadyResponded,
      false,
      "the resent link must open the approval page, not 'already responded'",
    );
    assert.equal(body.status, "pending");
  });

  it("rejects a second concurrent resend instead of stamping twice", async () => {
    const seeded = await seedLapsedSentEstimate();
    const sentAt = new Date();
    const args = {
      tokenExpiresAt: new Date(sentAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      approvalSentAt: sentAt,
      newEstimateDate: sentAt,
      isResend: true as const,
      // Both writers read the same row, so both carry the same CAS value.
      previousApprovalToken: seeded.approvalToken,
    };

    const winner = await storage.markEstimateSentToCustomer(seeded.id, {
      ...args,
      approvalToken: "winner-token-1955",
    });
    const loser = await storage.markEstimateSentToCustomer(seeded.id, {
      ...args,
      approvalToken: "loser-token-1955",
    });

    assert.ok(winner, "the first writer should win");
    assert.equal(loser, undefined, "the second writer must see a conflict");

    const [row] = await db
      .select()
      .from(estimates)
      .where(eq(estimates.id, seeded.id));
    assert.equal(row.approvalToken, "winner-token-1955");
  });
});
