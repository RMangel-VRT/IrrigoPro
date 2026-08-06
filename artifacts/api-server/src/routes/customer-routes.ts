// Customer CRUD routes — extracted from routes.ts as part of Task #446.
// Behavior is byte-for-byte identical to the previous inline definitions.
// Covers GET-by-id (the second copy at the post-collection block), POST
// create, PUT/PATCH update, PATCH /labor-rates, and DELETE.

import type { Express, Request, RequestHandler } from "express";
import { z } from "zod/v4";
import { insertCustomerSchema } from "@workspace/db";
import { withDbRetry } from "@workspace/db";
import { storage } from "../storage";

export interface RegisterCustomerRoutesDeps {
  requireAuthentication: RequestHandler;
  requireCompanyAdminAccess: RequestHandler;
  requireCustomerEditAccess: RequestHandler;
  applyBillingNotesVisibility: <T>(req: Request, data: T) => T;
}

function extractPgFields(error: unknown): {
  pgCode: string | null;
  pgMessage: string | null;
  pgDetail: string | null;
} {
  const cause = (error as { cause?: { code?: string; message?: string; detail?: string } })?.cause;
  return {
    pgCode: cause?.code ?? null,
    pgMessage: cause?.message ?? null,
    pgDetail: cause?.detail ?? null,
  };
}

export function registerCustomerRoutes(
  app: Express,
  {
    requireAuthentication,
    requireCompanyAdminAccess,
    requireCustomerEditAccess,
    applyBillingNotesVisibility,
  }: RegisterCustomerRoutesDeps,
): void {
  app.get("/api/customers/:id", requireAuthentication, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const customer = await storage.getCustomer(id);
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      res.json(applyBillingNotesVisibility(req, customer));
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Failed to fetch customer" });
    }
  });

  app.post("/api/customers", requireAuthentication, requireCompanyAdminAccess, async (req, res) => {
    try {
      let customerData = insertCustomerSchema.parse(req.body);
      // Only billing_manager may set billingNotes at creation time
      if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
        const { billingNotes, ...rest } = customerData;
        customerData = rest as typeof customerData;
      }
      const customer = await storage.createCustomer(customerData);
      res.status(201).json(customer);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid customer data", errors: error.issues });
        return;
      }
      const { pgCode, pgMessage, pgDetail } = extractPgFields(error);
      req.log.error({ err: error, pgCode, pgMessage, pgDetail, route: "POST /api/customers" }, "customer write failed");
      res.status(500).json({ message: "Failed to create customer" });
    }
  });

  app.put("/api/customers/:id", requireAuthentication, requireCustomerEditAccess, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      let customerData = insertCustomerSchema.partial().parse(req.body);
      // Only billing_manager may write billingNotes (use authenticated role, not raw header)
      if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
        const { billingNotes, ...rest } = customerData;
        customerData = rest;
      }
      const customer = await withDbRetry(() => storage.updateCustomer(id, customerData));
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      res.json(applyBillingNotesVisibility(req, customer));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid customer data", errors: error.issues });
        return;
      }
      const { pgCode, pgMessage, pgDetail } = extractPgFields(error);
      req.log.error({ err: error, pgCode, pgMessage, pgDetail, route: "PUT /api/customers/:id" }, "customer write failed");
      res.status(500).json({ message: "Failed to update customer" });
    }
  });

  app.patch("/api/customers/:id", requireAuthentication, requireCustomerEditAccess, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      let customerData = insertCustomerSchema.partial().parse(req.body);
      // Only billing_manager may write billingNotes (use authenticated role, not raw header)
      if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
        const { billingNotes, ...rest } = customerData;
        customerData = rest;
      }
      const customer = await withDbRetry(() => storage.updateCustomer(id, customerData));
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      res.json(applyBillingNotesVisibility(req, customer));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid customer data", errors: error.issues });
        return;
      }
      const { pgCode, pgMessage, pgDetail } = extractPgFields(error);
      req.log.error({ err: error, pgCode, pgMessage, pgDetail, route: "PATCH /api/customers/:id" }, "customer write failed");
      res.status(500).json({ message: "Failed to update customer" });
    }
  });

  app.patch("/api/customers/:id/labor-rates", requireAuthentication, async (req, res) => {
    try {
      if (req.authenticatedUserRole !== 'company_admin') {
        res.status(403).json({ message: "Access denied. Labor rate changes are restricted to company administrators." });
        return;
      }
      const id = parseInt(String(req.params.id));
      const laborRateSchema = z.object({
        laborRate: z.union([z.string(), z.number()]).optional(),
        emergencyLaborRate: z.union([z.string(), z.number()]).optional(),
      });
      const parsed = laborRateSchema.parse(req.body);
      const updateData: { laborRate?: string; emergencyLaborRate?: string } = {};
      if (parsed.laborRate !== undefined) updateData.laborRate = String(parsed.laborRate);
      if (parsed.emergencyLaborRate !== undefined) updateData.emergencyLaborRate = String(parsed.emergencyLaborRate);
      const customer = await withDbRetry(() => storage.updateCustomer(id, updateData));
      if (!customer) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      res.json(customer);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid labor rate data", errors: error.issues });
        return;
      }
      const { pgCode, pgMessage, pgDetail } = extractPgFields(error);
      req.log.error({ err: error, pgCode, pgMessage, pgDetail, route: "PATCH /api/customers/:id/labor-rates" }, "customer write failed");
      res.status(500).json({ message: "Failed to update labor rates" });
    }
  });

  app.delete("/api/customers/:id", requireCompanyAdminAccess, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id));
      const success = await withDbRetry(() => storage.deleteCustomer(id));
      if (!success) {
        res.status(404).json({ message: "Customer not found" });
        return;
      }
      res.json({ message: "Customer deleted successfully" });
    } catch (error) {
      const { pgCode, pgMessage, pgDetail } = extractPgFields(error);
      req.log.error({ err: error, pgCode, pgMessage, pgDetail, route: "DELETE /api/customers/:id" }, "customer write failed");
      res.status(500).json({ message: "Failed to delete customer" });
    }
  });
}
