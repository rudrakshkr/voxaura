"use client";

import { money } from "./ui";
import type { CompPackage } from "@/lib/types";

export function OfferMeter({
  currentOffer,
  acceptedOffer,
}: {
  currentOffer: CompPackage | null;
  acceptedOffer: CompPackage | null;
}) {
  return (
    <div className="card">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-white/50">
        {acceptedOffer ? "Agreed package" : "Current offer"}
      </h3>
      <div className="mt-3 space-y-2">
        <Row label="Base" value={acceptedOffer?.base ?? currentOffer?.base ?? null} highlight />
        <Row label="Sign-on" value={acceptedOffer?.sign_on ?? currentOffer?.sign_on ?? null} />
        <Row label="Equity / yr" value={acceptedOffer?.equity ?? currentOffer?.equity ?? null} />
        <div className="mt-2 border-t border-white/10 pt-2">
          <Row
            label="Total (yr 1)"
            value={
              acceptedOffer
                ? acceptedOffer.base + (acceptedOffer.sign_on ?? 0) + (acceptedOffer.equity ?? 0)
                : currentOffer
                  ? currentOffer.base + (currentOffer.sign_on ?? 0) + (currentOffer.equity ?? 0)
                  : null
            }
            bold
          />
        </div>
      </div>
      {acceptedOffer && (
        <p className="mt-3 text-sm text-emerald-300">Deal accepted — nice work.</p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  highlight,
}: {
  label: string;
  value: number | null;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={clsxLabel(bold)}>{label}</span>
      <span
        className={clsxValue(bold, highlight)}
      >
        {money(value)}
      </span>
    </div>
  );
}

function clsxLabel(bold?: boolean) {
  return [
    "text-sm",
    bold ? "font-semibold text-white" : "text-white/60",
  ].join(" ");
}

function clsxValue(bold?: boolean, highlight?: boolean) {
  return [
    "font-mono",
    bold ? "text-lg font-bold text-white" : "text-sm",
    highlight ? "text-violet-300" : "text-white/80",
  ].join(" ");
}
