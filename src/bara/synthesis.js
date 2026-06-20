// Synthesis — assembles the final consulting report from the computed metrics, the
// worker findings, and the validation cross-check. Strongest model. Step 5 of pipeline.
// Hard rule: numbers come only from the provided computed metrics.

const { callModel } = require("../llm/adapter");
const { reportSchema } = require("./schemas");

const SYSTEM = `You are Bara, a data-backed strategy analyst for SMBs. Write a consulting report
that answers the client's strategic question using ONLY the provided computed metrics, worker
findings, and validation cross-check.
STRICT RULES:
- Every quantitative claim must trace to the provided computed metrics. Never invent figures.
- Rank recommended locations using the provided opportunity scores and metrics.
- Be specific and implementable; no generic advice.
- Acknowledge uncertainty and the data caveats you are given.
- Set "confidence" (0-1) based on data completeness.
Return JSON only, matching the required schema.`;

async function synthesize({ brief, rankedWards, workerFindings, validation, dataCaveat }) {
  const payload = {
    brief,
    computed_ranked_wards: rankedWards,
    worker_findings: workerFindings,
    validation_cross_check: validation,
    data_caveat: dataCaveat,
  };
  return callModel({
    role: "SYNTH",
    system: SYSTEM,
    schema: reportSchema,
    temperature: 0.4,
    messages: [
      {
        role: "user",
        text:
          `Produce the consulting report.\n\n` +
          `All available analysis (use these numbers verbatim; cite sources):\n` +
          JSON.stringify(payload, null, 2),
      },
    ],
  });
}

// Reflexion revise pass driven by the judge's weaknesses.
async function revise({ brief, report, weaknesses, rankedWards, workerFindings, validation, dataCaveat }) {
  const payload = { brief, computed_ranked_wards: rankedWards, worker_findings: workerFindings, validation_cross_check: validation, data_caveat: dataCaveat };
  return callModel({
    role: "SYNTH",
    system: SYSTEM,
    schema: reportSchema,
    temperature: 0.3,
    messages: [
      { role: "user", text: `Produce the consulting report using only this analysis:\n${JSON.stringify(payload, null, 2)}` },
      { role: "assistant", text: JSON.stringify(report) },
      { role: "user", text: `A reviewer found these weaknesses:\n- ${(weaknesses || []).join("\n- ")}\n\nRevise the report to fix them. Keep all numbers traceable to the provided metrics. Return JSON only.` },
    ],
  });
}

module.exports = { synthesize, revise };
