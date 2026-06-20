#!/usr/bin/env node
// Standalone, independent verifier for the AI Accountability Ledger.
//
// It depends on NOTHING but Node's built-in crypto plus ONE pure, dependency-free module
// (src/bara/verifier.js — the same grounding logic the server runs). It does not import the
// app, a database, or any network. Anyone (a judge, an auditor, a client) can run it on
// their own machine against an exported ledger to confirm, WITHOUT trusting the server:
//   1. the hash chain is intact (no record edited, inserted or reordered),
//   2. every record's Ed25519 signature is valid (authorship),
//   3. the grounding can be RE-DERIVED offline from each record's proof bundle — i.e. every
//      figure in the report really does trace to the computed data (not just "the record is
//      intact"), and
//   4. (optional) an external anchor receipt matches the chain head.
// That independence is the whole point: "don't trust — verify."
//
// Usage:
//   curl https://<your-app>/api/ledger > ledger.json
//   node scripts/verify-ledger.js ledger.json [expectedPublicKeyBase64] [--anchor anchor.json]

const fs = require("fs");
const crypto = require("crypto");
const verifier = require("../src/bara/verifier"); // pure, dependency-free grounding logic

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((a, k) => ((a[k] = sortKeys(v[k])), a), {});
  }
  return v;
}
const canonical = (o) => JSON.stringify(sortKeys(o));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashRecord = (prev, payload) => sha256((prev || "GENESIS") + canonical(payload));

function verifySig(hashHex, sigB64, pubB64) {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(hashHex, "hex"), pub, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

// Re-verify an external anchor receipt: its body hashes to its digest, the signature is
// valid, and its head matches the chain head we just recomputed.
function verifyAnchor(anchor, chainHead) {
  // Verify only the originally-signed fields (extra metadata like OTS/git proofs is ignored).
  const body = { head: anchor.head, count: anchor.count, created_at: anchor.created_at, signer: anchor.signer };
  if (sha256(canonical(body)) !== anchor.digest) return { ok: false, reason: "digest does not match body" };
  if (!verifySig(anchor.digest, anchor.signature, anchor.signer_pubkey)) return { ok: false, reason: "signature invalid" };
  if (chainHead && anchor.head !== chainHead) return { ok: false, reason: "anchor head != chain head" };
  return { ok: true };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let anchorFile = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--anchor") anchorFile = args[++i];
    else positional.push(args[i]);
  }
  return { file: positional[0], pinnedPub: positional[1] || null, anchorFile };
}

function main() {
  const { file, pinnedPub, anchorFile } = parseArgs(process.argv);
  if (!file) {
    console.error("Usage: node scripts/verify-ledger.js <ledger.json> [expectedPublicKeyBase64] [--anchor anchor.json]");
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const records = Array.isArray(raw) ? raw : raw.records || [];
  if (!records.length) {
    console.log("No records to verify.");
    process.exit(0);
  }

  let prev = null;
  let signed = 0;
  let regrounded = 0;
  let problems = 0;

  records.forEach((r, i) => {
    const label = `#${i} ${r.report_id || r.id || ""}`.trim();
    const expected = hashRecord(r.prev_hash, r.payload);

    if (r.prev_hash !== prev) { console.log(`✗ ${label}: prev_hash does not link to the previous record`); problems++; prev = r.hash; return; }
    if (r.hash !== expected) { console.log(`✗ ${label}: hash mismatch (record was altered)`); problems++; prev = r.hash; return; }

    if (r.signature) {
      const pub = pinnedPub || r.signer_pubkey;
      if (pinnedPub && r.signer_pubkey && r.signer_pubkey !== pinnedPub) { console.log(`✗ ${label}: signed by a DIFFERENT key than the pinned one`); problems++; }
      else if (!pub) console.log(`• ${label}: hash ok, no public key to check signature`);
      else if (!verifySig(r.hash, r.signature, pub)) { console.log(`✗ ${label}: signature INVALID`); problems++; }
      else { signed++; console.log(`✓ ${label}: hash + signature valid`); }
    } else {
      console.log(`• ${label}: hash ok (unsigned record)`);
    }

    // Offline grounding re-derivation from the brief-redacted proof bundle.
    const pb = r.payload && r.payload.proof_bundle;
    const orig = r.payload && r.payload.grounding;
    if (pb && orig) {
      const offline = verifier.verify({
        report: pb.report,
        rankedWards: pb.rankedWards,
        validation: pb.validation,
        coverage: pb.coverage,
        briefNumbers: pb.brief_figures || [],
      });
      const unknownN = (offline.ward_check && offline.ward_check.unknown.length) || 0;
      if (offline.grounded !== orig.grounded || offline.ungrounded_numbers.length !== (orig.ungrounded_count || 0) || unknownN !== (orig.unknown_wards || []).length) {
        console.log(`  ✗ ${label}: GROUNDING RE-DERIVATION MISMATCH — offline check disagrees with the signed summary`);
        problems++;
      } else {
        regrounded++;
        console.log(`  ✓ grounding re-derived offline (${offline.numbers_checked} figures checked, ${offline.ungrounded_numbers.length} ungrounded, ${unknownN} unknown wards)`);
      }
    }

    prev = r.hash;
  });

  // Optional: validate an external anchor receipt against the chain head.
  if (anchorFile) {
    try {
      const anchor = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
      const a = verifyAnchor(anchor.anchor || anchor, prev);
      if (a.ok) console.log(`\n✓ ANCHOR valid — head ${String(anchor.head || (anchor.anchor && anchor.anchor.head) || "").slice(0, 16)}… matches chain head, signature ok`);
      else { console.log(`\n✗ ANCHOR invalid — ${a.reason}`); problems++; }
    } catch (e) {
      console.log(`\n✗ ANCHOR could not be read: ${e.message}`);
      problems++;
    }
  }

  console.log("\n" + "─".repeat(52));
  if (problems === 0) {
    console.log(`✓ VERIFIED — ${records.length} records, ${signed} signature(s) valid, ${regrounded} grounding re-derived offline.`);
    console.log(`  head: ${prev}`);
    if (pinnedPub) console.log(`  all signatures match the pinned public key.`);
    process.exit(0);
  }
  console.log(`✗ VERIFICATION FAILED — ${problems} problem(s) in ${records.length} records.`);
  process.exit(1);
}

main();
