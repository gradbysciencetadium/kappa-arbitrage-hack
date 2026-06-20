// The per-case soundness rubric. There is NO single "correct answer" for case-specific
// advice, so we never grade by answer-matching. We grade the soundness of the WORK:
// facts/numbers correct, claims sourced, logic follows, nuance acknowledged — plus an
// automated grounding check and the outcome backtest agreement.

const RUBRIC = {
  factual_grounding: "Every number traces to a computed derivation or cited source; nothing invented.",
  citation_quality: "Claims are attributed to sources.",
  internal_logic: "The recommendation follows from the evidence presented.",
  nuance: "Uncertainty, limitations, and data caveats are acknowledged.",
};

// Automated grounding check: do the report's top recommended wards match the wards the
// deterministic model actually ranked highest? (Direction/agreement, not a fixed answer.)
function groundingCheck(report, rankedWards) {
  const topComputed = rankedWards.slice(0, 3).map((w) => (w.ward_name || "").toLowerCase());
  const recommended = (report.recommended_locations || []).map((r) =>
    (r.ward_name || "").toLowerCase()
  );
  const matched = recommended.filter((r) => topComputed.includes(r));
  const topMatch = recommended[0] && recommended[0] === topComputed[0];
  return {
    top_computed: topComputed,
    recommended,
    overlap_count: matched.length,
    top1_agrees: !!topMatch,
    // recommendation should not name a ward outside the data
    hallucinated_wards: recommended.filter(
      (r) => !rankedWards.some((w) => (w.ward_name || "").toLowerCase() === r)
    ),
  };
}

module.exports = { RUBRIC, groundingCheck };
