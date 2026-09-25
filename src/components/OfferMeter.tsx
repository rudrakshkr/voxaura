"use client";

import { money } from "./ui";
import type { CompPackage } from "@/lib/types";

/**
 * Authoritative package panel. Updates ONLY on formal offers
 * (offer_to_candidate) or acceptances — never on numbers merely spoken.
 */
export function OfferMeter({
  currentOffer,
  acceptedOffer,
  conditions,
  previousOffer,
  notice,
}: {
  currentOffer: CompPackage | null;
  acceptedOffer: CompPackage | null;
  conditions: string[];
  previousOffer: CompPackage | null;
  /** Explains a package the server had to trim to the approved band. */
  notice?: string | null;
}) {
  const pkg = acceptedOffer ?? currentOffer;
  const total =
    pkg ? pkg.base + (pkg.sign_on ?? 0) + (pkg.equity ?? 0) : null;
  const prevTotal = previousOffer
    ? previousOffer.base + (previousOffer.sign_on ?? 0) + (previousOffer.equity ?? 0)
    : null;
  const delta = total != null && prevTotal != null ? total - prevTotal : null;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
          {acceptedOffer ? "Agreed package" : "Offer on the table"}
        </h3>
        {delta != null && delta > 0 && !acceptedOffer && (
          <span className="badge text-emerald-300">▲ {money(delta)} vs. last offer</span>
        )}
      </div>

      {!pkg ? (
        <p className="mt-3 text-sm text-white/40">
          No formal offer yet — it will appear here when the recruiter puts one on the table.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <Row
            label="Base"
            value={pkg.base}
            delta={previousOffer ? pkg.base - previousOffer.base : null}
            highlight
          />
          <Row
            label="Sign-on"
            value={pkg.sign_on ?? null}
            delta={previousOffer ? (pkg.sign_on ?? 0) - (previousOffer.sign_on ?? 0) : null}
          />
          <Row
            label="Equity / yr"
            value={pkg.equity ?? null}
            delta={previousOffer ? (pkg.equity ?? 0) - (previousOffer.equity ?? 0) : null}
          />
          <div className="mt-2 border-t border-white/10 pt-2">
            <Row label="Total (yr 1)" value={total} bold />
          </div>
        </div>
      )}

      {conditions.length > 0 && !acceptedOffer && (
        <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-300/80">
            Conditions
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-200/80">
            {conditions.map((c, i) => (
              <li key={i}>• {c}</li>
            ))}
          </ul>
        </div>
      )}

      {notice && !acceptedOffer && (
        <p className="mt-3 border-t border-white/10 pt-2 text-xs text-white/45">{notice}</p>
      )}

      {acceptedOffer && <p className="mt-3 text-sm text-emerald-300">Deal accepted.</p>}
    </div>
  );
}

function Row({
  label,
  value,
  delta,
  bold,
  highlight,
}: {
  label: string;
  value: number | null;
  delta?: number | null;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? "text-sm font-semibold text-white" : "text-sm text-white/60"}>
        {label}
      </span>
      <span className="flex items-center gap-2">
        {delta != null && delta > 0 && (
          <span className="text-xs text-emerald-300">+{money(delta)}</span>
        )}
        <span
          className={[
            "font-mono",
            bold ? "text-lg font-bold text-white" : "text-sm",
            highlight ? "text-violet-300" : "text-white/80",
          ].join(" ")}
        >
          {money(value)}
        </span>
      </span>
    </div>
  );
}
