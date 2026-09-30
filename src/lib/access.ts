import { ApiError } from "./api";
import type { AttemptRow } from "./db/queries";

/**
 * Who may read or write a row.
 *
 * Kept free of `next/headers` (unlike `ownership.ts`, which mints the cookie) so
 * the rule itself is a pure function that can be tested directly — this is the
 * module that decides whether one visitor can see another visitor's negotiation,
 * so it should not be verified only by reasoning about a route handler.
 */

/**
 * The owner id of the sample library.
 *
 * Rows that predate anonymous ownership — and the built-in seeds — carry this
 * sentinel rather than a NULL, so "public sample data" is an explicit, documented
 * state instead of an accident of a missing column value. The owner column is NOT
 * NULL on both tables.
 *
 * Sample rows are readable by everyone (a visitor following a shared link can
 * look at them) and, for SCENARIOS, editable and deletable like any other row:
 * the library is the starting material a candidate practises against, so being
 * unable to fix a seeded detail or remove a scenario you no longer want was
 * friction, not protection. Deleting one cascades to the attempts made against
 * it, and `npm run seed` restores the built-in library.
 *
 * ATTEMPTS do not follow the scenario rule: a sample call is written by nobody
 * (there is no way to identify who ran it) and must stay immutable, so
 * `assertAttemptAccess` keeps the old read-only rule.
 *
 * The value can never collide with a real owner id — ids are 48 hex characters
 * and this contains a `:` — so no browser can present it as its own identity.
 */
export const DEMO_OWNER_ID = "demo:sample-library";

/** True for the sample-library sentinel. */
export function isDemoOwner(ownerId: string | null | undefined): boolean {
  return ownerId === DEMO_OWNER_ID;
}

/**
 * How the caller means to use the row.
 *
 * Reads and writes are not the same privilege: a sample ATTEMPT is a public
 * artifact (a visitor can open a sample report) but an immutable one, so a write
 * to it is refused rather than quietly allowed. Scenarios no longer make that
 * distinction — see `assertScenarioAccess`.
 */
export type AccessMode = "read" | "write";

/** Assert the caller may operate on this attempt. */
export function assertAttemptAccess(
  attempt: Pick<AttemptRow, "owner_id">,
  ownerId: string | null,
  mode: AccessMode = "write",
): void {
  assertAccess(attempt, ownerId, "Attempt", mode);
}

/**
 * Scenarios carry an owner so a custom one stays its creator's: a foreign id
 * 404s rather than confirming that it exists.
 *
 * The sample library is the deliberate exception — those rows are public to
 * read AND to edit or delete, because they are the shared starting material the
 * product ships with. There is no per-visitor copy to own, and refusing the
 * write only produced a `read-only sample` error on a card the UI had already
 * offered actions for.
 */
export function assertScenarioAccess(
  scenario: { owner_id: string },
  ownerId: string | null,
  _mode: AccessMode = "write",
): void {
  if (isDemoOwner(scenario.owner_id)) return;
  if (scenario.owner_id !== ownerId) {
    // 404, not 403: a probe should not learn that the id exists.
    throw new ApiError(404, "Scenario not found");
  }
}

function assertAccess(
  row: { owner_id: string },
  ownerId: string | null,
  label: string,
  mode: AccessMode,
): void {
  if (isDemoOwner(row.owner_id)) {
    if (mode === "read") return;
    // 403 here, unlike the 404 below: sample rows are public by design, so
    // acknowledging that this one exists tells the caller nothing they could not
    // already read. This is the ATTEMPT rule (a demo call has no provable
    // author and must stay immutable); sample scenarios are editable by design.
    throw new ApiError(
      403,
      `This is a read-only sample ${label.toLowerCase()}. Create your own to experiment with it.`,
    );
  }
  if (row.owner_id !== ownerId) {
    // 404, not 403: a probe should not learn that the id exists.
    throw new ApiError(404, `${label} not found`);
  }
}
