#!/usr/bin/env node
// Standalone, independent verifier for the AI Accountability Ledger.
//
// This deliberately depends on NOTHING but Node's built-in crypto — it does not import the
// app. Anyone (a judge, an auditor, a client) can run it on their own machine against an
// exported ledger to confirm the chain is intact and every record's signature is valid,
// WITHOUT trusting the server that produced it. That independence is the whole point.
//
// Usage:
//   1) curl https://<your-app>/api/ledger > ledger.json
//   2) node scripts/verify-ledger.js ledger.json [expectedPublicKeyBase64]
//
// Pin the expected public key (from /api/ledger/pubkey, ideally obtained out-of-band) to
// also prove WHO signed the records, not merely that they are internally consistent.

const fs = require("fs");
const crypto = require("crypto");

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

function main() {
  const file = process.argv[2];
  const pinnedPub = process.argv[3] || null;
  if (!file) {
    console.error("Usage: node scripts/verify-ledger.js <ledger.json> [expectedPublicKeyBase64]");
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
  let problems = 0;
  records.forEach((r, i) => {
    const label = `#${i} ${r.report_id || r.id || ""}`.trim();
    const expected = hashRecord(r.prev_hash, r.payload);
    if (r.prev_hash !== prev) { console.log(`✗ ${label}: prev_hash does not link to the previous record`); problems++; }
    else if (r.hash !== expected) { console.log(`✗ ${label}: hash mismatch (record was altered)`); problems++; }
    else if (r.signature) {
      const pub = pinnedPub || r.signer_pubkey;
      if (pinnedPub && r.signer_pubkey && r.signer_pubkey !== pinnedPub) {
        console.log(`✗ ${label}: signed by a DIFFERENT key than the pinned one`); problems++;
      } else if (!pub) {
        console.log(`• ${label}: hash ok, no public key available to check signature`);
      } else if (!verifySig(r.hash, r.signature, pub)) {
        console.log(`✗ ${label}: signature INVALID`); problems++;
      } else { signed++; console.log(`✓ ${label}: hash + signature valid`); }
    } else {
      console.log(`• ${label}: hash ok (unsigned record)`);
    }
    prev = r.hash;
  });

  console.log("\n" + "─".repeat(48));
  if (problems === 0) {
    console.log(`✓ CHAIN INTACT — ${records.length} records, ${signed} signature(s) verified.`);
    console.log(`  head: ${prev}`);
    if (pinnedPub) console.log(`  all signatures match the pinned public key.`);
    process.exit(0);
  } else {
    console.log(`✗ VERIFICATION FAILED — ${problems} problem(s) in ${records.length} records.`);
    process.exit(1);
  }
}

main();
