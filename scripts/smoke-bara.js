// Smoke test: run the full Bara pipeline on a sample childcare brief against live Gemini.
// Usage: node scripts/smoke-bara.js
require("dotenv").config();
const { runBara } = require("../src/bara");

const brief = {
  business_profile: "Independent day nursery operator, 1 existing setting, ~£600k revenue, owner-led.",
  strategic_question: "Where in Croydon should we open our second day nursery to maximise occupancy?",
  current_situation: "One Outstanding-rated setting in Shirley; strong waiting list; want to expand within the borough.",
  goals_and_metrics: "Reach 85%+ occupancy within 12 months of opening.",
  key_constraints: "Budget for a 50-place setting; want to stay within Croydon; 12-month timeline.",
  competitive_context: "Aware of several nearby nurseries; unsure which areas are under-served.",
  client_hypotheses: "Owner suspects the north of the borough is under-supplied.",
  data_available_or_gaps: "No formal demand data; relies on word of mouth.",
  location_focus: "Croydon",
  vertical: "childcare",
};

(async () => {
  const t0 = Date.now();
  const { report, meta } = await runBara(brief, { onProgress: (s) => console.log("  ›", s) });
  console.log("\n=== META ===");
  console.log(JSON.stringify(meta, null, 2));
  console.log("\n=== REPORT ===");
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
