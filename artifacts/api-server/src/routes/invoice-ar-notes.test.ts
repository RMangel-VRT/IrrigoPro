// Task #1889 — internal append-only A/R notes on invoices.
//
// Everything here runs the REAL guard, the REAL route handlers, the REAL
// visibility strip and the REAL document/email/CSV generators over spies.
// Nothing re-implements authorization or stripping, so a drift shows up as a
// failure rather than as two copies of the same bug agreeing.
//
// Coverage map:
//   (a) CAN_READ_AR_NOTES membership, and the deliberate gap with
//       CAN_READ_INVOICES that irrigation_manager sits in
//   (b) the shared guard across the whole role set
//   (c) read + append happy paths, and the company-scoped resolve that happens
//       BEFORE any note row is touched
//   (d) append-only: no update or delete route exists on either path, by
//       response and by static proof over the module source
//   (e) irrigation_manager refused on both endpoints, and served an invoice
//       list with no note fields at all — absent keys, not zeroed ones
//   (f) multi-tenant: a note in company A is invisible and unreachable from
//       company B, in both directions
//   (g) the three customer-facing surfaces — invoice PDF, every customer email
//       including the reminder templates, and the CSV export — proven against
//       generated output
//
// Membership assertions are preferred to exact row counts throughout: the
// api-server integration tests share one development database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROLES,
  hasCapability,
  CAN_READ_AR_NOTES,
  CAN_READ_INVOICES,
} from "@workspace/shared";
import { requireArNotesAccess } from "./role-guards";
import {
  registerInvoiceArNoteRoutes,
  arNotePreview,
  AR_NOTE_MAX_LENGTH,
} from "./invoice-ar-note-routes";
import { registerInvoiceListRoutes, type InvoiceRowLike } from "./invoice-list-routes";
import { applyArNoteVisibility } from "./ar-note-visibility";
import { requireInvoiceRead } from "./role-guards";

// The three customer-facing generators, imported for group (g).
import { buildPdfViewModel, type InvoiceDetailData } from "../pdf-view-model";
import { coverPage, reconciliationPage, ticketPageWO } from "../pdf-helpers";
import { renderReminderEmail, REMINDER_TEMPLATE_KEYS } from "../invoice-reminder-templates";
import { buildInvoiceDetailEmailBody } from "../email-service";

// ── helpers ──────────────────────────────────────────────────────────────────

const NO_ROLE = Symbol("no-role");
type TestRole = string | typeof NO_ROLE;

const NOW = new Date("2026-08-11T12:00:00.000Z");

function makeAuth(
  role: TestRole,
  companyId: number | null = 1,
  userId = 7,
): RequestHandler {
  return (req: any, _res, next) => {
    if (role !== NO_ROLE) req.authenticatedUserRole = role;
    req.authenticatedUserId = userId;
    req.authenticatedUserCompanyId = companyId;
    next();
  };
}

async function listen(app: Express): Promise<{ url: string; server: Server }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function call(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const { url, server } = await listen(app);
  try {
    const res = await fetch(`${url}${path}`, {
      method: method.toUpperCase(),
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } finally {
    await close(server);
  }
}

/** Mounts the guard in front of a trivial 200 handler and returns the status. */
async function guardStatus(
  guard: RequestHandler,
  role: TestRole,
  { method = "get" } = {},
): Promise<number> {
  const app = express();
  app.use(express.json());
  (app as any)[method]("/probe", makeAuth(role), guard, (_req: any, res: any) =>
    res.status(200).json({ ok: true }),
  );
  const { status } = await call(app, method, "/probe", method === "get" ? undefined : {});
  return status;
}

// ── A tiny in-memory notes store, company-scoped exactly like the real one ───

interface StoredNote {
  id: number;
  companyId: number;
  invoiceId: number;
  authorUserId: number | null;
  authorName: string | null;
  note: string;
  createdAt: Date;
}

interface Spy {
  getInvoiceByIdCalls: Array<[number, number | null]>;
  getInvoiceArNotesCalls: Array<[number, number | null]>;
  createCalls: any[];
}

/**
 * `invoices` is keyed by id and carries its owning companyId, so
 * `getInvoiceById` can enforce the same company scoping the real storage
 * method does — which is what makes the cross-company assertions meaningful.
 */
function buildNotesApp({
  role = "bookkeeper",
  companyId = 1 as number | null,
  userId = 7,
  invoices = new Map<number, { id: number; companyId: number }>([[10, { id: 10, companyId: 1 }]]),
  notes = [] as StoredNote[],
  userName = "Dana Reyes" as string | null,
}: {
  role?: TestRole;
  companyId?: number | null;
  userId?: number;
  invoices?: Map<number, { id: number; companyId: number }>;
  notes?: StoredNote[];
  userName?: string | null;
} = {}): { app: Express; spy: Spy; notes: StoredNote[] } {
  const spy: Spy = { getInvoiceByIdCalls: [], getInvoiceArNotesCalls: [], createCalls: [] };
  let nextId = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;

  const app = express();
  app.use(express.json());
  registerInvoiceArNoteRoutes(app, {
    requireAuthentication: makeAuth(role, companyId, userId),
    requireArNotesAccess,
    _storageApi: {
      async getInvoiceById(id: number, scoped: number | null) {
        spy.getInvoiceByIdCalls.push([id, scoped]);
        const inv = invoices.get(id);
        if (!inv) return undefined;
        if (scoped != null && inv.companyId !== scoped) return undefined;
        return inv;
      },
      async getInvoiceArNotes(invoiceId: number, scoped: number | null) {
        spy.getInvoiceArNotesCalls.push([invoiceId, scoped]);
        return notes.filter(
          (n) => n.invoiceId === invoiceId && (scoped == null || n.companyId === scoped),
        );
      },
      async createInvoiceArNote(row: any) {
        spy.createCalls.push(row);
        const saved: StoredNote = { id: nextId++, createdAt: NOW, ...row };
        notes.push(saved);
        return saved;
      },
      async getUser(id: number) {
        return { id, name: userName };
      },
    },
  });
  return { app, spy, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Capability membership
// ─────────────────────────────────────────────────────────────────────────────

describe("CAN_READ_AR_NOTES — membership", () => {
  it("is exactly the billing side", () => {
    assert.deepEqual(
      ROLES.filter((r) => hasCapability(r, CAN_READ_AR_NOTES)).sort(),
      ["billing_manager", "bookkeeper", "company_admin", "super_admin"],
    );
  });

  it("is narrower than invoice read, and irrigation_manager is the gap", () => {
    // The whole point of the capability. If this ever passes trivially because
    // someone "aligned" the two sets, the ticket's decision has been undone.
    assert.equal(hasCapability("irrigation_manager", CAN_READ_INVOICES), true);
    assert.equal(hasCapability("irrigation_manager", CAN_READ_AR_NOTES), false);

    const notesRoles = ROLES.filter((r) => hasCapability(r, CAN_READ_AR_NOTES));
    for (const r of notesRoles) {
      assert.equal(hasCapability(r, CAN_READ_INVOICES), true, `${r} must also read invoices`);
    }
    assert.ok(
      notesRoles.length < ROLES.filter((r) => hasCapability(r, CAN_READ_INVOICES)).length,
      "CAN_READ_AR_NOTES must remain a strict subset of CAN_READ_INVOICES",
    );
  });

  it("the exclusion is written down next to the set, not just in a ticket", () => {
    // Step 2 of the ticket: a later reader has to find the reasoning where they
    // will be standing when they are tempted to "fix" the mismatch.
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "..", "lib", "shared", "src", "roles.ts"),
      "utf8",
    );
    const decl = src.indexOf("export const CAN_READ_AR_NOTES");
    assert.notEqual(decl, -1, "CAN_READ_AR_NOTES must be declared in the shared registry");
    const comment = src.slice(Math.max(0, decl - 1800), decl);
    assert.match(comment, /irrigation_manager/, "the comment must name the excluded role");
    assert.match(
      comment,
      /CAN_READ_INVOICES/,
      "the comment must say which set it is deliberately narrower than",
    );
  });

  it("is closed by default", () => {
    assert.equal(hasCapability(null, CAN_READ_AR_NOTES), false);
    assert.equal(hasCapability(undefined, CAN_READ_AR_NOTES), false);
    assert.equal(hasCapability("auditor", CAN_READ_AR_NOTES), false);
    assert.equal(hasCapability("BOOKKEEPER", CAN_READ_AR_NOTES), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) The shared guard
// ─────────────────────────────────────────────────────────────────────────────

describe("requireArNotesAccess — the guard both endpoints share", () => {
  const expected: Array<[TestRole, number]> = [
    ["super_admin", 200],
    ["company_admin", 200],
    ["billing_manager", 200],
    ["bookkeeper", 200],
    // Reads invoices, must not read the commentary about the customer.
    ["irrigation_manager", 403],
    ["field_tech", 403],
    ["auditor", 403],
    [NO_ROLE, 403],
  ];

  for (const [role, status] of expected) {
    const label = role === NO_ROLE ? "(no role)" : role;
    it(`${label} → ${status} on read`, async () => {
      assert.equal(await guardStatus(requireArNotesAccess, role), status);
    });
    it(`${label} → ${status} on append`, async () => {
      assert.equal(await guardStatus(requireArNotesAccess, role, { method: "post" }), status);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Read and append
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/invoices/:id/ar-notes", () => {
  it("returns the thread, attributed and timestamped", async () => {
    const { app } = buildNotesApp({
      notes: [
        {
          id: 1,
          companyId: 1,
          invoiceId: 10,
          authorUserId: 7,
          authorName: "Dana Reyes",
          note: "Left a voicemail for AP.",
          createdAt: NOW,
        },
      ],
    });
    const { status, body } = await call(app, "get", "/api/invoices/10/ar-notes");
    assert.equal(status, 200);
    assert.equal(body.notes.length, 1);
    assert.equal(body.notes[0].note, "Left a voicemail for AP.");
    assert.equal(body.notes[0].authorName, "Dana Reyes");
    assert.equal(body.notes[0].createdAt, NOW.toISOString());
    assert.equal(body.internalOnly, true);
  });

  it("resolves the invoice through the company-scoped fetch before reading a note", async () => {
    const { app, spy } = buildNotesApp();
    await call(app, "get", "/api/invoices/10/ar-notes");
    assert.deepEqual(spy.getInvoiceByIdCalls, [[10, 1]]);
    assert.deepEqual(spy.getInvoiceArNotesCalls, [[10, 1]]);
  });

  it("404s an unknown invoice without touching a note row", async () => {
    const { app, spy } = buildNotesApp();
    const { status } = await call(app, "get", "/api/invoices/999/ar-notes");
    assert.equal(status, 404);
    assert.deepEqual(spy.getInvoiceArNotesCalls, []);
  });

  it("super_admin reads across companies (scope null)", async () => {
    const { app, spy } = buildNotesApp({ role: "super_admin", companyId: null });
    await call(app, "get", "/api/invoices/10/ar-notes");
    assert.deepEqual(spy.getInvoiceByIdCalls, [[10, null]]);
  });
});

describe("POST /api/invoices/:id/ar-notes", () => {
  it("appends a note attributed to the caller", async () => {
    const { app, spy } = buildNotesApp();
    const { status, body } = await call(app, "post", "/api/invoices/10/ar-notes", {
      note: "  AP says it's in the next check run.  ",
    });
    assert.equal(status, 201);
    assert.equal(body.note.note, "AP says it's in the next check run.", "trimmed");
    assert.equal(body.note.authorUserId, 7);
    assert.equal(body.note.authorName, "Dana Reyes");
    // companyId comes off the resolved invoice, never off the request body.
    assert.equal(spy.createCalls[0].companyId, 1);
    assert.equal(spy.createCalls[0].invoiceId, 10);
  });

  it("resolves the invoice first, and 404s before writing anything", async () => {
    const { app, spy } = buildNotesApp();
    const { status } = await call(app, "post", "/api/invoices/999/ar-notes", { note: "x" });
    assert.equal(status, 404);
    assert.deepEqual(spy.createCalls, []);
  });

  it("refuses an empty note", async () => {
    const { app, spy } = buildNotesApp();
    for (const note of ["", "   ", null, undefined, 42]) {
      const { status } = await call(app, "post", "/api/invoices/10/ar-notes", { note });
      assert.equal(status, 400, `note=${JSON.stringify(note)}`);
    }
    assert.deepEqual(spy.createCalls, []);
  });

  it("refuses a note past the length limit", async () => {
    const { app, spy } = buildNotesApp();
    const { status } = await call(app, "post", "/api/invoices/10/ar-notes", {
      note: "x".repeat(AR_NOTE_MAX_LENGTH + 1),
    });
    assert.equal(status, 400);
    assert.deepEqual(spy.createCalls, []);
  });

  it("ignores a client-supplied companyId, author, or timestamp", async () => {
    const { app, spy } = buildNotesApp();
    await call(app, "post", "/api/invoices/10/ar-notes", {
      note: "real note",
      companyId: 99,
      authorUserId: 4242,
      authorName: "Somebody Else",
      createdAt: "1999-01-01T00:00:00.000Z",
    });
    const written = spy.createCalls[0];
    assert.equal(written.companyId, 1);
    assert.equal(written.authorUserId, 7);
    assert.equal(written.authorName, "Dana Reyes");
    assert.equal("createdAt" in written, false, "the server's clock, not the client's");
  });

  it("still records the note when the author's name cannot be resolved", async () => {
    const { app, spy } = buildNotesApp({ userName: null });
    const { status } = await call(app, "post", "/api/invoices/10/ar-notes", { note: "n" });
    assert.equal(status, 201);
    assert.equal(spy.createCalls[0].authorName, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Append-only
// ─────────────────────────────────────────────────────────────────────────────

describe("the thread is append-only — no endpoint can edit or delete a note", () => {
  for (const method of ["put", "patch", "delete"]) {
    it(`${method.toUpperCase()} /api/invoices/:id/ar-notes is not a route`, async () => {
      const { app, spy } = buildNotesApp();
      const { status } = await call(
        app,
        method,
        "/api/invoices/10/ar-notes",
        method === "delete" ? undefined : { note: "rewritten" },
      );
      assert.equal(status, 404, "must not be handled at all");
      assert.deepEqual(spy.createCalls, []);
    });

    it(`${method.toUpperCase()} /api/invoices/:id/ar-notes/:noteId is not a route`, async () => {
      const { app } = buildNotesApp();
      const { status } = await call(
        app,
        method,
        "/api/invoices/10/ar-notes/1",
        method === "delete" ? undefined : { note: "rewritten" },
      );
      assert.equal(status, 404);
    });
  }

  it("POST to a specific note id is not a route either", async () => {
    const { app } = buildNotesApp();
    const { status } = await call(app, "post", "/api/invoices/10/ar-notes/1", { note: "x" });
    assert.equal(status, 404);
  });

  it("the route module registers only a GET and a POST", () => {
    const src = readFileSync(join(import.meta.dirname, "invoice-ar-note-routes.ts"), "utf8");
    const registered = src.match(/app\.(get|post|put|patch|delete)\(/g) ?? [];
    assert.deepEqual(registered.sort(), ["app.get(", "app.post("]);
  });

  it("the storage layer exposes no way to change or remove a note", () => {
    // Comments are stripped first: storage.ts explains at the declaration site
    // why there is no updater and no deleter, and the explanation must not be
    // what trips this assertion.
    const src = readFileSync(join(import.meta.dirname, "..", "storage.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    for (const forbidden of [
      /updateInvoiceArNote/,
      /deleteInvoiceArNote/,
      /update\(invoiceArNotes\)/,
      /delete\(invoiceArNotes\)/,
    ]) {
      assert.equal(
        forbidden.test(src),
        false,
        `storage must not contain ${forbidden} — the thread is append-only`,
      );
    }
  });

  it("the table carries no soft-delete or edited-at column", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "..", "lib", "db", "src", "schema", "schema.ts"),
      "utf8",
    );
    const start = src.indexOf('export const invoiceArNotes = pgTable("invoice_ar_notes"');
    assert.notEqual(start, -1, "the table must exist");
    const decl = src.slice(start, src.indexOf("}));", start));
    for (const forbidden of ["deleted_at", "updated_at", "edited_at", "is_deleted"]) {
      assert.equal(decl.includes(forbidden), false, `invoice_ar_notes must not carry ${forbidden}`);
    }
    // And it must say, at the definition, that these never reach a customer.
    const comment = src.slice(Math.max(0, start - 1800), start);
    assert.match(comment, /internal/i);
    assert.match(comment, /customer-facing/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) A role without the capability learns nothing
// ─────────────────────────────────────────────────────────────────────────────

describe("irrigation_manager — refused, and told nothing by omission", () => {
  it("is refused on read and on append, and no storage call is made", async () => {
    const { app, spy } = buildNotesApp({ role: "irrigation_manager" });
    assert.equal((await call(app, "get", "/api/invoices/10/ar-notes")).status, 403);
    assert.equal(
      (await call(app, "post", "/api/invoices/10/ar-notes", { note: "x" })).status,
      403,
    );
    assert.deepEqual(spy.getInvoiceByIdCalls, [], "the guard runs before any lookup");
    assert.deepEqual(spy.getInvoiceArNotesCalls, []);
    assert.deepEqual(spy.createCalls, []);
  });

  it("the refusal body says nothing about notes existing", async () => {
    const { app } = buildNotesApp({ role: "irrigation_manager" });
    const { body } = await call(app, "get", "/api/invoices/10/ar-notes");
    assert.equal(/note/i.test(JSON.stringify(body)), false, JSON.stringify(body));
  });

  it("gets an invoice list with the note keys ABSENT, not zeroed", async () => {
    const { body } = await getInvoiceList("irrigation_manager", {
      1: { noteCount: 3, lastNoteAt: NOW, lastNoteText: "Disputing the second ticket." },
    });
    const row = body[0];
    assert.equal("arNoteCount" in row, false, "the count must not be on the wire at all");
    assert.equal("lastArNoteAt" in row, false);
    assert.equal("lastArNotePreview" in row, false);
    // Belt and braces: no trace of the text anywhere in the serialized payload.
    assert.equal(JSON.stringify(body).includes("Disputing the second ticket"), false);
  });

  it("never causes the note rollup query to run for an unauthorized caller", async () => {
    const { summaryCalls } = await getInvoiceList("irrigation_manager", {
      1: { noteCount: 3, lastNoteAt: NOW, lastNoteText: "x" },
    });
    assert.equal(summaryCalls, 0, "do not even load what must not be sent");
  });

  it("a bookkeeper gets the count and the preview on the same row", async () => {
    const { body, summaryCalls } = await getInvoiceList("bookkeeper", {
      1: { noteCount: 3, lastNoteAt: NOW, lastNoteText: "Disputing the second ticket." },
    });
    assert.equal(summaryCalls, 1, "one rollup for the whole set, never one per row");
    assert.equal(body[0].arNoteCount, 3);
    assert.equal(body[0].lastArNoteAt, NOW.toISOString());
    assert.equal(body[0].lastArNotePreview, "Disputing the second ticket.");
    // A row with no notes says so explicitly rather than omitting the key —
    // absent means "not allowed to know", and the two must not be confusable.
    assert.equal(body[1].arNoteCount, 0);
    assert.equal(body[1].lastArNotePreview, null);
  });

  it("the strip is a real second line of defence, not just the skipped fetch", () => {
    // Run the production sanitizer over a payload that already carries the
    // keys, as it would if a future annotation path forgot the capability
    // check. Nothing may survive.
    const rows = [
      { id: 1, arNoteCount: 2, lastArNoteAt: "x", lastArNotePreview: "AP is stalling", other: 1 },
    ];
    const stripped = applyArNoteVisibility({ authenticatedUserRole: "irrigation_manager" }, rows);
    assert.deepEqual(stripped, [{ id: 1, other: 1 }]);
    // And it leaves an authorized caller's payload alone.
    const kept = applyArNoteVisibility({ authenticatedUserRole: "bookkeeper" }, [
      { id: 1, arNoteCount: 2 },
    ]);
    assert.deepEqual(kept, [{ id: 1, arNoteCount: 2 }]);
  });
});

/** Runs the REAL invoice list handler with the REAL A/R note strip. */
async function getInvoiceList(
  role: string,
  summaries: Record<number, { noteCount: number; lastNoteAt: Date; lastNoteText: string }>,
  companyId: number | null = 1,
): Promise<{ body: any[]; summaryCalls: number }> {
  let summaryCalls = 0;
  const rows: InvoiceRowLike[] = [1, 2].map((id) => ({
    id,
    customerId: 100,
    customerName: `Customer ${id}`,
    customerEmail: `c${id}@example.com`,
    invoiceNumber: `INV-000${id}`,
    status: "generated",
    totalAmount: "100.00",
    createdAt: new Date(NOW.getTime() - id * 86_400_000),
    periodStart: NOW,
    dueDate: null,
    sentAt: NOW,
    paidAt: null,
    paymentStatus: "unpaid",
    balance: "100.00",
    paymentSyncedAt: NOW,
    quickbooksInvoiceId: null,
    qbVoidDetectedAt: null,
    qbNote: null,
  }));

  const app = express();
  app.use(express.json());
  registerInvoiceListRoutes(app, {
    requireAuthentication: makeAuth(role, companyId),
    requireInvoiceRead,
    applyPricingVisibility: (_req, data) => data,
    applyArNoteVisibility,
    _storageApi: {
      async getInvoices() {
        return rows;
      },
      async getInvoiceReminderSummaries() {
        return new Map();
      },
      async getInvoiceArNoteSummaries() {
        summaryCalls += 1;
        return new Map(Object.entries(summaries).map(([k, v]) => [Number(k), v]));
      },
    },
    _loadPaymentTerms: async () => new Map(),
    _now: () => NOW,
  });

  const { body } = await call(app, "get", "/api/invoices");
  return { body, summaryCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// (f) Multi-tenant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("a note in company A is invisible and unreachable from company B", () => {
  const invoices = new Map([
    [10, { id: 10, companyId: 1 }],
    [20, { id: 20, companyId: 2 }],
  ]);
  const seed = (): StoredNote[] => [
    {
      id: 1,
      companyId: 1,
      invoiceId: 10,
      authorUserId: 7,
      authorName: "Dana Reyes",
      note: "Company A only — disputing the second ticket.",
      createdAt: NOW,
    },
  ];

  it("company B cannot read company A's thread", async () => {
    const notes = seed();
    const { app, spy } = buildNotesApp({ companyId: 2, invoices, notes });
    const { status, body } = await call(app, "get", "/api/invoices/10/ar-notes");
    assert.equal(status, 404, "the invoice itself is out of scope");
    assert.equal(JSON.stringify(body).includes("Company A only"), false);
    assert.deepEqual(spy.getInvoiceArNotesCalls, [], "no note row is even selected");
  });

  it("company B cannot append to company A's invoice", async () => {
    const notes = seed();
    const { app, spy } = buildNotesApp({ companyId: 2, invoices, notes });
    const { status } = await call(app, "post", "/api/invoices/10/ar-notes", { note: "sneaky" });
    assert.equal(status, 404);
    assert.deepEqual(spy.createCalls, []);
    assert.equal(
      notes.some((n) => n.note === "sneaky"),
      false,
    );
  });

  it("company A still reads its own thread", async () => {
    const notes = seed();
    const { app } = buildNotesApp({ companyId: 1, invoices, notes });
    const { status, body } = await call(app, "get", "/api/invoices/10/ar-notes");
    assert.equal(status, 200);
    assert.ok(
      body.notes.some((n: any) => n.note.startsWith("Company A only")),
      "membership, not an exact count — the dev database is shared",
    );
  });

  it("the read is scoped even when the invoice id happens to be reachable", async () => {
    // Company B's own invoice: resolvable, but the note filter still carries
    // company B's scope, so a stray company A row on the same id is excluded.
    const notes: StoredNote[] = [
      { ...seed()[0], invoiceId: 20 },
      {
        id: 2,
        companyId: 2,
        invoiceId: 20,
        authorUserId: 9,
        authorName: "Sam",
        note: "Company B note.",
        createdAt: NOW,
      },
    ];
    const { app } = buildNotesApp({ companyId: 2, invoices, notes });
    const { body } = await call(app, "get", "/api/invoices/20/ar-notes");
    const texts = body.notes.map((n: any) => n.note);
    assert.ok(texts.includes("Company B note."));
    assert.equal(
      texts.some((t: string) => t.startsWith("Company A only")),
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) The three customer-facing surfaces
// ─────────────────────────────────────────────────────────────────────────────
//
// One group, three surfaces, asserted on GENERATED OUTPUT. The point is not
// that today's code has no line printing a note — it is that if someone adds
// one, this fails. Every assertion below renders the real artifact and greps
// the bytes.

const SECRET_NOTE = "AP is stalling — customer disputing the second ticket";
const SECRET_NOTE_2 = "Left a voicemail for Dana; cheque story keeps changing";

/** Every A/R-note-ish key an over-eager join might smuggle onto a row. */
const NOTE_BEARING_FIELDS = {
  arNotes: [{ id: 1, note: SECRET_NOTE, authorName: "Dana Reyes" }],
  arNoteCount: 2,
  lastArNoteAt: NOW.toISOString(),
  lastArNotePreview: SECRET_NOTE_2,
};

function assertNoNotes(output: string, surface: string) {
  for (const secret of [SECRET_NOTE, SECRET_NOTE_2, "arNotePreview", "lastArNotePreview"]) {
    assert.equal(
      output.includes(secret),
      false,
      `${surface} leaked internal A/R note content: ${secret}`,
    );
  }
}

describe("A/R notes never reach a customer — PDF, email, CSV", () => {
  // ── Surface 1: the invoice PDF ────────────────────────────────────────────
  it("the invoice PDF view model and its rendered pages carry no note text", () => {
    const workOrder = {
      workOrderNumber: "WO-1",
      branchName: null,
      projectName: "Service",
      projectAddress: "123 Main St",
      locationNotes: "",
      assignedTechnicianName: "Tech",
      completedByUserName: "Tech",
      completedAt: new Date("2026-07-15"),
      totalHours: "1",
      laborRate: "100",
      appliedLaborRate: "100",
      laborSubtotal: "100",
      totalPartsCost: "0",
      totalAmount: "100",
      workSummary: "Replaced a head.",
    };
    const data: InvoiceDetailData = {
      // The invoice row is handed to the builder WITH note fields attached, as
      // it would be if a future join dragged them along. Nothing may surface.
      invoice: {
        invoiceNumber: "INV-0001",
        periodStart: new Date("2026-07-01"),
        periodEnd: new Date("2026-07-31"),
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        customerPhone: "555-0100",
        totalAmount: "100",
        partsSubtotal: "0",
        laborSubtotal: "100",
        ...NOTE_BEARING_FIELDS,
      } as any,
      workOrders: [{ workOrder, items: [] }] as any,
      billingSheets: [] as any,
      wetCheckBillings: [] as any,
      company: { name: "IrrigoPro", logo: null } as any,
    } as any;

    const built = buildPdfViewModel(data);
    const vm = (built as any).viewModel ?? built;

    // The structured model first — nothing may even be carried into it.
    assertNoNotes(JSON.stringify(vm), "PDF view model");

    // Then the rendered HTML the PDF is printed from.
    assertNoNotes(reconciliationPage(vm), "PDF reconciliation page");
    assertNoNotes(coverPage(vm), "PDF cover page");
    for (const wo of vm.workOrders ?? []) {
      assertNoNotes(ticketPageWO(wo, vm.invoice.invoiceNumber, [], null, "IrrigoPro"), "PDF WO page");
    }
  });

  // ── Surface 2: every customer-facing email ────────────────────────────────
  it("the invoice-detail email body carries no note text", () => {
    const body = buildInvoiceDetailEmailBody("Test Customer", "INV-0001");
    assertNoNotes(`${body.subject}\n${body.html}\n${body.text}`, "invoice-detail email");
  });

  it("every reminder template carries no note text", () => {
    for (const templateKey of REMINDER_TEMPLATE_KEYS) {
      const rendered = renderReminderEmail({
        templateKey,
        customerName: "Test Customer",
        invoiceNumber: "INV-0001",
        effectiveDueDate: new Date("2026-06-01"),
        daysOverdue: 71,
        balanceDue: 1234.5,
        company: { name: "IrrigoPro", logo: null, email: null, phone: null },
      });
      assertNoNotes(
        `${rendered.subject}\n${rendered.html}\n${rendered.text}`,
        `reminder template ${templateKey}`,
      );
    }
  });

  it("the reminder template input has nowhere to put a note", () => {
    // renderReminderEmail takes a fixed, named input. Passing note fields in
    // must be inert — there is no key iteration to pick them up.
    const rendered = renderReminderEmail({
      templateKey: "firm",
      customerName: "Test Customer",
      invoiceNumber: "INV-0001",
      effectiveDueDate: new Date("2026-06-01"),
      daysOverdue: 71,
      balanceDue: 1234.5,
      company: { name: "IrrigoPro", logo: null, email: null, phone: null },
      ...NOTE_BEARING_FIELDS,
    } as any);
    assertNoNotes(`${rendered.subject}\n${rendered.html}\n${rendered.text}`, "reminder email");
  });

  // ── Surface 3: the CSV export ─────────────────────────────────────────────
  //
  // The builder is imported through a computed specifier: it lives in the web
  // artifact, and a static cross-package import would put a file outside this
  // package's rootDir into its typecheck. The module it points at is pure —
  // no DOM, no network, no Vite alias — precisely so this proof can run here
  // beside the other two rather than in a separate suite.
  it("the CSV export carries no note text", async () => {
    const builderUrl = new URL(
      "../../../irrigopro/src/lib/invoice-csv-builder.ts",
      import.meta.url,
    ).href;
    const { buildSingleInvoiceCsv } = (await import(builderUrl)) as any;

    const csv = buildSingleInvoiceCsv(
      {
        invoiceNumber: "INV-0001",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        invoiceMonth: 7,
        invoiceYear: 2026,
        status: "generated",
        totalAmount: "100.00",
        partsSubtotal: "0",
        laborSubtotal: "100.00",
        quickbooksInvoiceId: null,
        sentAt: "2026-08-01",
        createdAt: "2026-07-31",
        dueDate: "2026-08-31",
        ...NOTE_BEARING_FIELDS,
      },
      {
        invoiceId: 1,
        items: [
          {
            id: 1,
            sourceType: "work_order",
            workOrderId: 5,
            description: "Replaced a head.",
            workDate: "2026-07-15",
            ticketTotal: 100,
          },
        ],
      },
    );

    assert.match(csv, /INV-0001/, "sanity: the export really was generated");
    assertNoNotes(csv, "CSV export");
  });

  it("the CSV builder writes an explicit column list and never walks invoice keys", () => {
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..", "..", "..",
        "irrigopro", "src", "lib", "invoice-csv-builder.ts",
      ),
      "utf8",
    );
    for (const forbidden of [/Object\.keys\(invoice/, /Object\.entries\(invoice/, /\.\.\.invoice/]) {
      assert.equal(forbidden.test(src), false, `CSV builder must not enumerate invoice keys`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview helper
// ─────────────────────────────────────────────────────────────────────────────

describe("arNotePreview", () => {
  it("collapses whitespace so a hover title stays one readable line", () => {
    assert.equal(arNotePreview("  left a\n  voicemail  "), "left a voicemail");
  });

  it("truncates a long note with an ellipsis", () => {
    const preview = arNotePreview("x".repeat(500));
    assert.ok(preview.length <= 160);
    assert.ok(preview.endsWith("…"));
  });

  it("leaves a short note exactly as written", () => {
    assert.equal(arNotePreview("AP says the 15th."), "AP says the 15th.");
  });
});
