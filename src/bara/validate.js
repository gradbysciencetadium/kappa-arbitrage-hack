// Validation cross-check — the core differentiator. Takes a comparable case with a
// KNOWN outcome, derives what our model would have signalled for that location, and
// checks whether the signal agrees with reality. Deterministic structure + honest caveat.
// Step 7 of the pipeline.

const store = require("../data/store");
const derivations = require("../data/derivations");

function crossCheck(locationFocus) {
  const comparables = store.getComparables(locationFocus);
  if (!comparables.length) {
    return {
      available: false,
      note: "No comparable case available for this location yet. Validation library grows with each engagement.",
    };
  }

  const c = comparables[0];
  const gap = derivations.supplyDemandGap(locationFocus, c.ward_code);
  const predictedSignal = gap
    ? gap.gap_pct < -10
      ? "under-supplied (favourable for a new opening)"
      : gap.gap_pct > 10
      ? "over-supplied (unfavourable)"
      : "balanced"
    : "unknown";

  const actualGood = c.outcome_occupancy_12m != null && c.outcome_occupancy_12m >= 0.85;
  const predictedFavourable = gap && gap.gap_pct < -10;
  const agreement =
    gap == null
      ? "indeterminate"
      : predictedFavourable === actualGood
      ? "agrees"
      : "diverges";

  return {
    available: true,
    comparable_id: c.case_id,
    ward_code: c.ward_code,
    opened: c.opened,
    model_signal: predictedSignal,
    model_gap_pct: gap ? gap.gap_pct : null,
    actual_outcome: {
      occupancy_12m: c.outcome_occupancy_12m,
      ofsted: c.outcome_ofsted,
    },
    agreement,
    caveat:
      "Cross-check uses current-period supply data as a proxy; a rigorous backtest needs supply data as it was at the comparable's opening date. " +
      (store.isFixture(locationFocus) ? "Comparable is FIXTURE data." : ""),
  };
}

module.exports = { crossCheck };
