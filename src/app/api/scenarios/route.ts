import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { generateScenario } from "@/lib/ai/generate";
import { insertScenario, listScenariosWithCounts, toPublicScenario } from "@/lib/db/queries";
import { ensureOwnerId, readOwnerId } from "@/lib/ownership";
import { takeScenarioSlot } from "@/lib/rate-limit";
import { Difficulty } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Short strings only — this is a steer for the generator, not free prose. */
const short = z.string().max(80);
const FormSchema = z
  .object({
    role: short.optional(),
    industry: short.optional(),
    seniority: short.optional(),
    stage: short.optional(),
    persona_style: short.optional(),
    leverage: z.string().max(60).optional(),
    levers: z.array(z.string().max(40)).max(8).optional(),
    notes: z.string().max(400).optional(),
  })
  .optional();

const BodySchema = z.object({
  difficulty: z.unknown().optional(),
  brief: z.string().max(500).optional(),
  form: FormSchema,
});

/**
 * The library: the public sample scenarios plus the caller's own.
 *
 * Read the identity without minting one — a visitor who has never created
 * anything is not the owner of anything, and listing the library must not hand
 * them another user's custom scenario or prep material.
 */
export const GET = handle(async () => {
  const scenarios = await listScenariosWithCounts(await readOwnerId());
  return Response.json({ scenarios });
});

export const POST = handle(async (req: Request) => {
  const body = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) throw new ApiError(400, "Invalid scenario request");
  const parsed = Difficulty.safeParse(body.data.difficulty ?? "medium");
  if (!parsed.success) throw new ApiError(400, "Invalid difficulty");

  // Generation costs an LLM call, so it is throttled — and the creator is
  // recorded, because this scenario is theirs to edit or delete afterwards.
  const ownerId = await ensureOwnerId();
  if (!takeScenarioSlot(ownerId)) {
    throw new ApiError(429, "Too many scenarios generated in a row — give it a minute.");
  }

  const { hidden, prepPack } = await generateScenario({
    difficulty: parsed.data,
    brief: body.data.brief,
    form: body.data.form,
  });

  const row = await insertScenario({
    title: prepPack.title,
    company: prepPack.company,
    role: prepPack.role,
    level:
      parsed.data === "hard"
        ? "Senior/Staff"
        : parsed.data === "easy"
          ? "Junior/Mid"
          : "Mid/Senior",
    difficulty: parsed.data,
    hidden,
    prep_pack: prepPack,
    ownerId,
  });
  return Response.json({ scenario: toPublicScenario(row) }, { status: 201 });
});
