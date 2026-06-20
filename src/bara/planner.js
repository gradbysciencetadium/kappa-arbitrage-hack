// Planner — decomposes the strategic question into research dimensions.
// Step 2 of the pipeline (Least-to-Most / Plan-and-Execute).

const { callModel } = require("../llm/adapter");
const { planSchema } = require("./schemas");

const SYSTEM = `You are the planning module of Bara, a data-backed SMB strategy analyst.
Given a client context brief, decompose the strategic question into a focused list of
research dimensions to investigate. For a childcare/nursery site-selection question, typical
dimensions are: supply-demand gap, childcare-desert analysis, deprivation-adjusted demand,
competitive quality, and a validation cross-check against a comparable opening.
Be specific to THIS brief. Return JSON only.`;

async function plan(brief) {
  return callModel({
    role: "PLANNER",
    system: SYSTEM,
    schema: planSchema,
    temperature: 0.3,
    messages: [
      { role: "user", text: `Client context brief:\n${JSON.stringify(brief, null, 2)}\n\nProduce the research plan.` },
    ],
  });
}

module.exports = { plan };
