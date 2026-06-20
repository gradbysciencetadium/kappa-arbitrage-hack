// LLM-as-judge — scores the draft report on the per-case soundness rubric (NOT against
// a fixed "correct answer", which doesn't exist for case-specific advice). Step 8.

const { callModel } = require("../llm/adapter");
const { judgeSchema } = require("./schemas");

const SYSTEM = `You are an independent reviewer scoring a consulting report for SOUNDNESS, not
for matching any single "correct" answer (there isn't one for case-specific advice). Score 0-1 on:
- factual_grounding: are all numbers traceable to the provided computed metrics (no invented figures)?
- citation_quality: are claims attributed to sources?
- internal_logic: does the recommendation follow from the evidence presented?
- nuance: does it acknowledge uncertainty, limitations, and data caveats?
Give an "overall" 0-1 and verdict "pass" (>=0.7) or "revise". List concrete weaknesses. JSON only.`;

async function judge({ report, rankedWards }) {
  return callModel({
    role: "JUDGE",
    system: SYSTEM,
    schema: judgeSchema,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        text:
          `Computed metrics that the report was supposed to use (ground truth for numbers):\n` +
          JSON.stringify(rankedWards, null, 2) +
          `\n\nReport under review:\n` +
          JSON.stringify(report, null, 2),
      },
    ],
  });
}

module.exports = { judge };
