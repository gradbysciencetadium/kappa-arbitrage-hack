// Deterministic citation verifier — grounding by PROOF, not by vibes.
//
// After synthesis, every quantitative claim and every recommended ward in the report must
// trace back to the computed substrate (rankedWards / validation / coverage). The LLM is
// told never to invent numbers; this verifies it in code so a plausible-but-fabricated
// figure or a non-existent ward is caught deterministically rather than trusted.
//
// Design notes on false positives: we DO NOT flag small integers (ranks, phases, list
// counts), 4-digit years, or money/magnitude figures (£, k/m/bn) — those are legitimate
// narrative, not data claims. We flag ward-level statistics that don't match any computed
// value, and (the strong check) any recommended ward that isn't a real ward in the dataset.

function round(n, dp = 2) {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

// Numbers the client themselves stated in the brief (budget, occupancy target, etc.) are
// legitimate to restate in the report even though they aren't computed metrics.
function addBriefNumbers(allow, brief) {
  if (!brief) return;
  const s = JSON.stringify(brief);
  const re = /(?<![\d.])-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[0].replace(/,/g, ""));
    if (isFinite(n)) { allow.add(round(n)); allow.add(Math.round(n)); }
  }
}

// Build the set of numbers that legitimately appear in the deterministic substrate.
function allowedNumbers(rankedWards, validation, coverage, brief) {
  const allow = new Set();
  addBriefNumbers(allow, brief);
  const add = (v) => {
    if (v == null || typeof v !== "number" || !isFinite(v)) return;
    allow.add(round(v));
    allow.add(round(Math.abs(v)));
    allow.add(Math.round(v));
    // shares (0..1) are routinely written as percentages
    if (Math.abs(v) <= 1) {
      allow.add(round(v * 100));
      allow.add(Math.round(v * 100));
    }
  };
  for (const w of rankedWards || []) {
    add(w.opportunity_score);
    const sdg = w.supply_demand_gap;
    if (sdg) { add(sdg.places_per_100); add(sdg.la_average_per_100); add(sdg.gap_pct); }
    const cdi = w.childcare_desert_index;
    if (cdi) { add(cdi.children_0_4); add(cdi.total_places); add(cdi.children_per_place); }
    const dad = w.deprivation_adjusted_demand;
    if (dad) { add(dad.pop_0_4); add(dad.idaci_decile); add(dad.weight); add(dad.adjusted_demand); }
    const cqd = w.competitive_quality_density;
    if (cqd) { add(cqd.provider_count); add(cqd.rated_count); add(cqd.good_or_outstanding); add(cqd.good_or_outstanding_share); }
    if (w.coverage) { add(w.coverage.group_provider_count); add(w.coverage.rated_count); }
  }
  if (validation && typeof validation === "object") {
    const scan = (o) => { for (const v of Object.values(o)) { if (typeof v === "number") add(v); else if (v && typeof v === "object") scan(v); } };
    scan(validation);
  }
  if (coverage) {
    add(coverage.total_providers); add(coverage.geocoded); add(coverage.geocoded_pct);
    if (coverage.group_based) { add(coverage.group_based.total); add(coverage.group_based.geocoded); add(coverage.group_based.geocoded_pct); }
    if (coverage.childminders) { add(coverage.childminders.count); add(coverage.childminders.registered_places); }
  }
  return allow;
}

function allowMatch(n, allow) {
  if (allow.has(round(n)) || allow.has(Math.round(n))) return true;
  // tolerance for rounding/restatement
  const tol = Math.max(0.5, Math.abs(n) * 0.01);
  for (const a of allow) if (Math.abs(a - n) <= tol) return true;
  return false;
}

function collectText(report) {
  const parts = [];
  const push = (s) => { if (typeof s === "string" && s.trim()) parts.push(s); };
  push(report.executive_summary);
  push(report.strategic_question);
  push(report.validation_cross_check);
  push(report.caveats);
  (report.recommended_locations || []).forEach((l) => { push(l.rationale); push(l.key_metrics); });
  (report.data_analysis || []).forEach((d) => { push(d.finding); });
  (report.implementation_roadmap || []).forEach((r) => { push(r.action); });
  (report.risks || []).forEach(push);
  return parts.join("\n");
}

const YEAR_RE = /^(?:19|20)\d\d$/;

// Numbers immediately preceded by £/$ or followed by k/m/bn/million/billion are money /
// magnitude narrative, not data claims — skip them to avoid false positives.
function isFinancialContext(text, matchIndex, token) {
  const before = text.slice(Math.max(0, matchIndex - 1), matchIndex);
  if (before === "£" || before === "$") return true;
  const after = text.slice(matchIndex + token.length, matchIndex + token.length + 8).toLowerCase();
  return /^\s*(k\b|m\b|bn\b|million|billion)/.test(after);
}

function verifyNumbers(text, allow) {
  const ungrounded = [];
  let checked = 0;
  // Strip dates/timestamps first so "2026-06-20" isn't tokenised into "-06"/"-20".
  text = text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ");
  // Lookbehind prevents capturing fragments of decimals/hyphenated runs as new numbers.
  const re = /(?<![\d.])-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[0];
    const clean = token.replace(/,/g, "");
    const n = parseFloat(clean);
    if (!isFinite(n)) continue;
    if (Number.isInteger(n) && n >= 0 && n <= 20) continue; // ranks, phases, small counts
    if (YEAR_RE.test(clean)) continue; // years (2019, 2021, …)
    if (isFinancialContext(text, m.index, token)) continue; // £200k etc.
    checked++;
    if (!allowMatch(n, allow)) {
      const ctx = text.slice(Math.max(0, m.index - 24), m.index + token.length + 24).replace(/\s+/g, " ").trim();
      ungrounded.push({ value: token, context: "…" + ctx + "…" });
    }
  }
  return { checked, ungrounded };
}

// The strong check: every recommended ward must be a real ward in the dataset.
function verifyWards(report, rankedWards) {
  const known = new Set((rankedWards || []).map((w) => (w.ward_name || "").trim().toLowerCase()).filter(Boolean));
  const recommended = (report.recommended_locations || []).map((l) => (l.ward_name || "").trim()).filter(Boolean);
  const unknown = recommended.filter((name) => !known.has(name.toLowerCase()));
  return { recommended, unknown };
}

function verify({ report, rankedWards, validation, coverage, brief }) {
  if (!report || typeof report !== "object") {
    return { grounded: true, ward_check: { recommended: [], unknown: [] }, numbers_checked: 0, ungrounded_numbers: [], confidence_penalty: 0, note: "" };
  }
  const allow = allowedNumbers(rankedWards, validation, coverage, brief);
  const text = collectText(report);
  const nums = verifyNumbers(text, allow);
  const wards = verifyWards(report, rankedWards);

  // Penalty: unknown wards are a serious grounding failure; ungrounded numbers are softer.
  let penalty = 0;
  if (wards.unknown.length) penalty += 0.3;
  if (nums.ungrounded.length) penalty += Math.min(0.2, 0.04 * nums.ungrounded.length);
  penalty = round(penalty, 2);

  const grounded = wards.unknown.length === 0 && nums.ungrounded.length === 0;
  let note = "";
  if (!grounded) {
    const bits = [];
    if (wards.unknown.length) bits.push(`${wards.unknown.length} recommended ward(s) not found in the dataset (${wards.unknown.join(", ")})`);
    if (nums.ungrounded.length) bits.push(`${nums.ungrounded.length} figure(s) could not be traced to the computed metrics`);
    note = "Automated grounding check: " + bits.join("; ") + ". Confidence reduced accordingly.";
  }

  return {
    grounded,
    ward_check: wards,
    numbers_checked: nums.checked,
    ungrounded_numbers: nums.ungrounded,
    confidence_penalty: penalty,
    note,
  };
}

module.exports = { verify, allowedNumbers, allowMatch };
