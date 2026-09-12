import { ApiError, handle } from "@/lib/api";
import { generateScenario } from "@/lib/ai/generate";
import { insertScenario, listScenarios, toPublicScenario } from "@/lib/db/queries";
import { Difficulty } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const scenarios = await listScenarios();
  return Response.json({ scenarios });
});

export const POST = handle(async (req: Request) => {
  const body = (await req.json().catch(() => ({}))) as { difficulty?: string; brief?: string };
  const parsed = Difficulty.safeParse(body.difficulty ?? "medium");
  if (!parsed.success) throw new ApiError(400, "Invalid difficulty");
  if ((body.brief ?? "").length > 500) throw new ApiError(400, "Brief too long (max 500 chars)");

  const { hidden, prepPack } = await generateScenario({
    difficulty: parsed.data,
    brief: body.brief,
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
