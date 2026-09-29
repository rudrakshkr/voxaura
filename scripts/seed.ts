/**
 * Seed the demo scenario library. Run with: `npm run seed`.
 *
 * Idempotent: each seed carries a stable `seed_key` and is upserted. The old
 * guard (`if (existing.length >= 3) return`) both duplicated scenarios when the
 * library held fewer than three rows and refused to re-run after a partial
 * failure, so a half-seeded database could never be repaired.
 *
 * Hidden economics are never overwritten on re-seed: a scenario someone has
 * already practised against keeps the problem it was generated with, while the
 * candidate-facing material is refreshed.
 *
 * Uses the LLM when keys are configured; deterministic content when AI_DEBUG=1.
 * Requires DATABASE_URL (run `npm run db:push` first).
 */
import "dotenv/config";

import { generateScenario } from "../src/lib/ai/generate";
import { closePool } from "../src/lib/db/lifecycle";
import { upsertSeededScenario } from "../src/lib/db/queries";

const SEEDS: Array<{
  key: string;
  difficulty: "easy" | "medium" | "hard";
  level: string;
  brief: string;
}> = [
  {
    key: "demo-easy-product-designer",
    difficulty: "easy",
    level: "Junior/Mid",
    brief: "Mid-size SaaS company hiring a product designer; warm recruiter, flexible on start date",
  },
  {
    key: "demo-medium-backend-engineer",
    difficulty: "medium",
    level: "Mid/Senior",
    brief: "Series B fintech hiring a backend engineer; brisk recruiter, strong equity culture",
  },
  {
    key: "demo-hard-analytics-lead",
    difficulty: "hard",
    level: "Senior/Staff",
    brief: "Prestigious consulting firm hiring an analytics lead; combative recruiter, tight band",
  },
];

async function main() {
  let created = 0;
  let refreshed = 0;

  for (const seed of SEEDS) {
    console.log(`Generating: ${seed.brief}`);
    const { hidden, prepPack } = await generateScenario({
      difficulty: seed.difficulty,
      brief: seed.brief,
    });
    const result = await upsertSeededScenario(seed.key, {
      title: prepPack.title,
      company: prepPack.company,
      role: prepPack.role,
      level: seed.level,
      difficulty: seed.difficulty,
      hidden,
      prep_pack: prepPack,
    });
    if (result.created) created += 1;
    else refreshed += 1;
    console.log(`  ${result.created ? "✓ created" : "↻ refreshed"} ${result.row.title} (${result.row.id})`);
  }

  console.log(`\nDone — ${created} created, ${refreshed} refreshed. Start the app with: npm run dev`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
