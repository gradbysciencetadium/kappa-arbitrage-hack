// Bara orchestrator — runs the full analysis pipeline:
// plan -> data-blind critique -> compute metrics -> parallel workers -> validation
// cross-check -> synthesis -> judge (+ one reflexion revise). Numbers are computed
// deterministically (src/data/derivations); the LLM interprets and writes, never invents.

const store = require("../data/store");
const derivations = require("../data/derivations");
const planner = require("./planner");
const critic = require("./critic");
const workers = require("./workers");
const validate = require("./validate");
const synthesis = require("./synthesis");
const judge = require("./judge");
const verifier = require("./verifier");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const DEFAULT_DIMENSIONS = [
  "supply-demand gap",
  "childcare-desert analysis",
  "deprivation-adjusted demand",
  "competitive quality",
];

async function runBara(brief, { onProgress = () => {} } = {}) {
  const location = brief.location_focus || null;
  const areas = store.listAreas(location);

  // No structured data for this location/vertical yet — return an honest, limited report
  // that names what we DO cover (rather than silently analysing the wrong place).
  if (!areas.length) {
    onProgress("done");
    const covered = store.availableLocalAuthorities();
    const coverageLine = covered.length
      ? `Kappa currently has live childcare data for: ${covered.join(", ")}.`
      : "No datasets are currently loaded.";
    return {
      report: {
        executive_summary:
          `Bara does not yet have a structured data layer for "${location || "this location"}", so it ` +
          `cannot give a data-backed recommendation here without inventing figures — which it won't do. ` +
          coverageLine,
        strategic_question: brief.strategic_question,
        recommended_locations: [],
        data_analysis: [],
        validation_cross_check: "Not available — no dataset loaded for this location.",
        implementation_roadmap: [
          { phase: "To analyse this area", action: `Ingest the connectors for ${location || "this area"} (Ofsted + ONS + IMD), then re-run.` },
        ],
        risks: ["No data for this location — recommendation withheld rather than fabricated."],
        confidence: 0,
        data_sources: [],
        caveats: coverageLine,
      },
      meta: { location, dataAvailable: false, covered },
    };
  }

  const meta = store.datasetMeta(location) || {};
  const dataCaveat = `${meta.source || "Data source unknown."}${store.isFixture(location) ? " [FIXTURE DATA]" : ""}`;

  // 1. Plan
  onProgress("planning the analysis");
  let plan;
  try {
    plan = await planner.plan(brief);
  } catch (e) {
    plan = { tasks: DEFAULT_DIMENSIONS.map((d) => ({ dimension: d, why: "default" })) };
  }

  // 2. Data-blind critique → fold in any missing dimensions
  onProgress("reviewing the plan");
  let critique = { approved: true, missing_dimensions: [], notes: "" };
  try {
    critique = await critic.critique(brief, plan);
  } catch (_) {}
  const dimensions = Array.from(
    new Set([
      ...(plan.tasks || []).map((t) => t.dimension),
      ...((critique && critique.missing_dimensions) || []),
    ])
  );
  // Cap dimensions to bound the call count on free-tier limits.
  const activeDimensions = (dimensions.length ? dimensions : DEFAULT_DIMENSIONS).slice(0, 4);

  // 3. Compute metrics deterministically (the factual substrate)
  onProgress("computing metrics from the data");
  const rankedWards = derivations.rankWards(location);
  const coverage = derivations.datasetCoverage(location);

  // 4. Workers interpret the metrics into grounded findings. Default = one combined
  //    call (free-tier friendly). Set WORKER_FANOUT=1 (with a fast provider) to fan out.
  onProgress("researching " + activeDimensions.length + " dimensions");
  const workerFindings =
    process.env.WORKER_FANOUT === "1"
      ? await workers.runWorkers(activeDimensions, brief, rankedWards, 2)
      : await workers.runCombinedWorker(activeDimensions, brief, rankedWards);

  // 5. Validation cross-check against a known comparable
  onProgress("running the validation cross-check");
  const validation = validate.crossCheck(location);

  // 6. Synthesis
  onProgress("writing the report");
  let report = await synthesis.synthesize({ brief, rankedWards, workerFindings, validation, dataCaveat, coverage });

  // 7. Judge + one reflexion revise if weak
  onProgress("reviewing the report for soundness");
  let verdict = null;
  try {
    verdict = await judge.judge({ report, rankedWards });
    if (verdict && verdict.verdict === "revise" && (verdict.overall || 0) < 0.7) {
      onProgress("revising to fix weaknesses");
      report = await synthesis.revise({
        brief,
        report,
        weaknesses: verdict.weaknesses,
        rankedWards,
        workerFindings,
        validation,
        dataCaveat,
        coverage,
      });
    }
  } catch (_) {}

  // 8. Deterministic citation verification — prove every number/ward traces to the
  //    substrate. Fabricated figures or invented wards lower confidence + are disclosed.
  onProgress("verifying every figure against the data");
  const verification = verifier.verify({ report, rankedWards, validation, coverage, brief });
  if (!verification.grounded) {
    if (typeof report.confidence === "number") {
      report.confidence = Math.max(0, round2(report.confidence - verification.confidence_penalty));
    }
    report.caveats = (report.caveats ? report.caveats + " " : "") + verification.note;
  }

  onProgress("done");
  return {
    report,
    meta: {
      location,
      dataAvailable: true,
      isFixture: store.isFixture(location),
      dataSource: meta.source || null,
      dimensions: activeDimensions,
      validation,
      coverage,
      verification,
      judge: verdict,
    },
  };
}

module.exports = { runBara };
