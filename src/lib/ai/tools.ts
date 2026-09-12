import type { OpponentToolDef } from "../assemblyai/agents";

/**
 * Client-handled function tools (no `http` config): the browser executes these
 * and replies with tool.result on the next reply.done. They drive the live
 * OfferMeter and the negotiation event log.
 */
export const OPPONENT_TOOLS: OpponentToolDef[] = [
  {
    name: "offer_to_candidate",
    description:
      "State a formal offer to the candidate. Call this whenever you present or revise your compensation numbers aloud, including your opening numbers.",
    parameters: {
      type: "object",
      properties: {
        base_salary: {
          type: "integer",
          description: "Annual base salary in USD. Example: 140000",
        },
        sign_on: {
          type: "integer",
          description: "One-time signing bonus in USD. Example: 10000",
        },
        equity: {
          type: "number",
          description: "Annualized equity value in USD per year. Example: 20000",
        },
        notes: {
          type: "string",
          description: "Very short framing, e.g. 'standard band for this level'",
        },
      },
      required: ["base_salary"],
    },
  },
  {
    name: "accept_user_offer",
    description:
      "Accept the candidate's proposed package. Call this the moment you decide to agree to the candidate's numbers.",
    parameters: {
      type: "object",
      properties: {
        final_base: {
          type: "integer",
          description: "Agreed annual base salary in USD. Example: 152000",
        },
        sign_on: { type: "integer", description: "Agreed sign-on bonus in USD." },
        equity: { type: "number", description: "Agreed annualized equity value in USD." },
      },
      required: ["final_base"],
    },
  },
  {
    name: "log_user_move",
    description:
      "Log a negotiation move the candidate just made. Call after the candidate states a number, makes a concession, applies pressure, or raises an objection.",
    parameters: {
      type: "object",
      properties: {
        move: {
          type: "string",
          enum: ["counter_offer", "ask", "concession", "pressure", "objection", "rapport", "walkaway_threat"],
          description: "The kind of move the candidate made.",
        },
        amount: {
          type: "integer",
          description: "Dollar amount mentioned, if any. Example: 160000",
        },
        note: {
          type: "string",
          description: "Short paraphrase of what the candidate said.",
        },
      },
      required: ["move"],
    },
  },
];
