/**
 * Seed demo scenarios. Run with: npm run seed
 *
 * Uses the LLM when keys are configured; falls back to deterministic content
 * when AI_DEBUG=1. Requires DATABASE_URL (drizzle push first: npm run db:push).
 */
import "dotenv/config";

import { generateScenario } from "../src/lib/ai/generate";
import { insertScenario, listScenarios, toPublicScenario } from "../src/lib/db/queries";
import { closePool } from "../src/lib/db/lifecycle";

const SEEDS: Array<{ difficulty: "easy" | "medium" | "hard"; brief: string }> = [
  {
    difficulty: "easy",
    brief: "Mid-size SaaS company hiring a product designer; warm recruiter, flexible on start date",
  },
  {
    difficulty: "medium",
    brief: "Series B fintech hiring a backend engineer; brisk recruiter, strong equity culture",
  },
  {
    difficulty: "hard",
    brief: "Prestigious consulting firm hiring an analytics lead; combative recruiter, tight band",
  },
];

async function main() {
  const existing = await listScenarios();
  if (existing.length >= 3) {
    console.log(`Already ${existing.length} scenarios — nothing to do.`);
    return;
  }

  for (const seed of SEEDS) {
    console.log(`Generating: ${seed.brief}`);
    const { hidden, prepPack } = await generateScenario(seed);
    const row = await insertScenario({
      title: prepPack.title,
      company: prepPack.company,
      role: prepPack.role,
      level:
        seed.difficulty === "hard"
          ? "Senior/Staff"
          : seed.difficulty === "easy"
            ? "Junior/Mid"
            : "Mid/Senior",
      difficulty: seed.difficulty,
      hidden,
      prep_pack: prepPack,
    });
    console.log(`  ✓ ${toPublicScenario(row).title} (${row.id})`);
  }

  console.log("\nSeeded. Start the dev server with: npm run dev");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
