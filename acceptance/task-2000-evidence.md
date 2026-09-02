# WC Snapshot repair quantity acceptance evidence

## Requirement map

- Mutation, role guard, validation, structured errors, and best-effort lifecycle audit: `artifacts/api-server/src/routes/routes.ts:10462-10526`
- Tenant/snapshot scope, billed/invoiced locks, row serialization, quantity update, manual-labor clearing, catalog recompute, and stored-total update: `artifacts/api-server/src/storage.ts:10092-10208`
- Shared parts calculation and normalized catalog labor projection: `artifacts/api-server/src/wet-check-billing-view.ts:192-199`, `artifacts/api-server/src/wet-check-billing-view.ts:274-302`
- Shared permission predicate: `artifacts/irrigopro/src/components/wet-check-billings/wet-check-billing-permissions.ts:12-21`
- Inline editor, thresholds, result preview, manual warning, mutation, and query refresh: `artifacts/irrigopro/src/components/wet-check-billings/finding-quantity-edit-inline.tsx:17-269`
- Shared snapshot row rendering: `artifacts/irrigopro/src/components/billing/wet-check-billing-view.tsx:280-295`
- Dedicated modal and combined review wiring: `artifacts/irrigopro/src/components/wet-check-billings/wet-check-billing-view-modal.tsx:173`, `artifacts/irrigopro/src/components/wet-check-review/CombinedReviewSurface.tsx:204`
- Completed-work WCB id, fail-closed lock metadata, and edit controls: `artifacts/irrigopro/src/components/billing/completed-work-detail-modal.tsx:906-911`, `artifacts/irrigopro/src/components/billing/completed-work-detail-modal.tsx:1737-1744`
- Server transaction, parity, scope, validation, lock, and concurrency coverage: `artifacts/api-server/src/wcb-finding-quantity.test.ts:88-254`
- Route/audit contract coverage: `artifacts/api-server/src/routes/finding-quantity-route-contract.test.ts:9-40`
- Confirmation, warning, URL, invalidation, and read-only coverage: `artifacts/irrigopro/src/components/wet-check-billings/finding-quantity-edit-inline.test.tsx`
- Three-surface identifier and absent-id behavior: `artifacts/irrigopro/src/components/wet-check-billings/wc-snapshot-quantity-surfaces.test.ts`

## Validation output

- API TypeScript: passed (`pnpm --filter @workspace/api-server exec tsc --noEmit --pretty false`)
- Web TypeScript: passed (`pnpm --filter @workspace/irrigopro exec tsc --noEmit --pretty false`)
- Focused API suites: 32 passed, 0 failed
- Focused web suites: 43 passed, 0 failed
- Fresh architect review: passed with no remaining actionable defects
- API and web workflows restarted successfully; startup and browser console logs are clean

## Screenshot

`acceptance/task-2000-command-center.jpg`

The automated preview browser had no authenticated application session, so this image documents the clean running preview and sign-in boundary only. It does not claim to show a Command Center record. The corrected 192 → 2 quantity and resulting parts/labor/total/activity behavior are proven by the server transaction and client interaction suites above.