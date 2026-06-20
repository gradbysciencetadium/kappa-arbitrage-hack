// Eval runner. For each case: run Bara, then produce a soundness scorecard from
// (a) the LLM-judge rubric scores, (b) an automated grounding check, and (c) the
// outcome-backtest agreement. NOT answer-matching — there is no single right answer.
//
// Usage: node src/eval/runEval.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { runBara } = require("../bara");
const derivations = require("../data/derivations");
const { RUBRIC, groundingCheck } = require("./rubric");

const CASES_DIR = path.join(__dirname, "cases");

function loadCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf8")));
}

async function scoreCase(c) {
  const { report, meta } = await runBara(c.brief, { onProgress: (s) => process.stdout.write(`    · ${s}\n`) });
  const rankedWards = derivations.rankWards(c.brief.location_focus);
  const grounding = groundingCheck(report, rankedWards);

  return {
    case: c.name,
    judge: meta.judge ? { overall: meta.judge.overall, verdict: meta.judge.verdict } : null,
    grounding: {
      top1_agrees: grounding.top1_agrees,
      overlap_count: grounding.overlap_count,
      hallucinated_wards: grounding.hallucinated_wards,
    },
    backtest: meta.validation
      ? { available: meta.validation.available, agreement: meta.validation.agreement }
      : null,
    confidence: report.confidence,
    isFixture: meta.isFixture,
  };
}

(async () => {
  const cases = loadCases();
  if (!cases.length) {
    console.log("No eval cases found in src/eval/cases/.");
    return;
  }
  console.log("Soundness rubric:");
  for (const [k, v] of Object.entries(RUBRIC)) console.log(`  - ${k}: ${v}`);
  console.log("");

  const results = [];
  for (const c of cases) {
    console.log(`Running case: ${c.name}`);
    try {
      results.push(await scoreCase(c));
    } catch (e) {
      results.push({ case: c.name, error: e.message });
    }
  }

  console.log("\n=== SCORECARD ===");
  console.log(JSON.stringify(results, null, 2));
  console.log(
    "\nNote: grounding.hallucinated_wards must be empty (no ward invented outside the data); " +
      "top1_agrees / backtest.agreement check the model's recommendation matches its own computed signal."
  );
})().catch((e) => {
  console.error("EVAL FAILED:", e);
  process.exit(1);
});
