---
name: Follow-up WO idempotency pattern
description: Enforcing one-follow-up-per-parent for work orders; 23505-catch idempotency pattern and schema index approach.
---

# Follow-up WO idempotency — one follow-up per parent

## The rule
Create the follow-up with `estimateId: null` and `parentWorkOrderId` set.
Enforce uniqueness with a **partial unique index** (same pattern as `work_orders_estimate_unique_idx`):
```sql
CREATE UNIQUE INDEX work_orders_follow_up_unique_idx
  ON work_orders(parent_work_order_id)
  WHERE parent_work_order_id IS NOT NULL;
```
At the application layer, **catch the 23505** from the insert and read back the existing follow-up — do NOT rely on a pre-check query alone (two concurrent completions can both pass a pre-check and then race the insert).

**Why:** An application-level check-then-insert has a TOCTOU race. The DB index is the final authority; the 23505 path tells the application the race happened. This is identical to how `createWorkOrderFromEstimate` handles the `work_orders_estimate_unique_idx` collision.

**How to apply:**
- Storage method `createFollowUpWorkOrder` does the insert inside a try/catch.
- The route catches `pgCode === '23505'`, reads back the winner via `getFollowUpWorkOrder`, logs at info level, and continues.
- Any other error: log at error level through the structured logger (not `console.error`), then continue — completion must never be blocked.

## Schema self-reference
No `.references()` on the same table. Use the pattern from `supersededByInvoiceId`/`mergedIntoInvoiceId` on invoices (avoids TS7022 circular-inference errors):
```typescript
parentWorkOrderId: integer("parent_work_order_id"),  // no .references()
```
