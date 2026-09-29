import { ApiError, handle } from "@/lib/api";
import { runCounterfactuals } from "@/lib/counterfactual";
import { getAttemptWithScenario, getReport, snapshotForAttempt } from "@/lib/db/queries";
import { deserializeEngineState } from "@/lib/engine-state";
import { hydrateAttempt } from "@/lib/negotiation";
import { assertAttemptAccess, readOwnerId } from "@/lib/ownership";
import { packageTotal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Counterfactual replays for a finished attempt.
 *
 * Computed entirely server-side against the scenario's hidden economics — the
 * browser receives only outcomes, so the alternatives are measurable without
 * being able to read the answer off the wire.
 *
 * Available only once the attempt has been SCORED, and shaped to exactly what
 * the panel renders.
 *
 * The alternatives are simulated against the real band — the simulation stops
 * accepting at the company's bar and caps its anchors by the envelope — so the
 * modeled results bracket the hidden economics, and the plan objects carry the
 * simulation's own thresholds. Those thresholds ARE the hidden acceptance bar
 * whenever the company's floor sits above the candidate's public prep number.
 * Two things follow: the browser gets modeled outcomes only, never the model's
 * parameters (it has no use for them), and the endpoint is not available
 * mid-call, when a bracket on the bar would be worth reading off the wire.
 *
 * The panel lives on the report page, which only renders once the report exists.
 */
export const GET = handle(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    const { attempt, scenario } = await getAttemptWithScenario(id);
    assertAttemptAccess(attempt, ownerId, "read");
    const scored = await getReport(id).catch(() => null);
    if (!scored) {
      throw new ApiError(409, "The counterfactual is available once the attempt has been scored.");
    }
    const { effectiveHidden } = hydrateAttempt(attempt, scenario);
    const engine = deserializeEngineState(attempt.engine_state);
    const finalOffer = attempt.final_offer ?? engine?.currentOffer ?? null;
    const actual = finalOffer
      ? { total: packageTotal(finalOffer), base: finalOffer.base, outcome: attempt.outcome ?? null }
      : null;

    // The alternatives are modeled against the prep guidance this call was run
    // with (the snapshot), so an edit to the scenario cannot retroactively change
    // what an already-recorded attempt "could have" achieved.
    const snapshot = snapshotForAttempt(attempt, scenario);
    const report = runCounterfactuals(effectiveHidden, {
      prepTarget: snapshot.prep_pack?.your_target ?? null,
      prepReservation: snapshot.prep_pack?.your_reservation ?? null,
      actual,
    });

    // Project to the fields the panel renders. `plan` otherwise carries the
    // simulation's inputs (`acceptAtOrAboveTotal`, `anchor`, `leverageAmount`),
    // and `turns` carries the scripted lines — internal parameters a candidate
    // should not be reading, and which the UI does not display.
    const results = report.results.map((r) => ({
      plan: { key: r.plan.key, label: r.plan.label, summary: r.plan.summary },
      finalPackage: r.finalPackage,
      finalBase: r.finalBase,
      finalTotal: r.finalTotal,
      outcome: r.outcome,
      rounds: r.rounds,
      deltaBase: r.deltaBase,
      deltaTotal: r.deltaTotal,
    }));

    return Response.json({
      counterfactual: { actual: report.actual, results, disclaimer: report.disclaimer },
    });
  },
);
