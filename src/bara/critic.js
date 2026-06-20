// Data-blind plan critic — reviews the research plan for gaps/bias BEFORE any data
// is gathered (Dust's trick: no data access keeps it at the strategy level).
// Step 3 of the pipeline.

const { callModel } = require("../llm/adapter");
const { critiqueSchema } = require("./schemas");

const SYSTEM = `You are the strategic plan reviewer for Bara. You have NO access to data —
your only job is to critique the research PLAN for a client's strategic question: is it
complete, unbiased, and well-targeted? Flag any missing dimension a rigorous analyst would
include, or any dimension that is irrelevant to this specific question. Do not attempt to
answer the question itself. Return JSON only.`;

async function critique(brief, plan) {
  return callModel({
    role: "CRITIC",
    system: SYSTEM,
    schema: critiqueSchema,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        text:
          `Strategic question: ${brief.strategic_question}\n\n` +
          `Proposed research plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
          `Review the plan. If dimensions are missing, list them in missing_dimensions.`,
      },
    ],
  });
}

module.exports = { critique };
