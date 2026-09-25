import { z } from "zod";

import { ApiError, handle } from "@/lib/api";
import { generateScenario } from "@/lib/ai/generate";
import { insertScenario, listScenariosWithCounts, toPublicScenario } from "@/lib/db/queries";
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

export const GET = handle(async () => {
  const scenarios = await listScenariosWithCounts();
  return Response.json({ scenarios });
});

export const POST = handle(async (req: Request) => {
  const body = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) throw new ApiError(400, "Invalid scenario request");
  const parsed = Difficulty.safeParse(body.data.difficulty ?? "medium");
  if (!parsed.success) throw new ApiError(400, "Invalid difficulty");

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
  });
  return Response.json({ scenario: toPublicScenario(row) }, { status: 201 });
});
