import type { NegotiationEvent } from "./types";

/**
 * Deterministic replay narration.
 *
 * A timeline of "Recruiter countered with $152k base" tells the candidate what
 * happened and nothing about whether it was good, what it cost, or what to do
 * instead. The most useful part of a replay is the *economic* read: this move
 * moved the first-year total by $X, this one gave away information for free,
 * this one is where the recruiter stopped moving.
 *
 * Narration is computed from the event log — no LLM, no hidden state — so the
 * replay can never contradict the numbers it is describing, and it stays
 * available even when the scoring model is down.
 */

export type Impact = "strong" | "neutral" | "risky";

export interface ReplayStep {
  seq: number | null;
  atMs: number | null;
  actor: "user" | "opponent";
  type: string;
  impact: Impact;
  /** The move in a few words: "Countered with $152k base". */
  title: string;
  /** What happened, in plain language. */
  what: string;
  /** Why it mattered, in economic or strategic terms. */
  why: string;
  /** What the candidate could have done instead (null when the move was fine). */
  better: string | null;
  /** Change in the standing first-year total caused by this move. */
  deltaTotal: number | null;
  /** First-year total on the table after this move. */
  runningTotal: number | null;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function packageOf(e: NegotiationEvent): { base: number; sign_on: number; equity: number } | null {
  const pkg = (e.payload as { package?: { base?: number; sign_on?: number | null; equity?: number | null } })
    .package;
  if (!pkg || typeof pkg.base !== "number") return null;
  return { base: Math.round(pkg.base), sign_on: pkg.sign_on ?? 0, equity: pkg.equity ?? 0 };
}

const pkgTotal = (p: { base: number; sign_on: number; equity: number }) => p.base + p.sign_on + p.equity;

function pkgPhrase(p: { base: number; sign_on: number; equity: number }): string {
  const parts = [`${money(p.base)} base`];
  if (p.sign_on > 0) parts.push(`${money(p.sign_on)} sign-on`);
  if (p.equity > 0) parts.push(`${money(p.equity)}/yr equity`);
  return parts.join(" + ");
}

function impactOf(e: NegotiationEvent): Impact {
  const explicit = (e.payload as { impact?: string }).impact;
  if (explicit === "strong" || explicit === "risky" || explicit === "neutral") return explicit;
  if (e.type === "leverage_introduced" || e.type === "acceptance" || e.type === "package_trade") {
    return "strong";
  }
  if (
    e.type === "information_revealed" ||
    e.type === "missed_opportunity" ||
    e.type === "voice_engine_inconsistency" ||
    e.type === "interruption"
  ) {
    return "risky";
  }
  return "neutral";
}

/**
 * Turn the raw event log into an ordered, narrated replay.
 * Events with no time are ordered by their seq, which is the server's order.
 */
export function buildReplay(events: NegotiationEvent[]): ReplayStep[] {
  const ordered = [...events]
    .filter((e) => e.type !== "rapport")
    .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));

  const steps: ReplayStep[] = [];
  let standing: { base: number; sign_on: number; equity: number } | null = null;

  for (const e of ordered) {
    const impact = impactOf(e);
    const pkg = packageOf(e);
    const note = typeof e.payload?.note === "string" ? e.payload.note : null;
    const amount = typeof e.payload?.amount === "number" ? e.payload.amount : null;
    const leverage = typeof e.payload?.leverage === "number" ? e.payload.leverage : null;
    const reveal =
      typeof e.payload?.reservation_reveal === "number" ? e.payload.reservation_reveal : null;

    let title = e.type.replace(/_/g, " ");
    let what = note ? `“${note}”` : "Recorded move.";
    let why = "";
    let better: string | null = null;
    let delta: number | null = null;
    let running: number | null = standing ? pkgTotal(standing) : null;

    if (pkg) {
      const before = standing;
      delta = before ? pkgTotal(pkg) - pkgTotal(before) : 0;
      standing = pkg;
      running = pkgTotal(pkg);
      const verb = pkg.base === 0 ? "offered" : delta > 0 ? "raised the offer to" : "restated";
      title = `${verb} ${pkgPhrase(pkg)}`;
      what = `First-year total on the table: ${money(pkgTotal(pkg))}.`;
      if (before) {
        why =
          delta > 0
            ? `This moved the total by ${money(delta)} (${Math.round((delta / Math.max(1, pkgTotal(before))) * 100)}%).`
            : "Same money, restated — a held line, not a concession.";
      } else {
        why = "This is the first package on the table, so it sets the frame for everything after.";
      }
    } else {
      switch (e.type) {
        case "user_offer":
          title = amount != null ? `Asked for ${money(amount)}` : "Made a numeric ask";
          what = amount != null ? `You named ${money(amount)}.` : "You asked for a number.";
          why =
            "Every ask is measured against the recruiter's band: an ask with no justification behind it is treated as pressure, and repeated identical asks end the concession flow.";
          better = "Attach a reason — scope, market data, a competing figure — to each ask.";
          break;
        case "leverage_introduced":
          title = leverage != null ? `Introduced leverage at ${money(leverage)}` : "Introduced leverage";
          what =
            leverage != null
              ? `You claimed competing leverage at ${money(leverage)}.`
              : "You claimed competing leverage.";
          why =
            "Leverage only moves money once it is verified: a specific figure plus corroborating detail (signed, written, expiry). A bare claim earns a question, not a raise.";
          better = "Name the figure, say it is in writing, and give a deadline.";
          break;
        case "leverage_challenged":
          title = "Leverage challenged";
          what = "The recruiter asked you to substantiate the claim.";
          why = "This is the verification step the engine requires before leverage is priced.";
          break;
        case "information_request":
          title = "Asked about flexibility";
          what = "You asked what was flexible.";
          why =
            "Extracting the recruiter's structure — which levers exist, which are tight — is cheap and high-value.";
          break;
        case "information_revealed":
          title = reveal != null ? `Revealed your floor (${money(reveal)})` : "Revealed information";
          what = reveal != null ? `You said you would accept ${money(reveal)}.` : "You volunteered a constraint.";
          why =
            "A stated floor becomes the ceiling for the whole conversation — the recruiter has no reason to pay above what you said you would take.";

          better = "Keep the floor private; state your target and your evidence instead.";
          break;
        case "concession":
          title = "Conceded";
          what = amount != null ? `You moved to ${money(amount)}.` : "You softened your position.";
          why = "A concession given without a matching gain is a transfer, not a trade.";
          better = "Ask for something specific in return — sign-on, equity, start date.";
          break;
        case "package_trade":
          title = "Proposed a trade";
          what = "You offered something in exchange for something.";
          why = "Trades are how a negotiation gets bigger without the recruiter conceding base.";
          break;
        case "walk_away":
          title = "Walked away";
          what = "You ended the negotiation.";
          why =
            "The engine allows one recovery move from a credible walk-away, but only when the candidate has already engaged or brought real evidence.";
          better = "Walk away only after the recruiter has stopped moving — and say why you are leaving.";
          break;
        case "objection_raised":
          title = "Raised an objection";
          what = note ? `“${note}”` : "You pushed back on a term.";
          why = "Objections buy information: the recruiter's answer reveals priorities.";
          break;
        case "pressure_tactic":
          title = "Applied pressure / the recruiter stalled";
          what = note ? `“${note}”` : "A pressure move was recorded.";
          why =
            "The recruiter has no off-screen team, so a deferral must be answered on the call — pressing for the decision is the correct response.";
          break;
        case "voice_engine_inconsistency":
          title = "Offer outside the modeled band";
          what = "The recruiter stated a package the company's approved economics did not authorize.";
          why =
            "The panel mirrors what was said; the report is where an over-promise is scored. It also means the spoken number should be challenged, in writing, before you rely on it.";
          better = "Ask for the number in the offer letter before agreeing.";
          break;
        case "acceptance":
          title = "Deal agreed";
          what = "The recruiter accepted a package.";
          why = "Acceptance is only recorded when the engine's own acceptance predicate says the economics work.";
          break;
        case "missed_opportunity":
          title = "Missed opportunity";
          what = "A lever was available and not used.";
          why = "Unused flexibility is value left on the table.";
          better = "Ask what else the package could include.";
          break;
        case "user_anchor":
          title = "Anchored";
          what = "You set the first number.";
          why = "The anchor is the single largest driver of where a negotiation lands.";
          break;
        default:
          what = note ? `“${note}”` : e.type.replace(/_/g, " ");
          break;
      }
    }

    steps.push({
      seq: e.seq ?? null,
      atMs: e.at_ms ?? null,
      actor: e.actor,
      type: e.type,
      impact,
      title,
      what,
      why,
      better,
      deltaTotal: delta,
      runningTotal: running,
    });
  }

  return steps;
}

/** The final first-year total the replay observed on the table. */
export function replayFinalTotal(steps: ReplayStep[]): number | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].runningTotal != null) return steps[i].runningTotal;
  }
  return null;
}
