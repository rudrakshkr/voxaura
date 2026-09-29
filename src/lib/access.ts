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
 * Sample rows are readable by everyone and writable by no one: they are the demo
 * library, so a visitor following a shared link can look at them, and nobody can
 * destroy them — or confuse them with their own history.
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
 * Reads and writes are not the same privilege: the sample library is a public
 * artifact (a visitor can open a sample report) but a read-only one, so a write
 * to a sample is refused rather than quietly allowed.
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
 * Scenarios carry an owner for the same reason attempts do: `DELETE /scenarios/:id`
 * cascades to every attempt, event and report made against the scenario, so an
 * anonymous visitor who can list the library must not be able to destroy it.
 */
export function assertScenarioAccess(
  scenario: { owner_id: string },
  ownerId: string | null,
  mode: AccessMode = "write",
): void {
  assertAccess(scenario, ownerId, "Scenario", mode);
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
    // already read — and the message is what the library UI would show.
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
