// Wire shape of a controller as returned by GET /api/properties/:customerId/controllers.
//
// Task #1857 retired the `property_controllers` table, so the `PropertyController`
// type that used to be exported from `@workspace/db/schema` no longer exists. The
// endpoint now reads `irrigation_controllers` and maps each row onto the same
// wire shape the wet-check UI has always consumed (`controllerLetter`/`zoneCount`
// rather than the table's `letter`/`totalZones`), so the frontend keeps a type of
// its own that describes exactly that response.
//
// `zoneCount` is nullable because it maps `irrigation_controllers.total_zones`,
// which is null until a controller's zone count has been recorded.
export interface CustomerController {
  id: number;
  companyId: number;
  customerId: number;
  /** null for the customer-level (non-branch) bucket. */
  branchName: string | null;
  controllerLetter: string;
  zoneCount: number | null;
  notes: string | null;
}
