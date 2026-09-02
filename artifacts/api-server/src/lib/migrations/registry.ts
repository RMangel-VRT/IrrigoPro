import type { MigrationDefinition } from './types';
import { repairWoMatchEstimateMigration } from './repair-wo-match-estimate';
import { reconcileInspectionPassMigration } from './reconcile-inspection-pass';
import { invoiceRevisionBackfillMigration } from './invoice-revision-backfill';
import { repairTicketTotalDriftMigration } from './repair-ticket-total-drift';
import { backfillMergedInvoiceStatusMigration } from './backfill-merged-invoice-status';
import { repairQbVoidMispaidMigration } from './repair-qb-void-mispaid';
import { repairWoodglennWoHoursMigration } from './repair-woodglenn-wo-hours';
import { createWoodglennFollowupMigration } from './create-woodglenn-followup';
import { invoiceSentStatusBackfillMigration } from './invoice-sent-status-backfill';
import { normalizeUsernamesMigration } from './normalize-usernames';
import { seedFieldWorkTypesMigration } from './seed-field-work-types';

const REGISTRY = new Map<string, MigrationDefinition>([
  [repairTicketTotalDriftMigration.id, repairTicketTotalDriftMigration],
  [repairWoMatchEstimateMigration.id, repairWoMatchEstimateMigration],
  [reconcileInspectionPassMigration.id, reconcileInspectionPassMigration],
  [invoiceRevisionBackfillMigration.id, invoiceRevisionBackfillMigration],
  [backfillMergedInvoiceStatusMigration.id, backfillMergedInvoiceStatusMigration],
  [repairQbVoidMispaidMigration.id, repairQbVoidMispaidMigration],
  [repairWoodglennWoHoursMigration.id, repairWoodglennWoHoursMigration],
  [createWoodglennFollowupMigration.id, createWoodglennFollowupMigration],
  [invoiceSentStatusBackfillMigration.id, invoiceSentStatusBackfillMigration],
  [normalizeUsernamesMigration.id, normalizeUsernamesMigration],
  [seedFieldWorkTypesMigration.id, seedFieldWorkTypesMigration],
]);

export function listMigrations(): MigrationDefinition[] {
  return Array.from(REGISTRY.values());
}

export function getMigration(id: string): MigrationDefinition | undefined {
  return REGISTRY.get(id);
}
