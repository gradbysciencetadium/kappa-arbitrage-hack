// Data workers — interpret the deterministically-computed metrics into grounded
// findings. They run in parallel, each with a narrow dimension. They MUST cite the
// computed metrics they were given; they may not invent numbers. Step 3-4 of pipeline.

const { callModel } = require("../llm/adapter");
const { workerSchema } = require("./schemas");

const SYSTEM = `You are a data worker for Bara. You are given pre-computed, audited metrics
for a set of areas. Interpret them into findings for your assigned dimension. STRICT RULES:
- Every number in a finding must come verbatim from the provided computed metrics.
- Never invent or estimate figures. If a number is not provided, say it is not available.
- Each finding must cite its 'source' (use the metric's source field).
Return JSON only.`;

async function runWorker(dimension, brief, computedFactsJson) {
  return callModel({
    role: "WORKER",
    system: SYSTEM,
    schema: workerSchema,
    temperature: 0.3,
    messages: [
      {
        role: "user",
        text:
          `Dimension to analyse: ${dimension}\n` +
          `Strategic question: ${brief.strategic_question}\n\n` +
          `Pre-computed metrics (the ONLY source of numbers you may use):\n${computedFactsJson}\n\n` +
          `Produce findings for the "${dimension}" dimension, each citing its source.`,
      },
    ],
  });
}

// Combined worker: analyse ALL dimensions in ONE call. The numbers are already
// computed deterministically, so a single grounded-narration call is enough — and it
// keeps the pipeline within free-tier rate limits (fewer calls). This is the default.
const combinedSchema = {
  type: "object",
  properties: {
    analyses: { type: "array", items: workerSchema },
  },
  required: ["analyses"],
};

async function runCombinedWorker(dimensions, brief, computedFacts) {
  const factsJson = JSON.stringify(computedFacts, null, 2);
  try {
    const out = await callModel({
      role: "WORKER",
      system: SYSTEM,
      schema: combinedSchema,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          text:
            `Dimensions to analyse (one entry each): ${dimensions.join("; ")}\n` +
            `Strategic question: ${brief.strategic_question}\n\n` +
            `Pre-computed metrics (the ONLY source of numbers you may use):\n${factsJson}\n\n` +
            `Return an "analyses" array with one object per dimension, each citing its source.`,
        },
      ],
    });
    return (out && out.analyses) || [];
  } catch (e) {
    return dimensions.map((d) => ({ dimension: d, findings: [], error: e.message }));
  }
}

// Fan-out variant: one call per dimension with bounded concurrency. Use this when a
// high-throughput provider (e.g. Groq) is configured for the WORKER role.
async function runWorkers(dimensions, brief, computedFacts, concurrency = 2) {
  const factsJson = JSON.stringify(computedFacts, null, 2);
  const results = [];
  for (let i = 0; i < dimensions.length; i += concurrency) {
    const batch = dimensions.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((d) =>
        runWorker(d, brief, factsJson).catch((e) => ({
          dimension: d,
          findings: [],
          error: e.message,
        }))
      )
    );
    results.push(...batchResults);
  }
  return results;
}

module.exports = { runWorker, runWorkers, runCombinedWorker };
