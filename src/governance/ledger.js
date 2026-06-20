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

/* ------------------------------------------------------------------ *
 * Ed25519 signing — binds WHO wrote each record. The private key comes
 * from env LEDGER_SIGNING_KEY (base64 PKCS8); otherwise an ephemeral key
 * is generated and its public key is logged so it can be pinned. The
 * public key is published at /api/ledger/pubkey for independent verifiers.
 * ------------------------------------------------------------------ */
let _keys = null;
function keys() {
  if (_keys) return _keys;
  const env = process.env.LEDGER_SIGNING_KEY;
  if (env) {
    try {
      const priv = crypto.createPrivateKey({ key: Buffer.from(env, "base64"), format: "der", type: "pkcs8" });
      _keys = { priv, pub: crypto.createPublicKey(priv), ephemeral: false };
    } catch (e) {
      console.warn("Ledger: invalid LEDGER_SIGNING_KEY, generating an ephemeral key:", e.message);
    }
  }
  if (!_keys) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    _keys = { priv: privateKey, pub: publicKey, ephemeral: true };
    console.warn(
      "Ledger: using an EPHEMERAL signing key (set LEDGER_SIGNING_KEY to persist authorship across restarts).\n" +
        "  public key: " + publicKeyB64() + "\n" +
        "  signer id : " + signerId()
    );
  }
  return _keys;
}
function publicKeyB64() {
  return keys().pub.export({ format: "der", type: "spki" }).toString("base64");
}
function signerId() {
  return sha256(publicKeyB64()).slice(0, 16); // short fingerprint
}
function sign(hashHex) {
  return crypto.sign(null, Buffer.from(hashHex, "hex"), keys().priv).toString("base64");
}
function verifySignature(hashHex, signatureB64, pubKeyB64) {
  try {
    const pub = pubKeyB64
      ? crypto.createPublicKey({ key: Buffer.from(pubKeyB64, "base64"), format: "der", type: "spki" })
      : keys().pub;
    return crypto.verify(null, Buffer.from(hashHex, "hex"), pub, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}
function keyInfo() {
  return { algorithm: "ed25519", public_key: publicKeyB64(), signer: signerId(), ephemeral: keys().ephemeral };
}

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
      // Binds the record to the model's actual output (the synthesised report), so a
      // third party can confirm this provider produced this exact analysis.
      output_sha256: sha256(canonical(report)),
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
    // Brief-REDACTED proof bundle: enough for an outsider to RE-DERIVE the grounding check
    // offline (the report + the computed substrate + the client's bare figures), WITHOUT the
    // private brief. Omitting the brief can only make the check stricter, never falser.
    proof_bundle:
      meta && meta.rankedWards
        ? {
            report,
            brief_figures: (meta && meta.briefFigures) || [],
            rankedWards: meta.rankedWards.map((w) => ({
              ward_name: w.ward_name,
              opportunity_score: w.opportunity_score,
              supply_demand_gap: w.supply_demand_gap,
              childcare_desert_index: w.childcare_desert_index,
              deprivation_adjusted_demand: w.deprivation_adjusted_demand,
              competitive_quality_density: w.competitive_quality_density,
              coverage: w.coverage,
            })),
            validation: (meta && meta.validation) || null,
            coverage: (meta && meta.coverage) || null,
          }
        : null,
    validation: (meta && meta.validation) || null,
    inputs_hash: sha256(canonical(brief)),
    // WHEN and WHO — inside the hash, so the chain proves the record's time and author,
    // not just its relative order. Backs the "logged before the outcome is known" claim.
    created_at: new Date().toISOString(),
    signer: signerId(),
  };
}

// hash = sha256(prev_hash + canonical(payload))
function hashRecord(prevHash, payload) {
  return sha256((prevHash || "GENESIS") + canonical(payload));
}

// Build a complete, signed record ready to append.
function makeRecord(args, prevHash) {
  const payload = buildPayload(args);
  const hash = hashRecord(prevHash, payload);
  return {
    report_id: args.reportId,
    prev_hash: prevHash || null,
    hash,
    payload,
    signature: sign(hash),
    signer: signerId(),
    signer_pubkey: publicKeyB64(),
  };
}

// Recompute the whole chain to prove integrity (no record altered, inserted or reordered),
// AND verify each record's Ed25519 signature (proves authorship). Records written before
// signing existed have no signature and are integrity-checked only.
function verifyChain(records, opts = {}) {
  let prev = null;
  let signed = 0;
  for (const r of records) {
    const expected = hashRecord(r.prev_hash, r.payload);
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { intact: false, broken_at: r.report_id || r.id || null, reason: "hash", count: records.length };
    }
    if (r.signature) {
      if (!verifySignature(r.hash, r.signature, r.signer_pubkey || opts.pubkey)) {
        return { intact: false, broken_at: r.report_id || r.id || null, reason: "signature", count: records.length };
      }
      signed++;
    }
    prev = r.hash;
  }
  return { intact: true, count: records.length, head: prev, signed };
}

// Build a signed "anchor receipt" over the current chain head — a portable proof you can
// publish anywhere EXTERNAL (a public git commit, a gist, a timestamp authority), turning
// the self-custodied chain into one anyone can independently witness.
function buildAnchor(head, count) {
  const body = { head: head || "GENESIS", count: count || 0, created_at: new Date().toISOString(), signer: signerId() };
  const digest = sha256(canonical(body));
  return { ...body, digest, signature: sign(digest), signer_pubkey: publicKeyB64(), algorithm: "ed25519" };
}
function verifyAnchor(anchor) {
  if (!anchor) return false;
  // Verify ONLY the originally-signed fields, so later metadata (OTS proof, git URL)
  // attached after signing doesn't invalidate the receipt.
  const body = { head: anchor.head, count: anchor.count, created_at: anchor.created_at, signer: anchor.signer };
  if (sha256(canonical(body)) !== anchor.digest) return false;
  return verifySignature(anchor.digest, anchor.signature, anchor.signer_pubkey);
}

// Directional accuracy across any records that carry a resolved validation outcome.
function accuracyFromRecords(records) {
  const withVal = records.filter(
    (r) => r.payload && r.payload.validation && r.payload.validation.available && r.payload.validation.agreement
  );
  const agree = withVal.filter((r) => r.payload.validation.agreement === "agrees").length;
  return { validated: withVal.length, agreements: agree };
}

module.exports = {
  buildPayload,
  hashRecord,
  makeRecord,
  verifyChain,
  verifySignature,
  accuracyFromRecords,
  buildAnchor,
  verifyAnchor,
  keyInfo,
  publicKeyB64,
  signerId,
  canonical,
  sha256,
};
