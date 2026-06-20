// AI Accountability Ledger — the governance/transparency core (FLock Track 3).
// Every Bara analysis is recorded as a tamper-evident, hash-chained entry capturing
// HOW the conclusion was reached: the question, the public data sources, the
// deterministic computations, the (sovereign) model used, the prediction, and the
// predicted-vs-actual validation. Each record's hash chains to the previous one, so the
// whole audit trail is verifiable and any after-the-fact edit is detectable.

const crypto = require("crypto");
const { resolveRole } = require("../llm/models.config");

// Deterministic (sorted-key) stringify so hashes are stable regardless of key order.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort()
      .reduce((a, k) => ((a[k] = sortKeys(v[k])), a), {});
  }
  return v;
}
const canonical = (obj) => JSON.stringify(sortKeys(obj));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Build the audit payload for one finished analysis.
function buildPayload({ reportId, conversationId, brief, report, meta }) {
  const synth = resolveRole("SYNTH");
  const topRec = (report.recommended_locations && report.recommended_locations[0]) || null;
  return {
    report_id: reportId,
    conversation_id: conversationId || null,
    question: brief.strategic_question || null,
    model: {
      provider: synth.provider,
      id: synth.model,
      sovereign: synth.provider === "flock",
    },
    data_sources: report.data_sources || [],
    computations: (meta && meta.dimensions) || [],
    data_provenance: (meta && meta.dataSource) || null,
    is_fixture: !!(meta && meta.isFixture),
    // Deterministic grounding proof: every figure/ward in the report was checked
    // against the computed substrate (src/bara/verifier.js).
    grounding:
      meta && meta.verification
        ? {
            grounded: meta.verification.grounded,
            numbers_checked: meta.verification.numbers_checked,
            ungrounded_count: (meta.verification.ungrounded_numbers || []).length,
            unknown_wards: (meta.verification.ward_check && meta.verification.ward_check.unknown) || [],
          }
        : null,
    coverage:
      meta && meta.coverage
        ? {
            total_providers: meta.coverage.total_providers,
            group_based_geocoded_pct: meta.coverage.group_based && meta.coverage.group_based.geocoded_pct,
            childminders_unallocated: meta.coverage.childminders && meta.coverage.childminders.count,
          }
        : null,
    prediction: {
      top_recommendation: topRec ? topRec.ward_name : null,
      confidence: report.confidence != null ? report.confidence : null,
    },
    validation: (meta && meta.validation) || null,
    inputs_hash: sha256(canonical(brief)),
  };
}

// hash = sha256(prev_hash + canonical(payload))
function hashRecord(prevHash, payload) {
  return sha256((prevHash || "GENESIS") + canonical(payload));
}

// Recompute the whole chain to prove integrity (no record altered or inserted).
function verifyChain(records) {
  let prev = null;
  for (const r of records) {
    const expected = hashRecord(r.prev_hash, r.payload);
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { intact: false, broken_at: r.report_id || r.id || null, count: records.length };
    }
    prev = r.hash;
  }
  return { intact: true, count: records.length, head: prev };
}

// Directional accuracy across any records that carry a resolved validation outcome.
function accuracyFromRecords(records) {
  const withVal = records.filter(
    (r) => r.payload && r.payload.validation && r.payload.validation.available && r.payload.validation.agreement
  );
  const agree = withVal.filter((r) => r.payload.validation.agreement === "agrees").length;
  return { validated: withVal.length, agreements: agree };
}

module.exports = { buildPayload, hashRecord, verifyChain, accuracyFromRecords, canonical, sha256 };
