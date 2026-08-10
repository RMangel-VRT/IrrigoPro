# Hand-rolled role checks — migration inventory

Generated for Task #1886 (bookkeeper role + central role registry).

A "hand-rolled role check" is code that asks *who a user is* — `role === "company_admin"`,
`SOME_ROLES.has(role)`, `[...].includes(role)` — instead of asking the registry in
`lib/shared/src/roles.ts` *what the user can do*.

**Ticket A migrated the invoice, AR, and QuickBooks sites only.** Everything listed
below is the remaining surface, left deliberately for a follow-up refactor.

## How to find the work

Each natural refactor unit — a role-set constant or a guard definition — carries a
`TODO(roles)` marker in the source. **34 markers across 15 files.** (`customer-billing.tsx` — the Command Center — is explicitly out of scope for this ticket and was deliberately left unmarked.)

```
grep -rn "TODO(roles)" artifacts lib --include=*.ts --include=*.tsx
```

Markers were placed on refactor *units* rather than on all 504 individual comparison
sites: one `TODO(roles)` above `const VISIBILITY_ROLES = new Set([...])` tells the
refactorer everything that 6 inline markers on its call sites would, and keeps the
diff reviewable. The exhaustive site list is in this document instead.

## Counts

Two metrics, because neither alone is honest.

### Metric 1 — role *comparisons* (`=== "role"`, `.has("role")`, `.includes("role")`)

| | Sites | Files |
|---|---|---|
| Before | 505 | 75 |
| After  | 504 | 75 |

Command:

```
grep -rnE "(===|!==|\.includes\(|\.has\()\s*['\"](super_admin|company_admin|billing_manager|irrigation_manager|field_tech|bookkeeper)['\"]|['\"](super_admin|company_admin|billing_manager|irrigation_manager|field_tech|bookkeeper)['\"]\s*(===|!==)" \
  --include=*.ts --include=*.tsx artifacts/api-server/src artifacts/irrigopro/src lib \
  | grep -v '\.test\.' | grep -v '/dist/' | grep -vE ':\s*//' | grep -v 'lib/shared/src/roles.ts'
```

### Metric 2 — role string *literals* outside the registry

Metric 1 undercounts, because it misses bare `new Set(["company_admin", ...])` members.
Metric 2 counts every role literal in non-test source, excluding the two new
capability-backed modules (`roles.ts`, `role-guards.ts`).

| | Literals | Files |
|---|---|---|
| Before | 955 | 93 |
| After  | 941 | 90 |
| **Gross removed** | **20** | |
| **Gross added** (the new `bookkeeper` role itself) | **6** | |

Per-file movement — this is what Ticket A actually changed:

| File | Before | After | Delta | Why |
|---|---|---|---|---|
| `artifacts/api-server/src/routes/routes.ts` | 320 | 314 | -6 | `requireBillingAccess` + `requireQuickBooksAccess` bodies and the `connection/stale` inline allowlist moved to capability guards |
| `artifacts/irrigopro/src/App.tsx` | 6 | 7 | +1 | new `bookkeeper` shell branch |
| `artifacts/irrigopro/src/components/company-admin-app.tsx` | 5 | 0 | -5 | inline `User.role` union replaced with the shared `Role` type (step 12) |
| `artifacts/irrigopro/src/components/layout/navigation.tsx` | 15 | 16 | +1 | new `case "bookkeeper"` in the role switch |
| `artifacts/irrigopro/src/components/quickbooks/quickbooks-integration.tsx` | 2 | 0 | -2 | `repairAllowedRoles` replaced with `hasCapability(role, CAN_MANAGE_QUICKBOOKS)` |
| `artifacts/irrigopro/src/lib/auth-context.tsx` | 5 | 0 | -5 | inline `WebUser.role` union replaced with the shared `Role` type |
| `artifacts/irrigopro/src/pages/company-user-management.tsx` | 32 | 36 | +4 | `bookkeeper` added to two zod enums and two select lists so the role is assignable (step 13) |
| `artifacts/irrigopro/src/pages/invoices.tsx` | 4 | 2 | -2 | `MERGE_ROLES` deleted; `canMerge`/`canCorrect`/`canMarkSent` now capability-backed |
| **TOTAL** | **955** | **941** | **-14** | |

The net figure is small by design: this ticket migrated the ~27 invoice and
QuickBooks guard call sites, but role knowledge in this codebase is dominated by
`routes.ts` (314 literals on its own) and by the estimate, work-order, wet-check,
and billing-sheet surfaces, none of which are in Ticket A's scope.

## Remaining sites by file

| File | Comparisons |
|---|---|
| `artifacts/api-server/src/routes/routes.ts` | 199 |
| `artifacts/api-server/src/routes/irrigation-profile-routes.ts` | 18 |
| `artifacts/irrigopro/src/pages/billing-sheets.tsx` | 18 |
| `artifacts/irrigopro/src/pages/work-orders.tsx` | 17 |
| `artifacts/api-server/src/routes/estimate-routes.ts` | 15 |
| `artifacts/irrigopro/src/components/work-orders/work-order-details.tsx` | 15 |
| `artifacts/api-server/src/routes/approve-routes.ts` | 13 |
| `artifacts/api-server/src/routes/manager-workspace-routes.ts` | 12 |
| `artifacts/api-server/src/routes/billing-workspace-routes.ts` | 12 |
| `artifacts/irrigopro/src/pages/customers.tsx` | 9 |
| `artifacts/api-server/src/routes/parts-routes.ts` | 8 |
| `artifacts/api-server/src/routes/invoice-correction-routes.ts` | 7 |
| `artifacts/api-server/src/routes/invoice-editability-routes.ts` | 7 |
| `artifacts/irrigopro/src/components/billing/completed-work-detail-modal.tsx` | 7 |
| `artifacts/irrigopro/src/components/layout/navigation.tsx` | 7 |
| `artifacts/irrigopro/src/components/work-orders/work-order-completion.tsx` | 7 |
| `artifacts/irrigopro/src/pages/customer-profile.tsx` | 7 |
| `artifacts/irrigopro/src/App.tsx` | 7 |
| `artifacts/irrigopro/src/components/billing/billing-sheet-wizard.tsx` | 6 |
| `artifacts/irrigopro/src/components/layout/desktop-shell.tsx` | 6 |
| `artifacts/irrigopro/src/pages/wet-checks/WetChecksListPage.tsx` | 6 |
| `artifacts/irrigopro/src/components/customer-form.tsx` | 5 |
| `artifacts/irrigopro/src/pages/customers/IrrigationProfile.tsx` | 5 |
| `artifacts/irrigopro/src/pages/manager-workspace.tsx` | 5 |
| `artifacts/api-server/src/routes/wet-check-reconciliation-routes.ts` | 4 |
| `artifacts/api-server/src/routes/budget-routes.ts` | 4 |
| `artifacts/api-server/src/routes/customer-routes.ts` | 4 |
| `artifacts/irrigopro/src/components/wet-check-review/CombinedReviewSurface.tsx` | 4 |
| `artifacts/irrigopro/src/pages/wet-checks/WetCheckDetail.tsx` | 4 |
| `artifacts/irrigopro/src/pages/admin-issue-types.tsx` | 4 |
| `artifacts/api-server/src/routes/site-map-routes.ts` | 3 |
| `artifacts/irrigopro/src/components/wet-check-billings/wet-check-billing-view-modal.tsx` | 3 |
| `artifacts/irrigopro/src/pages/estimates.tsx` | 3 |
| `artifacts/irrigopro/src/pages/customer-billing.tsx` | 3 |
| `artifacts/irrigopro/src/pages/company-user-management.tsx` | 3 |
| `artifacts/api-server/src/routes/invoice-mark-sent-routes.ts` | 2 |
| `artifacts/api-server/src/routes/qb-payment-sync.ts` | 2 |
| `artifacts/irrigopro/src/components/site-maps/site-maps-page.tsx` | 2 |
| `artifacts/irrigopro/src/components/user-selector.tsx` | 2 |
| `artifacts/irrigopro/src/components/work-orders/wizard/wo-schedule-step.tsx` | 2 |
| `artifacts/irrigopro/src/pages/operations.tsx` | 2 |
| `artifacts/irrigopro/src/pages/admin-controllers.tsx` | 2 |
| `artifacts/api-server/src/lib/company-throttle.ts` | 1 |
| `artifacts/api-server/src/routes/cleanup-invoice-71256.ts` | 1 |
| `artifacts/api-server/src/routes/work-order-list-route.ts` | 1 |
| `artifacts/api-server/src/routes/billing-sheet-tenant-guard.ts` | 1 |
| `artifacts/api-server/src/routes/work-order-tenant-guard.ts` | 1 |
| `artifacts/api-server/src/routes/admin-wc-labor-backfill-routes.ts` | 1 |
| `artifacts/api-server/src/routes/billing-workspace-bulk-approve.ts` | 1 |
| `artifacts/api-server/src/routes/wet-check-photo-attach-route.ts` | 1 |
| `artifacts/api-server/src/routes/admin-inspection-zone-backfill-routes.ts` | 1 |
| `artifacts/api-server/src/routes/work-order-zone-route.ts` | 1 |
| `artifacts/api-server/src/routes/estimate-role-guards.ts` | 1 |
| `artifacts/api-server/src/routes/admin-migrations-routes.ts` | 1 |
| `artifacts/api-server/src/routes/financial-pulse.ts` | 1 |
| `artifacts/api-server/src/routes/invoice-merge-routes.ts` | 1 |
| `artifacts/api-server/src/routes/invoice-sync-quickbooks-route.ts` | 1 |
| `artifacts/irrigopro/src/components/customers/billing-notes.tsx` | 1 |
| `artifacts/irrigopro/src/components/customers/property-notes.tsx` | 1 |
| `artifacts/irrigopro/src/components/customers/customer-site-maps.tsx` | 1 |
| `artifacts/irrigopro/src/components/estimates/estimate-wizard.tsx` | 1 |
| `artifacts/irrigopro/src/components/manager/wet-check-wizard.tsx` | 1 |
| `artifacts/irrigopro/src/components/app-health/user-detail-drawer.tsx` | 1 |
| `artifacts/irrigopro/src/components/billing-workspace/wet-checks-tab.tsx` | 1 |
| `artifacts/irrigopro/src/lib/impersonation.ts` | 1 |
| `artifacts/irrigopro/src/pages/admin-client-errors.tsx` | 1 |
| `artifacts/irrigopro/src/pages/wet-checks/ManagerWetCheckDetailPage.tsx` | 1 |
| `artifacts/irrigopro/src/pages/wet-checks/WetCheckList.tsx` | 1 |
| `artifacts/irrigopro/src/pages/admin-customers.tsx` | 1 |
| `artifacts/irrigopro/src/pages/admin/migrations.tsx` | 1 |
| `artifacts/irrigopro/src/pages/admin-wc-labor-backfill.tsx` | 1 |
| `artifacts/irrigopro/src/pages/super-admin-loose-photos.tsx` | 1 |
| `artifacts/irrigopro/src/pages/wet-check-reconciliation.tsx` | 1 |
| `artifacts/irrigopro/src/pages/super-admin-app-health.tsx` | 1 |
| `artifacts/irrigopro/src/pages/parts-catalog.tsx` | 1 |

## Client (irrigopro)


### `artifacts/irrigopro/src/App.tsx` (7)

```
222: if (currentPath === "/super-admin/app-health" && user.role !== "super_admin") {
242: if (user.role === "field_tech") {
290: if (user.role === "irrigation_manager") {
361: if (user.role === "bookkeeper") {
390: if (user.role === "billing_manager") {
452: if (user.role === "super_admin") {
515: if (user.role === "company_admin") {
```

### `artifacts/irrigopro/src/components/app-health/user-detail-drawer.tsx` (1)

```
174: const userIsSuperAdmin = data?.user?.role === "super_admin";
```

### `artifacts/irrigopro/src/components/billing-workspace/wet-checks-tab.tsx` (1)

```
43: return r === "billing_manager" || r === "company_admin" || r === "super_admin";
```

### `artifacts/irrigopro/src/components/billing/billing-sheet-wizard.tsx` (6)

```
1166: const isFieldTech = currentUser?.role === "field_tech";
1168: currentUser?.role === "irrigation_manager" ||
1169: currentUser?.role === "billing_manager" ||
1170: currentUser?.role === "company_admin" ||
1171: currentUser?.role === "super_admin";
1458: if (currentUser?.role === "field_tech" && currentUser?.id) {
```

### `artifacts/irrigopro/src/components/billing/completed-work-detail-modal.tsx` (7)

```
752: const canSeePricing = showPricing !== undefined ? showPricing : userRole !== "field_tech";
829: (userRole === "company_admin" || userRole === "super_admin");
964: userRole === 'company_admin' ||
965: userRole === 'super_admin' ||
966: userRole === 'irrigation_manager' ||
967: userRole === 'billing_manager' ||
968: (userRole === 'field_tech' && bs?.technicianId === userId)
```

### `artifacts/irrigopro/src/components/customer-form.tsx` (5)

```
694: {(currentUser?.role === "company_admin" ||
695: currentUser?.role === "billing_manager" ||
696: currentUser?.role === "super_admin") && (
885: (u) => u.companyId === companyId && u.role !== "field_tech" && u.isActive,
897: .filter((u) => u.role === "billing_manager")
```

### `artifacts/irrigopro/src/components/customers/billing-notes.tsx` (1)

```
22: const isBillingManager = userRole === "billing_manager";
```

### `artifacts/irrigopro/src/components/customers/customer-site-maps.tsx` (1)

```
93: const isCompanyAdmin = userRole === "company_admin";
```

### `artifacts/irrigopro/src/components/customers/property-notes.tsx` (1)

```
72: {!isEditing && (userRole === 'company_admin' || userRole === 'super_admin') && (
```

### `artifacts/irrigopro/src/components/estimates/estimate-wizard.tsx` (1)

```
340: return role === "super_admin" || role === "company_admin";
```

### `artifacts/irrigopro/src/components/layout/desktop-shell.tsx` (6)

```
217: userRole === "company_admin" ||
218: userRole === "billing_manager" ||
219: userRole === "irrigation_manager";
403: userRole === "company_admin" ||
404: userRole === "billing_manager" ||
405: userRole === "irrigation_manager";
```

### `artifacts/irrigopro/src/components/layout/navigation.tsx` (7)

```
58: enabled: userRole === 'billing_manager' || userRole === 'company_admin',
63: enabled: userRole === 'billing_manager' || userRole === 'company_admin',
75: enabled: userRole === 'billing_manager' || userRole === 'company_admin',
548: if (userRole === 'company_admin') {
571: } else if (userRole === 'irrigation_manager') {
586: } else if (userRole === 'billing_manager') {
613: if (userRole === 'field_tech') {
```

### `artifacts/irrigopro/src/components/manager/wet-check-wizard.tsx` (1)

```
387: return (u as Record<string, unknown>).role === "billing_manager";
```

### `artifacts/irrigopro/src/components/site-maps/site-maps-page.tsx` (2)

```
61: const canEdit = userRole === 'company_admin' || userRole === 'super_admin';
62: const canView = userRole === 'company_admin' || userRole === 'super_admin' || userRole === 'irrigation_manager' || us...
```

### `artifacts/irrigopro/src/components/user-selector.tsx` (2)

```
139: user.role === 'super_admin' || user.role === 'company_admin' ? 'Full System Access' :
140: user.role === 'irrigation_manager' || user.role === 'billing_manager' ? 'Management Dashboard' :
```

### `artifacts/irrigopro/src/components/wet-check-billings/wet-check-billing-view-modal.tsx` (3)

```
48: return role !== "field_tech";
53: return role === "billing_manager" || role === "company_admin" || role === "super_admin";
74: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") return false;
```

### `artifacts/irrigopro/src/components/wet-check-review/CombinedReviewSurface.tsx` (4)

```
80: return getUserRole() !== "field_tech";
85: return role === "company_admin" || role === "super_admin";
90: return role === "billing_manager" || role === "company_admin" || role === "super_admin";
799: const isAdmin = role === "company_admin" || role === "super_admin";
```

### `artifacts/irrigopro/src/components/work-orders/wizard/wo-schedule-step.tsx` (2)

```
61: const managers = allUsers.filter((u) => u.role === "irrigation_manager");
62: const techs = allUsers.filter((u) => u.role === "field_tech");
```

### `artifacts/irrigopro/src/components/work-orders/work-order-completion.tsx` (7)

```
602: {currentUser?.role !== 'field_tech' && (
615: {currentUser?.role !== 'field_tech' ? (
625: {currentUser?.role !== 'field_tech' && (
927: {currentUser?.role !== 'field_tech' && (
974: {currentUser?.role !== 'field_tech' ? (
1024: {currentUser?.role !== 'field_tech' ? (
1119: {currentUser?.role !== 'field_tech' && (
```

### `artifacts/irrigopro/src/components/work-orders/work-order-details.tsx` (15)

```
418: currentUser?.role === 'company_admin' ||
419: currentUser?.role === 'super_admin' ||
420: currentUser?.role === 'irrigation_manager' ||
421: currentUser?.role === 'billing_manager' ||
422: (currentUser?.role === 'field_tech' && workOrder.assignedTechnicianId === currentUser?.id);
456: currentUser?.role === 'company_admin' ||
457: currentUser?.role === 'super_admin' ||
458: currentUser?.role === 'irrigation_manager' ||
459: currentUser?.role === 'billing_manager';
544: if (!isBilledWorkOrder && workOrder.status !== 'cancelled' && workOrder.status !== 'work_completed' && currentUser?.r...
1088: {!isBilledWorkOrder && fieldTechs && fieldTechs.length > 0 && currentUser?.role !== 'field_tech' && workOrder.status ...
1089: const isAdminRole = currentUser?.role === 'company_admin' || currentUser?.role === 'super_admin';
1091: const managers = fieldTechs.filter(u => u.role === 'irrigation_manager');
1092: const techs = fieldTechs.filter(u => u.role === 'field_tech');
1326: const showPricing = currentUser?.role !== 'field_tech';
```

### `artifacts/irrigopro/src/lib/impersonation.ts` (1)

```
72: if (original.role !== "super_admin") {
```

### `artifacts/irrigopro/src/pages/admin-client-errors.tsx` (1)

```
62: const allowed = role === "super_admin" || role === "company_admin";
```

### `artifacts/irrigopro/src/pages/admin-controllers.tsx` (2)

```
91: if (role !== "company_admin" && role !== "super_admin") {
96: const isAdmin = userRole === "company_admin" || userRole === "super_admin";
```

### `artifacts/irrigopro/src/pages/admin-customers.tsx` (1)

```
99: if (userRole !== "company_admin" && userRole !== "super_admin") {
```

### `artifacts/irrigopro/src/pages/admin-issue-types.tsx` (4)

```
59: const isSuperAdmin = userRole === "super_admin";
61: userRole === "company_admin" ||
62: userRole === "irrigation_manager" ||
63: userRole === "billing_manager" ||
```

### `artifacts/irrigopro/src/pages/admin-wc-labor-backfill.tsx` (1)

```
351: if (!user || user.role !== "super_admin") {
```

### `artifacts/irrigopro/src/pages/admin/migrations.tsx` (1)

```
156: if (!user || user.role !== "super_admin") {
```

### `artifacts/irrigopro/src/pages/billing-sheets.tsx` (18)

```
97: queryKey: currentUser?.role === 'field_tech'
101: if (currentUser?.role === 'field_tech' && currentUser?.id) {
259: const canEditDelete = currentUser?.role === 'company_admin' || currentUser?.role === 'billing_manager' || currentUser...
265: const canSeeReport = canEditDelete || currentUser?.role === 'super_admin';
271: currentUser?.role === 'company_admin' ||
272: currentUser?.role === 'billing_manager' ||
273: currentUser?.role === 'super_admin';
348: title={currentUser?.role === 'field_tech' ? 'My Billing Sheets' : 'Billing Sheets'}
349: subtitle={currentUser?.role === 'field_tech'
584: currentUser?.role === 'field_tech' ? 'lg:grid-cols-2' : 'lg:grid-cols-4'
600: {currentUser?.role !== 'field_tech' && (
638: {(currentUser?.role === 'field_tech' || currentUser?.role === 'irrigation_manager') && sheet.status === 'draft' && sh...
644: {(currentUser?.role === 'irrigation_manager' || currentUser?.role === 'company_admin') && (sheet.status === 'pending_...
655: {currentUser?.role === 'billing_manager' && sheet.status === 'submitted' && (
745: currentUser?.role === 'field_tech' ? 'lg:grid-cols-2' : 'lg:grid-cols-4'
761: {currentUser?.role !== 'field_tech' && (
855: currentUser?.role === 'field_tech' ? 'lg:grid-cols-2' : 'lg:grid-cols-4'
871: {currentUser?.role !== 'field_tech' && (
```

### `artifacts/irrigopro/src/pages/company-user-management.tsx` (3)

```
416: if (!currentUser || currentUser.role !== "company_admin") {
586: <div className="text-2xl font-bold">{users.filter((u: User) => u.role === 'field_tech').length}</div>
595: <div className="text-2xl font-bold">{users.filter((u: User) => u.role === 'irrigation_manager').length}</div>
```

### `artifacts/irrigopro/src/pages/customer-billing.tsx` (3)

```
2398: {(userRole === 'billing_manager' || userRole === 'company_admin' || userRole === 'super_admin') && (
2491: {(userRole === 'billing_manager' || userRole === 'company_admin' || userRole === 'super_admin') && (
2579: {(userRole === 'billing_manager' || userRole === 'company_admin' || userRole === 'super_admin') && (
```

### `artifacts/irrigopro/src/pages/customer-profile.tsx` (7)

```
124: const isAdmin = userRole === "company_admin" || userRole === "super_admin";
126: userRole === "company_admin" ||
127: userRole === "super_admin" ||
128: userRole === "billing_manager";
130: userRole === "company_admin" ||
131: userRole === "super_admin" ||
132: userRole === "billing_manager";
```

### `artifacts/irrigopro/src/pages/customers.tsx` (9)

```
137: (userRole === 'company_admin' || userRole === 'super_admin') && (
231: {userRole !== 'field_tech' && customer.email && (
284: {userRole !== 'field_tech' && (
307: {userRole !== 'field_tech' && (
326: {userRole === 'field_tech' ? (
335: {(userRole === 'company_admin' || userRole === 'super_admin') && (
378: : userRole === 'field_tech'
383: {(userRole === 'company_admin' || userRole === 'super_admin') && (
402: {(userRole === 'company_admin' || userRole === 'super_admin') && (
```

### `artifacts/irrigopro/src/pages/customers/IrrigationProfile.tsx` (5)

```
217: userRole === "company_admin" ||
218: userRole === "super_admin" ||
219: userRole === "irrigation_manager";
221: const canEditZones = canManageControllers || userRole === "field_tech";
225: const canReport = canManageControllers || userRole === "billing_manager";
```

### `artifacts/irrigopro/src/pages/estimates.tsx` (3)

```
45: const isIrrigationManager = currentUser?.role === "irrigation_manager";
46: const isFieldTech = currentUser?.role === "field_tech";
48: const isSuperAdmin = currentUser?.role === "super_admin";
```

### `artifacts/irrigopro/src/pages/manager-workspace.tsx` (5)

```
242: const canSeeEstimates = !!user?.role && user.role !== "field_tech";
265: enabled: user?.role !== "billing_manager",
317: {user?.role === "billing_manager"
322: {user?.role !== "billing_manager" && (
440: {user?.role !== "billing_manager" && (
```

### `artifacts/irrigopro/src/pages/operations.tsx` (2)

```
132: if (currentUser?.role === 'company_admin') {
210: {currentUser?.role === 'company_admin' ? (
```

### `artifacts/irrigopro/src/pages/parts-catalog.tsx` (1)

```
1053: const canImport = userRole === "company_admin" || userRole === "super_admin";
```

### `artifacts/irrigopro/src/pages/super-admin-app-health.tsx` (1)

```
202: const allowed = role === "super_admin";
```

### `artifacts/irrigopro/src/pages/super-admin-loose-photos.tsx` (1)

```
144: const allowed = role === "super_admin";
```

### `artifacts/irrigopro/src/pages/wet-check-reconciliation.tsx` (1)

```
386: if (user && user.role !== "company_admin" && user.role !== "super_admin") {
```

### `artifacts/irrigopro/src/pages/wet-checks/ManagerWetCheckDetailPage.tsx` (1)

```
78: return role === "company_admin" || role === "super_admin";
```

### `artifacts/irrigopro/src/pages/wet-checks/WetCheckDetail.tsx` (4)

```
151: authUser?.role === "irrigation_manager" ||
152: authUser?.role === "company_admin" ||
153: authUser?.role === "super_admin" ||
154: authUser?.role === "billing_manager"
```

### `artifacts/irrigopro/src/pages/wet-checks/WetCheckList.tsx` (1)

```
51: const canDelete = me?.role === "company_admin" || me?.role === "super_admin";
```

### `artifacts/irrigopro/src/pages/wet-checks/WetChecksListPage.tsx` (6)

```
42: if (role === "irrigation_manager") return "submitted,pending_manager_review";
43: if (role === "billing_manager") return "approved,approved_passed_to_billing,partially_converted,converted";
57: return role === "company_admin" || role === "super_admin";
61: return role === "company_admin" || role === "super_admin";
65: return role === "super_admin";
336: enabled: role === "super_admin",
```

### `artifacts/irrigopro/src/pages/work-orders.tsx` (17)

```
106: queryKey: currentUser?.role === 'field_tech'
109: queryFn: () => currentUser?.role === 'field_tech'
134: enabled: !!currentUser && currentUser.role === 'field_tech',
142: if (currentUser?.role === 'field_tech' && notifications) {
169: const canSeeMissingPhotos = currentUser?.role === 'company_admin'
170: || currentUser?.role === 'billing_manager'
171: || currentUser?.role === 'irrigation_manager'
172: || currentUser?.role === 'super_admin';
352: const canEditDelete = currentUser?.role === 'company_admin' || currentUser?.role === 'billing_manager' || currentUser...
422: title={currentUser?.role === 'field_tech' ? 'My Work Orders' : 'Work Orders'}
423: subtitle={currentUser?.role === 'field_tech'
427: actions={currentUser?.role !== 'field_tech' && (
952: : workOrder.status === 'work_completed' && currentUser?.role === 'field_tech'
969: workOrder.status === 'work_completed' && currentUser?.role === 'field_tech'
974: {workOrder.status === 'work_completed' && currentUser?.role === 'field_tech' && (
1105: {currentUser?.role === 'field_tech' ? (
1437: {currentUser?.role !== 'field_tech' && (
```

## Server (api-server)


### `artifacts/api-server/src/lib/company-throttle.ts` (1)

```
120: if (role === "super_admin") return true; // super-admin always observable
```

### `artifacts/api-server/src/routes/admin-inspection-zone-backfill-routes.ts` (1)

```
74: if (req.authenticatedUserRole !== "super_admin") {
```

### `artifacts/api-server/src/routes/admin-migrations-routes.ts` (1)

```
21: if (req.authenticatedUserRole !== 'super_admin') {
```

### `artifacts/api-server/src/routes/admin-wc-labor-backfill-routes.ts` (1)

```
25: if (req.authenticatedUserRole !== "super_admin") {
```

### `artifacts/api-server/src/routes/approve-routes.ts` (13)

```
84: if (userRole !== "irrigation_manager" && userRole !== "company_admin" && userRole !== "super_admin") {
89: const callerCompanyId: number | null = userRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
146: if (userRole !== "irrigation_manager" && userRole !== "company_admin" && userRole !== "super_admin") {
151: const callerCompanyId: number | null = userRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
197: if (userRole !== "irrigation_manager" && userRole !== "company_admin" && userRole !== "super_admin") {
202: const callerCompanyId: number | null = userRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
259: if (userRole !== "irrigation_manager" && userRole !== "company_admin" && userRole !== "super_admin") {
264: const callerCompanyId: number | null = userRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
313: userRole !== "irrigation_manager" &&
314: userRole !== "billing_manager" &&
315: userRole !== "company_admin" &&
316: userRole !== "super_admin"
322: const callerCompanyId: number | null = userRole === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
```

### `artifacts/api-server/src/routes/billing-sheet-tenant-guard.ts` (1)

```
27: if (role === 'super_admin') {
```

### `artifacts/api-server/src/routes/billing-workspace-bulk-approve.ts` (1)

```
65: userRole === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
```

### `artifacts/api-server/src/routes/billing-workspace-routes.ts` (12)

```
85: if (role === "super_admin") return all as any[];
108: const all = await storage.getAllBillingSheets(role === "super_admin" ? null : cid0);
109: if (role === "super_admin") return all as any[];
132: const all = await storage.getWorkOrders(role === "super_admin" ? null : cid0);
133: if (role === "super_admin") return all as any[];
235: if (req.authenticatedUserRole === "super_admin") {
253: if (role === "super_admin") {
287: if (role === "super_admin") {
367: if (role === "super_admin") {
603: if (wantParts && (cid != null || req.authenticatedUserRole === "super_admin")) {
627: if (wantReview && (cid != null || req.authenticatedUserRole === "super_admin")) {
966: if (role === "super_admin") return true;
```

### `artifacts/api-server/src/routes/budget-routes.ts` (4)

```
75: if (role !== "super_admin" && callerCompanyId !== customer.companyId) {
89: const spendCompanyId = role === "super_admin" ? null : (callerCompanyId ?? null);
177: if (role !== "super_admin" && callerCompanyId !== customer.companyId) {
217: if (role !== "super_admin") {
```

### `artifacts/api-server/src/routes/cleanup-invoice-71256.ts` (1)

```
38: if (req.authenticatedUserRole !== "super_admin") {
```

### `artifacts/api-server/src/routes/customer-routes.ts` (4)

```
60: if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
82: if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
108: if ('billingNotes' in customerData && req.authenticatedUserRole !== 'billing_manager') {
131: if (req.authenticatedUserRole !== 'company_admin') {
```

### `artifacts/api-server/src/routes/estimate-role-guards.ts` (1)

```
162: if (r.authenticatedUserRole === "super_admin") return true;
```

### `artifacts/api-server/src/routes/estimate-routes.ts` (15)

```
215: userRole !== "company_admin" &&
216: userRole !== "billing_manager" &&
217: userRole !== "super_admin" &&
218: userRole !== "irrigation_manager"
267: if (userRole === "super_admin") return true;
343: role === "super_admin" && String(req.query?.includeDeleted ?? "") === "1";
373: if (userRole === "super_admin") {
405: if (userRole === "super_admin") {
646: const canRenameNumber = role === "super_admin" || role === "company_admin";
1152: if (role !== "company_admin" && role !== "super_admin") {
1247: if (role !== "company_admin" && role !== "super_admin") {
1810: role === "irrigation_manager" || role === "company_admin" || role === "super_admin";
2395: (u) => u.role === "company_admin" && u.companyId === estimate.companyId,
2671: (u.role === "company_admin" || u.role === "irrigation_manager") &&
2757: (u.role === "company_admin" || u.role === "irrigation_manager") &&
```

### `artifacts/api-server/src/routes/financial-pulse.ts` (1)

```
135: if (role === "super_admin") {
```

### `artifacts/api-server/src/routes/invoice-correction-routes.ts` (7)

```
236: req.authenticatedUserRole === "super_admin"
329: req.authenticatedUserRole === "super_admin"
378: req.authenticatedUserRole === "super_admin"
475: req.authenticatedUserRole === "super_admin"
571: req.authenticatedUserRole === "super_admin"
980: req.authenticatedUserRole === "super_admin"
1082: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/invoice-editability-routes.ts` (7)

```
194: req.authenticatedUserRole === "super_admin"
289: req.authenticatedUserRole === "super_admin"
324: req.authenticatedUserRole === "super_admin"
392: req.authenticatedUserRole === "super_admin"
636: req.authenticatedUserRole === "super_admin"
769: req.authenticatedUserRole === "super_admin"
874: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/invoice-mark-sent-routes.ts` (2)

```
47: req.authenticatedUserRole === "super_admin"
91: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/invoice-merge-routes.ts` (1)

```
60: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/invoice-sync-quickbooks-route.ts` (1)

```
89: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/irrigation-profile-routes.ts` (18)

```
57: return !!role && (WRITE_ROLES.has(role) || role === "field_tech");
61: return role === "super_admin";
161: if (role !== "company_admin" && role !== "super_admin") {
237: if (!isManagerRole(role) && role !== "field_tech") {
308: if (role === "field_tech") {
376: if (!isManagerRole(role) && role !== "field_tech") {
405: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
477: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
517: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
563: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
602: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
724: if (!WRITE_ROLES.has(role ?? "") || role === "field_tech") {
836: if (!role || !MANAGER_ROLES.has(role) || role === "billing_manager") {
1000: if (!role || !MANAGER_ROLES.has(role) || role === "billing_manager") {
1340: if (!isManagerRole(role) && role !== "field_tech") {
1381: if (!canWrite(role) || role === "field_tech") {
1450: if (!canWrite(role) || role === "field_tech") {
1492: if (!canWrite(role) || role === "field_tech") {
```

### `artifacts/api-server/src/routes/manager-workspace-routes.ts` (12)

```
154: if (role === "super_admin") {
168: const all = await storage.getWorkOrders(role === "super_admin" ? null : cid);
169: if (role === "super_admin") return all as any[];
182: const all = await storage.getAllBillingSheets(role === "super_admin" ? null : cid);
183: if (role === "super_admin") return all as any[];
201: if (cid == null && role !== "super_admin") return [];
209: if (cid == null && role !== "super_admin") return [];
355: const isBillingManager = role === "billing_manager";
479: (w.approvedByRole !== "irrigation_manager");
558: (s.approvedByRole !== "irrigation_manager");
634: (w.approvedByRole !== "irrigation_manager");
951: const isBillingManager = role === "billing_manager";
```

### `artifacts/api-server/src/routes/parts-routes.ts` (8)

```
77: if (userRole !== 'billing_manager' && userRole !== 'company_admin') {
163: const billingManagers = companyUsers.filter(u => u.role === 'billing_manager');
657: if (userRole !== 'company_admin' && userRole !== 'billing_manager' && userRole !== 'irrigation_manager') {
1022: if (userRole !== 'billing_manager' && userRole !== 'company_admin' && userRole !== 'super_admin') {
1033: if (userRole !== 'super_admin' && companyId !== null && existingPart.companyId !== companyId) {
1055: if (userRole !== 'billing_manager' && userRole !== 'company_admin') {
1073: if (userRole !== 'billing_manager' && userRole !== 'company_admin' && userRole !== 'super_admin') {
1084: if (userRole !== 'super_admin' && companyId !== null && existingReview.companyId !== companyId) {
```

### `artifacts/api-server/src/routes/qb-payment-sync.ts` (2)

```
485: role === "super_admin"
495: const force = role === "super_admin" && req.body?.force === true;
```

### `artifacts/api-server/src/routes/routes.ts` (199)

```
165: if (role && role !== 'field_tech') return data;
168: if (effectiveRole !== 'field_tech') return data;
444: if (userRole !== 'company_admin') {
464: if (userRole !== 'company_admin' && userRole !== 'super_admin' && userRole !== 'billing_manager') {
511: if (userRole !== 'company_admin' && userRole !== 'billing_manager' && userRole !== 'irrigation_manager') {
530: if (userRole === 'company_admin' || userRole === 'super_admin' || userRole === 'billing_manager' || userRole === 'irr...
535: if (userRole === 'field_tech') {
625: if (userRole === 'company_admin' || userRole === 'super_admin' || userRole === 'billing_manager' || userRole === 'irr...
631: if (userRole === 'field_tech') {
767: if (!actor || actor.role !== 'super_admin' || !actor.isActive) {
772: if (!target || !target.isActive || target.role === 'super_admin') {
920: if (userRole !== 'company_admin' && userRole !== 'irrigation_manager' && userRole !== 'field_tech') {
1212: const isSuper = req.authenticatedUserRole === "super_admin";
1231: const isSuper = req.authenticatedUserRole === "super_admin";
1247: const callerCompanyIdActivity = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authentic...
1259: const isSuper = role === "super_admin";
1287: const isSuper = req.authenticatedUserRole === "super_admin";
1556: if (role !== "super_admin" && role !== "company_admin") {
1651: if (req.authenticatedUserRole !== "super_admin") {
4186: if (target.role === "super_admin") {
4457: if (userRole !== 'super_admin') {
4473: if (userRole !== 'super_admin' && userRole !== 'company_admin') {
4493: if (userRole !== 'super_admin') {
4544: if (userRole !== 'company_admin' || userCompanyId !== companyId) {
4577: if (userRole !== 'company_admin' || userCompanyId !== companyId) {
4597: if (userRole !== 'company_admin' || userCompanyId !== companyId) {
4635: if (userRole !== 'company_admin' && userRole !== 'super_admin') {
4660: if (userRole !== 'company_admin' && userRole !== 'super_admin') {
4697: if (userRole !== 'company_admin' && userRole !== 'super_admin') {
4760: if (userRole === 'company_admin' && userCompanyId) {
4783: if (userRole !== 'super_admin') {
4846: if (req.authenticatedUserRole !== 'super_admin') {
4891: .filter(user => (user.role === 'field_tech' || user.role === 'irrigation_manager') && user.isActive)
4903: if (req.authenticatedUserRole !== 'super_admin') {
4931: if (callerRole !== 'super_admin' && before && before.companyId !== callerCompanyId) {
4937: if (userData.role && userData.role !== before?.role && callerRole !== 'super_admin') {
5112: if (callerRolePatch !== 'super_admin' && before && before.companyId !== callerCompanyIdPatch) {
5117: if (userData.role && userData.role !== before?.role && callerRolePatch !== 'super_admin') {
5152: if (userRole === 'super_admin') {
5164: } else if (userRole === 'company_admin' && userCompanyId) {
5221: if (callerRolePost !== 'super_admin' && callerRolePost !== 'company_admin') {
5226: if (callerRolePost !== 'super_admin' && callerCompanyIdPost !== companyId) {
5232: if (newRole && callerRolePost !== 'super_admin') {
5302: if (callerRolePut !== 'super_admin' && callerRolePut !== 'company_admin') {
5307: if (callerRolePut !== 'super_admin' && callerCompanyIdPut !== companyId) {
5321: if (userData.role && userData.role !== existingUser?.role && callerRolePut !== 'super_admin') {
6018: if (req.authenticatedUserRole !== 'super_admin') {
6048: if (callerRoleCustomers !== 'super_admin' && !req.authenticatedUserCompanyId) {
6052: const callerCidCustomers: number | undefined = callerRoleCustomers === 'super_admin'
6101: const callerCompanyId6058 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
6240: const callerCompanyId6320 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
6392: const callerCompanyId6457 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
6683: const callerCompanyId6746 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
7204: const isSuperAdmin = callerRole === 'super_admin';
7512: if (req.authenticatedUserRole !== "super_admin") {
7529: if (req.authenticatedUserRole !== "super_admin") {
7735: if (role !== 'super_admin') {
7865: const callerCompanyId7414 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
7877: const callerCompanyId7425 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
8155: if (callerRoleParts !== 'super_admin' && !req.authenticatedUserCompanyId) {
8159: const callerCidParts: number | null = callerRoleParts === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? n...
9613: const callerCompanyIdComplete0 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenti...
9916: const managerUsers = managers.filter(u => u.role === "irrigation_manager" || u.role === "admin");
9958: const callerCompanyIdComplete1 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenti...
9999: const managerUsers = managers.filter(u => u.role === "irrigation_manager" || u.role === "admin");
10074: if (role === "super_admin") {
10113: if (_invoiceCallerRole !== 'super_admin' && !(req as any).authenticatedUserCompanyId) {
10117: const callerCompanyId9543 = _invoiceCallerRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ??...
10199: if (callerRoleWcb !== 'super_admin' && !req.authenticatedUserCompanyId) {
10203: const callerCidWcb: number | null = callerRoleWcb === 'super_admin' ? null : (req.authenticatedUserCompanyId ?? null);
10222: if (wcbCallerRole !== 'super_admin' && !req.authenticatedUserCompanyId) {
10226: const wcbCallerCompanyId: number | null = wcbCallerRole === 'super_admin' ? null : (req.authenticatedUserCompanyId ??...
10253: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
10294: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
10357: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin") {
10387: if (role !== "billing_manager" && role !== "irrigation_manager" && role !== "company_admin" && role !== "super_admin") {
10395: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
10438: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
10445: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
10489: if (_bsCallerRole !== 'super_admin' && !(req as any).authenticatedUserCompanyId) {
10493: const callerCompanyId9680 = _bsCallerRole === 'super_admin' ? null : ((req as any).authenticatedUserCompanyId ?? null);
10517: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
10526: const isSuperAdmin = role === 'super_admin';
10649: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
10666: const isSuperAdmin = role === 'super_admin';
10870: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
10881: const callerCompanyId10063 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
10891: const isSuperAdmin = role === 'super_admin';
10931: if (role !== 'company_admin' && role !== 'super_admin') {
10949: const callerCompanyId10130 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
10963: const isSuperAdmin = role === 'super_admin';
11117: const callerCompanyId10307 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
11140: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
11147: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
11174: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
11181: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
11215: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
11222: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
11257: const isSuper = req.authenticatedUserRole === "super_admin";
11286: if (req.authenticatedUserRole !== 'super_admin') {
11311: creatorRole === 'irrigation_manager' ||
11312: creatorRole === 'billing_manager' ||
11313: creatorRole === 'company_admin' ||
11314: creatorRole === 'super_admin'
11317: } else if (creatorRole === 'field_tech') {
11517: u.role === "company_admin" || u.role === "irrigation_manager"
11565: const billingManagers = allUsers.filter(u => u.role === 'billing_manager');
11609: const callerCompanyId10641 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
11618: patchUserRole !== 'company_admin' && patchUserRole !== 'super_admin' && patchUserRole !== 'billing_manager') {
11815: const bsPatchCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUse...
11869: const bsSubmitCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUs...
11915: const billingManagers = companyUsers.filter(u => u.role === 'billing_manager');
12033: const callerCompanyId11065 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12219: const callerCompanyId11217 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12288: const callerCompanyId11278 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12315: const callerCompanyId11304 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12386: const callerCompanyId11380 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12430: if (userRole === 'field_tech') {
12435: const callerCompanyIdTech = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticated...
12445: const callerCompanyIdWoList = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticat...
12475: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
12480: const callerCompanyIdMissingWo = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenti...
12541: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
12552: const callerCompanyIdWoNoPhotos = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authent...
12583: if (role !== 'company_admin' && role !== 'super_admin' && role !== 'irrigation_manager' && role !== 'billing_manager') {
12594: const callerCompanyIdWoClear = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authentica...
12616: const callerCompanyIdWoGet = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
12685: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
12692: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
12717: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
12724: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
12749: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
12756: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
12780: if (role !== "billing_manager" && role !== "company_admin" && role !== "super_admin" && role !== "irrigation_manager") {
12787: const companyId: number | null = role === "super_admin" ? null : (req.authenticatedUserCompanyId ?? null);
12842: if (createRole !== 'super_admin') {
12894: if (createRole === 'super_admin' && workOrderData.customerId) {
12989: const callerCompanyIdWoPatch = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authentica...
12998: woUpdateUserRole !== 'company_admin' && woUpdateUserRole !== 'super_admin' && woUpdateUserRole !== 'billing_manager') {
13289: const bulkDelCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUse...
13333: const singleDelCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedU...
13474: const assignCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUser...
13547: const callerCompanyId12330 = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticate...
13596: return role === 'company_admin' || role === 'billing_manager' || role === 'super_admin';
13646: if (actor.role === 'super_admin') {
13696: if (actor.role === 'super_admin' && body.companyId !== undefined) {
13754: if (actor.role === 'super_admin') {
13795: if (actor.role === 'super_admin' && body.companyId !== undefined) {
13826: return role === 'company_admin'
13827: || role === 'super_admin'
13828: || role === 'billing_manager'
13829: || role === 'irrigation_manager';
13856: if (role !== 'super_admin') {
13863: const sheet = await storage.getBillingSheetById(parentId, role === 'super_admin' ? null : scopeCompanyId);
13877: const wo = await storage.getWorkOrder(parentId, role === 'super_admin' ? null : scopeCompanyId);
13896: role === 'super_admin' ? null : scopeCompanyId,
13923: return role === 'company_admin'
13924: || role === 'super_admin'
13925: || role === 'billing_manager'
13926: || role === 'irrigation_manager';
13952: if (role !== 'super_admin') {
13958: const sheet = await storage.getBillingSheetById(ticketId, role === 'super_admin' ? null : scopeCompanyId);
13970: const wo = await storage.getWorkOrder(ticketId, role === 'super_admin' ? null : scopeCompanyId);
13987: role === 'super_admin' ? null : scopeCompanyId,
14022: const bsCreateCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUs...
14051: creatorRole === 'irrigation_manager' ||
14052: creatorRole === 'billing_manager' ||
14053: creatorRole === 'company_admin' ||
14054: creatorRole === 'super_admin'
14057: } else if (creatorRole === 'field_tech') {
14276: const bsGetCompanyId = (req as any).authenticatedUserRole === 'super_admin' ? null : ((req as any).authenticatedUserC...
14517: if (user.role === "super_admin") return true;
15040: if (req.authenticatedUserRole !== 'super_admin') {
15869: role === "field_tech" || role === "irrigation_manager" || role === "company_admin" || role === "super_admin" || role ...
15873: role === "irrigation_manager" || role === "company_admin" || role === "super_admin" || role === "billing_manager";
15897: userRole === "company_admin" ||
15898: userRole === "irrigation_manager" ||
15899: userRole === "billing_manager" ||
15900: userRole === "super_admin"
15932: if (req.authenticatedUserRole === "super_admin") {
16238: const isSuperAdmin = req.authenticatedUserRole === "super_admin";
16478: role !== "company_admin" &&
16479: role !== "super_admin" &&
16480: role !== "irrigation_manager" &&
16481: role !== "billing_manager"
16488: if (role !== "super_admin") {
16554: req.authenticatedUserRole !== "company_admin" &&
16555: req.authenticatedUserRole !== "super_admin" &&
16556: req.authenticatedUserRole !== "irrigation_manager" &&
16557: req.authenticatedUserRole !== "billing_manager"
16590: req.authenticatedUserRole !== "company_admin" &&
16591: req.authenticatedUserRole !== "super_admin" &&
16592: req.authenticatedUserRole !== "irrigation_manager"
16692: req.authenticatedUserRole !== "company_admin" &&
16693: req.authenticatedUserRole !== "super_admin" &&
16694: req.authenticatedUserRole !== "irrigation_manager"
17894: if (role !== "company_admin" && role !== "super_admin") {
18045: role === "company_admin" || role === "super_admin";
18090: if (role !== "company_admin" && role !== "super_admin") {
```

### `artifacts/api-server/src/routes/site-map-routes.ts` (3)

```
40: if (callerRole !== 'super_admin' && callerCompanyId != null) {
65: if (callerRole !== 'super_admin' && callerCompanyId != null) {
88: if (callerRole !== 'super_admin' && callerCompanyId != null) {
```

### `artifacts/api-server/src/routes/wet-check-photo-attach-route.ts` (1)

```
150: const isSuperAdmin = role === "super_admin";
```

### `artifacts/api-server/src/routes/wet-check-reconciliation-routes.ts` (4)

```
320: if (role === "super_admin") {
369: if (role !== "super_admin" && !callerCid) {
384: if (role !== "super_admin" && wc.companyId !== callerCid) {
421: if (role !== "super_admin" && targetCustomer.companyId !== callerCid) {
```

### `artifacts/api-server/src/routes/work-order-list-route.ts` (1)

```
32: req.authenticatedUserRole === "super_admin"
```

### `artifacts/api-server/src/routes/work-order-tenant-guard.ts` (1)

```
27: if (role === 'super_admin') {
```

### `artifacts/api-server/src/routes/work-order-zone-route.ts` (1)

```
55: if (role !== "field_tech") return true;
```
