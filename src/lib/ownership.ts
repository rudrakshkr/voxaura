import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Anonymous attempt ownership.
 *
 * An attempt UUID is an identifier, not a credential: without an owner check,
 * anyone who sees a link (a shared report, a browser history entry, a leaked log
 * line) can read a transcript, inject events, or finalize someone else's deal.
 * This module mints an opaque, httpOnly owner id and reads it back.
 *
 * The rule that USES that identity — who may read or write a row — lives in
 * `access.ts`, so it can be tested without Next's request context.
 *
 * Kept deliberately simple for a hackathon MVP: no accounts, no login — just a
 * cookie that a browser cannot hand to another origin.
 */
export const OWNER_COOKIE = "voxaura_owner";
const OWNER_MAX_AGE_SEC = 60 * 60 * 24 * 180; // a demo visitor keeps their history

/**
 * Owner ids are minted as 48 lowercase hex characters. Nothing else is a valid
 * identity, which is what makes `DEMO_OWNER_ID` impossible to present as one.
 */
const OWNER_ID_RE = /^[0-9a-f]{48}$/;

export { DEMO_OWNER_ID, isDemoOwner } from "./access";
export {
  assertAttemptAccess,
  assertScenarioAccess,
  type AccessMode,
} from "./access";

function newOwnerId(): string {
  return randomBytes(24).toString("hex");
}

/**
 * The caller's owner id, if they already have one.
 *
 * The cookie is validated against the shape we mint; anything else is treated as
 * "no owner" rather than trusted. That is what stops a forged value — including
 * the demo sentinel — from being presented as an identity.
 */
export async function readOwnerId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(OWNER_COOKIE)?.value;
  return value && OWNER_ID_RE.test(value) ? value : null;
}

/**
 * The caller's owner id, minting one when absent. Safe in route handlers and
 * server actions, which are the only places Next allows a cookie write.
 */
export async function ensureOwnerId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(OWNER_COOKIE)?.value;
  if (existing && OWNER_ID_RE.test(existing)) return existing;
  const owner = newOwnerId();
  store.set({
    name: OWNER_COOKIE,
    value: owner,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: OWNER_MAX_AGE_SEC,
  });
  return owner;
}
