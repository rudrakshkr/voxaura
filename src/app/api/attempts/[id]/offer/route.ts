import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import {
  applyRecruiterPackage,
  deserializeEngineState,
  initialEngineState,
  serializeEngineState,
} from "@/lib/engine-state";
import {
  consumeAuthorizationTx,
  insertEventsTx,
  loadAttemptWithScenarioTx,
  setAttemptEngineStateTx,
  setAttemptOutcomeIfAcceptedTx,
  withAttemptLock,
} from "@/lib/db/queries";
import { hydrateAttempt } from "@/lib/negotiation";
import {
  acceptsPackage,
  extractSpokenPackage,
  packageAnomaly,
  reconcileSpokenPackage,
  withinPackageLimits,
  type SpokenPackage,
} from "@/lib/negotiation-engine";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { clampEventAtMs, type CompPackage } from "@/lib/types";

export const dynamic = "force-dynamic";

const PackageSchema = z.object({
  base: z.number().int().min(0).max(10_000_000),
  sign_on: z.number().int().min(0).max(10_000_000).nullish(),
  equity: z.number().min(0).max(10_000_000).nullish(),
});

const BodySchema = z
  .object({
    agent_text: z.string().max(4000).nullish(),
    /**
     * The structured arguments of an `offer_to_candidate` tool call.
     *
     * This is a CLAIM about what the recruiter said, not a decision: it only
     * becomes an authoritative engine change when it exactly matches a
     * single-use authorization the server issued for this attempt.
     */
    package: PackageSchema.nullish(),
    /** Conditions/notes attached to the offer, shown on the panel. */
    conditions: z.array(z.string().min(1).max(160)).max(3).nullish(),
    /**
     * The recruiter agreeing to the CANDIDATE's package. A REQUEST: the server
     * re-evaluates the package against the authoritative economics AND requires a
     * matching accept authorization, so a browser cannot manufacture a deal.
     */
    accept_candidate_package: PackageSchema.nullish(),
    /**
     * Proof, issued by `/turn`, that the server itself decided this exact
     * recruiter action. Bound to the attempt, the action and the package.
     */
    authorization_token: z.string().min(16).max(200).nullish(),
    // Call-elapsed milliseconds, clamped before insert (see clampEventAtMs): a
    // naive client sending Date.now() epoch-millis would overflow the 4-byte
    // integer column.
    at_ms: z.number().int().min(0).nullish(),
  })
  .refine(
    (b) =>
      Boolean(b.agent_text) ||
      Boolean(b.package) ||
      Boolean(b.accept_candidate_package),
    { message: "agent_text, package or accept_candidate_package is required" },
  );

/** Normalize a client-supplied package into whole dollars. */
function cleanPackage(p: z.infer<typeof PackageSchema>): CompPackage {
  return {
    base: Math.round(p.base),
    sign_on: p.sign_on != null ? Math.round(p.sign_on) : 0,
    equity: p.equity != null ? Math.round(p.equity) : 0,
  };
}

/** Build the package a spoken sentence implies, filling unspoken components. */
function packageFromSpoken(spoken: SpokenPackage, cur: CompPackage): CompPackage {
  return {
    base: spoken.base ?? cur.base,
    sign_on: spoken.sign_on ?? (cur.sign_on ?? 0),
    equity: spoken.equity ?? (cur.equity ?? 0),
  };
}

/**
 * Reconcile what the recruiter actually said (or called offer_to_candidate with)
 * against the server's authorization.
 *
 * The trust rule is now explicit, because the old one was exploitable: the
 * browser can call this endpoint with any `package` or
 * `accept_candidate_package`, so the ROUTE cannot treat that as truth. What the
 * browser legitimately holds is the token `/turn` issued when the engine decided
 * the move — bound to this attempt, this action and these exact figures. An
 * authoritative mutation therefore requires a matching, unused, unexpired token;
 * everything else is recorded as an OBSERVATION for the report and the panel, and
 * changes no economics.
 *
 * Two consequences worth stating:
 * - A recruiter who improvises a package can no longer rewrite the engine state
 *   from the browser. The deviation is written as a `voice_engine_inconsistency`
 *   event (server-authored, scoring-relevant) and the panel is corrected to the
 *   authoritative figures, so the audio, the panel and the settlement cannot
 *   silently disagree.
 * - An acceptance can only be recorded for a package the engine authorized, so
 *   `accept_candidate_package: {base: 999999}` can never finalize an attempt.
 */
export const POST = handle(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const body = BodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError(400, "Invalid offer payload");

    const ownerId = await readOwnerId();
    const atMs = clampEventAtMs(body.data.at_ms);
    const text = body.data.agent_text?.trim() ?? "";
    const conditions = (body.data.conditions ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, 3);

    const result = await withAttemptLock(id, async (tx) => {
      const { attempt, scenario } = await loadAttemptWithScenarioTx(tx, id);
      assertAttemptAccess(attempt, ownerId, "write");

      // An attempt the engine already settled is closed to mutations — but the
      // recruiter's `accept_user_offer` tool call arrives immediately AFTER the
      // turn that settled it, so a repeat of the SAME agreed package is answered
      // idempotently instead of 409-ing (which would make the client show a
      // spurious "not validated" notice on a deal that was in fact agreed).
      if (attempt.status !== "active") {
        const requestedAccept = body.data.accept_candidate_package
          ? cleanPackage(body.data.accept_candidate_package)
          : null;
        const alreadyAgreed =
          attempt.status === "completed" &&
          attempt.outcome === "accepted" &&
          attempt.final_offer != null;
        if (alreadyAgreed && requestedAccept) {
          // The deal is settled, so this is a CONFIRMATION, not a request: the
          // figures in the reply come from the row, never from the request, and
          // nothing is mutated. Requiring an exact match used to 409 here when
          // the recruiter's model echoed `accept_user_offer` with a rounded or
          // partially-stated package, which surfaced "the engine did not
          // validate that agreement" on a deal that HAD been agreed — and
          // cleared the accepted banner on the client with it.
          return {
            offer: attempt.final_offer!,
            changed: false,
            correction: false,
            authoritative: true,
            notice: null,
            conditions: null,
            accepted: true,
            accept_reason: null,
            inconsistency_recorded: false,
            deferral: null,
          };
        }
        throw new ApiError(409, "Attempt is no longer active");
      }

      const { effectiveHidden: hidden } = hydrateAttempt(attempt, scenario);
      const state = deserializeEngineState(attempt.engine_state) ?? initialEngineState(hidden);

      const spoken: SpokenPackage = body.data.package
        ? {
            base: body.data.package.base > 0 ? body.data.package.base : null,
            sign_on: body.data.package.sign_on ?? null,
            equity: body.data.package.equity ?? null,
            total: null,
          }
        : extractSpokenPackage(text);
      const reconciled = reconcileSpokenPackage(hidden, state, spoken);

      const standingBefore: CompPackage = { ...state.currentOffer };
      const events: Parameters<typeof insertEventsTx>[2] = [];
      let notice: string | null = null;
      let authoritative = false;
      let accepted = false;
      let acceptReason: string | null = null;
      let inconsistency = false;

      const requestedAccept = body.data.accept_candidate_package
        ? cleanPackage(body.data.accept_candidate_package)
        : null;
      const action: "offer" | "accept" = requestedAccept ? "accept" : "offer";
      const submitted: CompPackage | null = requestedAccept
        ? requestedAccept
        : reconciled
          ? reconciled.pkg
          : null;

      let authorizationOk = false;
      if (body.data.authorization_token && submitted) {
        const consumed = await consumeAuthorizationTx(tx, {
          attemptId: id,
          token: body.data.authorization_token,
          action,
          package: submitted,
          conditions,
        });
        authorizationOk = consumed.ok;
        if (!consumed.ok) {
          console.warn(
            `[offer] refused an unauthorized ${action} for attempt ${id}: ${consumed.reason}`,
          );
        }
      }


      if (authorizationOk && action === "accept" && submitted) {
        // The engine already decided this acceptance, so the predicate must hold.
        if (acceptsPackage(hidden, submitted)) {
          applyRecruiterPackage(state, hidden, submitted);
          accepted = true;
          authoritative = true;
          events.push({
            type: "acceptance",
            actor: "opponent",
            source: "tool",
            payload: {
              package: submitted,
              impact: "strong",
              authorized: true,
              note: "engine-validated acceptance of the candidate's package",
            },
            at_ms: atMs,
          });
        } else {
          const overCaps = !withinPackageLimits(hidden, submitted);
          acceptReason = overCaps
            ? "the package is beyond what the band can authorize"
            : "the base is below what the band can support";
          events.push({
            type: "voice_engine_inconsistency",
            actor: "opponent",
            source: "tool",
            payload: {
              impact: "risky",
              note: "an authorized acceptance did not satisfy the hard caps",
              requested: submitted,
              standing: state.currentOffer,
              over_caps: overCaps,
            },
            at_ms: atMs,
          });
          inconsistency = true;
        }
      } else if (authorizationOk && action === "offer" && submitted) {
        // Authorized package. `/turn` normally already put it on the table (the
        // engine owns the move), so this is usually a confirmation; it applies
        // only if it genuinely differs, which keeps one move to one event.
        const changed =
          submitted.base !== state.currentOffer.base ||
          (submitted.sign_on ?? 0) !== (state.currentOffer.sign_on ?? 0) ||
          (submitted.equity ?? 0) !== (state.currentOffer.equity ?? 0);
        if (changed) {
          applyRecruiterPackage(state, hidden, submitted);
          events.push({
            type: "opponent_offer",
            actor: "opponent",
            source: "tool",
            payload: {
              package: submitted,
              conditions: conditions.length > 0 ? conditions : null,
              authorized: true,
              note: "recruiter stated an engine-authorized package",
            },
            at_ms: atMs,
          });
        }
        authoritative = true;
      } else if (requestedAccept) {
        // No valid authorization: NEVER complete the attempt on a browser
        // assertion. The refusal is reported so the model can correct itself.
        acceptReason =
          "the agreement was not authorized by the negotiation engine for these exact figures";
        notice =
          "The platform did not authorize that agreement — the numbers were not confirmed.";
      } else if (reconciled && reconciled.changed && submitted) {
        // The recruiter said something the engine did not authorize. Correct the
        // panel to the authoritative figures and change NO economics.
        const { overCeiling, belowOpening } = packageAnomaly(hidden, submitted);
        // A durable event is written when the figure is genuinely anomalous (an
        // over-promise the candidate heard, which belongs in the report) or when
        // a token was presented and did not match (a real server/browser
        // disagreement about authorized numbers). A merely different, plausible
        // figure with no token is corrected in the UI only — that case is what an
        // ordinary reconciliation race looks like, and logging it would put a
        // phantom "inconsistency" in the report for a legitimate offer.
        inconsistency = overCeiling || belowOpening || Boolean(body.data.authorization_token);
        if (inconsistency) {
          events.push({
            type: "voice_engine_inconsistency",
            actor: "opponent",
            source: "tool",
            payload: {
              impact: "risky",
              note: "the recruiter spoke a package the engine did not authorize",
              spoken: submitted,
              previous: standingBefore,
              over_ceiling: overCeiling,
              below_opening: belowOpening,
              unauthorized: true,
            },
            at_ms: atMs,
          });
        }
        notice =
          "The recruiter's spoken figure was not authorized by the negotiation engine; the offer panel shows the package actually on the table.";
      }

      // The browser may report what the recruiter said, but it must never be
      // allowed to create an authoritative engine transition from that text.
      // Recruiter deferral is decided by the authoritative `/turn` engine, not
      // by an arbitrary client call to `/offer`.
      const stateChanged =
        accepted ||
        state.currentOffer.base !== standingBefore.base ||
        (state.currentOffer.sign_on ?? 0) !== (standingBefore.sign_on ?? 0) ||
        (state.currentOffer.equity ?? 0) !== (standingBefore.equity ?? 0);

      await setAttemptEngineStateTx(tx, id, serializeEngineState(state));
      if (events.length > 0) {
        // Only the authorized path may write an economics event; a diagnostic
        // inconsistency is server-authored too, so the whole batch is
        // authoritative (no client-supplied claim reaches the scorer as fact).
        await insertEventsTx(tx, id, events, { authoritative: true });
      }
      if (accepted) await setAttemptOutcomeIfAcceptedTx(tx, id, state.currentOffer, conditions);

      return {
        offer: state.currentOffer,
        changed: stateChanged,
        correction: inconsistency,
        authoritative,
        notice,
        conditions: conditions.length > 0 ? conditions : null,
        accepted,
        accept_reason: acceptReason,
        inconsistency_recorded: inconsistency,
        deferral: null,
      };
    });

    return Response.json(result);
  },
);