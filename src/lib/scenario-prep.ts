import type { PrepPack } from "./types";

/**
 * Candidate-facing prep material: merging and validation.
 *
 * Kept pure and separate from the route (and free of `next/headers`) so the rule
 * that actually protects the data — "the stored prep pack must be valid after the
 * edit" — is testable directly.
 *
 * The bug this exists to prevent: `PATCH /api/scenarios/:id` validated only the
 * fields PRESENT in the request, so a partial edit could leave the row in a state
 * the full validator would have refused. Changing just `your_target` to a number
 * below the stored `your_reservation` slipped through, as did changing only
 * `your_reservation` upwards past the stored target — and the walk-away floor
 * sitting above the goal inverts the candidate's own coaching material.
 */

/** Bounds the editor enforces on the candidate's own prep numbers. */
export const PREP_TARGET_MIN = 60_000;
export const PREP_TARGET_MAX = 900_000;

/** The fields a candidate may edit. Hidden economics are never in here. */
export const PREP_PATCHABLE = [
  "context",
  "coaching_objective",
  "comp_notes",
  "your_target",
  "your_reservation",
] as const;

export type PrepPatch = Partial<
  Pick<PrepPack, "context" | "coaching_objective" | "comp_notes" | "your_target" | "your_reservation">
>;

/** Merge a partial edit into the stored prep pack. */
export function mergePrepPack(current: PrepPack, patch: PrepPatch): PrepPack {
  const merged: PrepPack = { ...current };
  for (const key of PREP_PATCHABLE) {
    const value = patch[key];
    if (value !== undefined) {
      // Indexed assignment keeps the union of field types intact.
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * Validate a prep pack as the FINAL state.
 *
 * Every check runs against the merged result, so a partial edit can never
 * produce a row that a full write would have rejected.
 */
export function prepPackError(merged: PrepPack): string | null {
  const money = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) &&
    v >= PREP_TARGET_MIN && v <= PREP_TARGET_MAX;
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  if (!text(merged.context)) return "Context is required";
  if (!text(merged.coaching_objective)) return "Coaching objective is required";
  if (!Array.isArray(merged.comp_notes) || merged.comp_notes.length === 0) {
    return "At least one comp note is required";
  }
  if (merged.comp_notes.some((n) => !text(n))) return "Comp notes cannot be blank";
  if (!money(merged.your_target)) {
    return `Your target must be a whole number between ${PREP_TARGET_MIN.toLocaleString("en-US")} and ${PREP_TARGET_MAX.toLocaleString("en-US")}`;
  }
  if (!money(merged.your_reservation)) {
    return `Your walk-away number must be a whole number between ${PREP_TARGET_MIN.toLocaleString("en-US")} and ${PREP_TARGET_MAX.toLocaleString("en-US")}`;
  }
  if (merged.your_reservation >= merged.your_target) {
    return "Walk-away number must be below your target";
  }
  return null;
}
