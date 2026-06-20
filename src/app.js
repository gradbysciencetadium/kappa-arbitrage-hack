// Express app: Kappy intake (/api/chat) + async Bara analysis (/api/analyze + /api/report/:id)
// + lead capture (/api/lead). All state goes through the persistence layer (src/data/db.js),
// which uses Supabase when configured and an in-memory fallback otherwise.

const express = require("express");
const path = require("path");

const db = require("./data/db");
const store = require("./data/store");
const auth = require("./auth");
const ledger = require("./governance/ledger");
const validationSeed = require("./governance/validation-seed.json");
const { runKappy, detectBrief, stripBriefBlock } = require("./kappy");
const coverage = require("./kappy/coverage");
const { runBara } = require("./bara");

// Resolve the authenticated user from the Authorization: Bearer <token> header (or null).
async function authUser(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return auth.verifyToken(m[1].trim());
}

// Optionally publish an anchor receipt to a PUBLIC GitHub repo (set GITHUB_ANCHOR_REPO=
// "owner/name" + GITHUB_ANCHOR_TOKEN). The repo's git history is an externally-hosted,
// append-only witness of the chain head — verifiable without trusting our server.
async function publishAnchorToGitHub(anchor) {
  const repo = process.env.GITHUB_ANCHOR_REPO;
  const token = process.env.GITHUB_ANCHOR_TOKEN;
  const path = `ledger-anchors/anchor-${anchor.count}-${String(anchor.head).slice(0, 12)}.json`;
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const body = {
    message: `ledger anchor #${anchor.count} (head ${String(anchor.head).slice(0, 12)})`,
    content: Buffer.from(JSON.stringify(anchor, null, 2)).toString("base64"),
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || `GitHub ${r.status}`);
  return d.commit && d.commit.html_url;
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- Accounts (Supabase Auth, email + password) ---
  app.post("/api/auth/signup", async (req, res) => {
    const { email, password } = req.body || {};
    try {
      res.json(await auth.signup(email, password));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body || {};
    try {
      res.json(await auth.login(email, password));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Who am I? (used by the frontend on load to restore the session)
  app.get("/api/auth/me", async (req, res) => {
    const user = await authUser(req);
    res.json({ enabled: auth.enabled(), user });
  });

  // List the signed-in user's saved consultations (newest first).
  app.get("/api/conversations", async (req, res) => {
    const user = await authUser(req);
    if (!user) return res.json({ conversations: [] });
    try {
      res.json({ conversations: await db.getUserConversations(user.id) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Load a saved consultation (history + brief + latest report) to resume it.
  app.get("/api/conversation/:id", async (req, res) => {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "Sign in to open a saved consultation." });
    try {
      const conv = await db.getConversation(req.params.id);
      if (!conv || conv.user_id !== user.id) return res.status(404).json({ error: "Consultation not found." });

      const history = await db.getHistory(req.params.id);
      const messages = history.map((m) =>
        m.role === "model" ? { role: m.role, text: stripBriefBlock(m.text) } : m
      );
      const brief = await db.getBrief(req.params.id);
      const r = await db.getLatestReportByConversation(req.params.id);
      const report = r ? { status: r.status, result: r.result, meta: r.meta, error: r.error } : null;

      res.json({ id: conv.id, title: conv.title, messages, briefReady: !!brief, report });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Kappy intake ---
  app.post("/api/chat", async (req, res) => {
    const { message, conversationId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    try {
      const user = await authUser(req);
      let convId = conversationId;
      let isNew = false;
      if (!convId || !(await db.conversationExists(convId))) {
        convId = await db.createConversation(user ? user.id : null);
        isNew = true;
      }

      const prior = await db.getHistory(convId);
      const history = [...prior, { role: "user", text: message.trim() }];

      const reply = await runKappy(history); // throws on failure -> nothing persisted

      await db.appendMessage(convId, "user", message.trim());
      await db.appendMessage(convId, "model", reply);
      if (isNew) db.setConversationTitle(convId, message.trim().slice(0, 60)).catch(() => {});

      const brief = detectBrief(reply);
      if (brief) {
        // Data-aware gate: only hand off to Bara if we actually have data for the location.
        // Smart resolution — LA name, ward/neighbourhood, then model inference (constrained
        // to the real covered list) — so a place INSIDE a covered LA still resolves.
        const cov = await coverage.resolveLocationSmart(brief.location_focus);
        if (cov.status === "covered") {
          brief.location_focus = cov.canonical; // normalise to the exact dataset name
          await db.saveBrief(convId, brief);
          return res.json({ conversationId: convId, reply: stripBriefBlock(reply), briefReady: true });
        }
        // Uncovered/unknown: do NOT hand off a doomed brief — steer to covered areas.
        const list = cov.covered.join(", ");
        const note =
          stripBriefBlock(reply) +
          `\n\n---\n**Before Bara runs:** I don't yet have live childcare data for **${brief.location_focus || "that location"}**, and Bara won't invent figures. ` +
          `We currently cover: ${list}.\n\nPick one of those and I'll hand it straight to Bara, or tell me which area to add next.`;
        return res.json({
          conversationId: convId,
          reply: note,
          coverage: { status: cov.status, requested: brief.location_focus || null, covered: cov.covered },
        });
      }
      return res.json({ conversationId: convId, reply });
    } catch (err) {
      console.error("Chat error:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // --- Bara analysis: kick off, return immediately (async job) ---
  app.post("/api/analyze", async (req, res) => {
    const { conversationId } = req.body || {};
    try {
      const brief = conversationId && (await db.getBrief(conversationId));
      if (!brief) {
        return res.status(400).json({ error: "No completed intake brief for this conversation yet." });
      }
      const reportId = await db.createReport(conversationId, brief);

      // Run Bara in the background; write progress + result to the report row, then
      // record a tamper-evident audit-ledger entry (the Track-3 governance trail).
      runBara(brief, { onProgress: (p) => db.setReportProgress(reportId, p).catch(() => {}) })
        .then(async ({ report, meta }) => {
          await db.finishReport(reportId, report, meta);
          try {
            const prev = await db.getLastLedgerHash();
            const record = ledger.makeRecord({ reportId, conversationId, brief, report, meta }, prev);
            await db.appendLedger(record); // signed, timestamped, hash-chained
          } catch (e) {
            console.warn("Ledger append failed:", e.message);
          }
        })
        .catch((e) => db.failReport(reportId, e.message));

      res.status(202).json({ reportId });
    } catch (err) {
      console.error("Analyze error:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // --- Poll a report's status/result ---
  app.get("/api/report/:id", async (req, res) => {
    try {
      const r = await db.getReport(req.params.id);
      if (!r) return res.status(404).json({ error: "Report not found." });
      res.json({ status: r.status, progress: r.progress, result: r.result, meta: r.meta, error: r.error });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- AI Accountability Ledger (FLock Track 3: governance, transparency, trust) ---
  // The tamper-evident audit trail of every analysis + the backtest accuracy record.
  app.get("/api/ledger", async (req, res) => {
    try {
      const records = await db.getLedger();
      const seedCases = validationSeed.cases || [];
      const seedAgree = seedCases.filter((c) => c.agreement === "agrees").length;
      const live = ledger.accuracyFromRecords(records);
      const synth = require("./llm/models.config").resolveRole("SYNTH");
      const sovereign = synth.provider === "flock";
      const anchor = await db.getLatestAnchor();
      const integrity = ledger.verifyChain(records);

      res.json({
        integrity, // recomputes the hash chain AND verifies signatures
        analyses: records.length,
        records,
        signing: ledger.keyInfo(), // ed25519 public key + signer fingerprint
        anchor: anchor ? { ...anchor, verified: ledger.verifyAnchor(anchor) } : null,
        // Seed (illustrative) accuracy is kept STRICTLY separate from live, verified
        // accuracy — the seed cases are hand-authored for the demo, not a track record.
        backtest: {
          seed_demo: {
            disclaimer: "Illustrative hand-authored cases for demonstration — NOT a live track record.",
            note: validationSeed._meta && validationSeed._meta.what,
            cases: seedCases,
            validated: seedCases.length,
            agreements: seedAgree,
            accuracy_pct: seedCases.length ? Math.round((seedAgree / seedCases.length) * 100) : null,
          },
          live: {
            note: "Out-of-sample predictions resolved against real outcomes (none yet until openings resolve).",
            validated: live.validated,
            agreements: live.agreements,
            accuracy_pct: live.validated ? Math.round((live.agreements / live.validated) * 100) : null,
          },
        },
        sovereign: {
          provider: synth.provider,
          model: synth.model,
          active: sovereign,
          note: sovereign
            ? "Inference is routed through FLock's sovereign-aligned model; each record binds a SHA-256 of the model's output."
            : `Inference provider is "${synth.provider}". Set SOVEREIGN_AI=1 with a FLock key to route through FLock sovereign inference.`,
        },
        what_this_proves: [
          "Integrity: re-hashing the chain detects any edit, insertion or reordering of records.",
          "Authorship & time: each record is Ed25519-signed and carries a signed timestamp inside the hash.",
          "Grounding: every figure in each report was checked against the deterministic substrate before logging.",
        ],
        what_this_does_not_prove: [
          "It does not prove the analysis is correct — only that the record is intact and authentic.",
          anchor
            ? "Anchored externally, so outsiders can witness the chain head independently."
            : "Until the head hash is anchored externally (POST /api/ledger/anchor), integrity is only verifiable by parties who trust this server.",
        ],
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Public signing key — lets anyone independently verify record signatures.
  app.get("/api/ledger/pubkey", (req, res) => res.json(ledger.keyInfo()));

  // Anchor the current chain head externally: build a signed, portable receipt (and
  // optionally publish it to a public GitHub repo) so the ledger becomes tamper-evident
  // to outsiders, not just to the operator.
  app.post("/api/ledger/anchor", async (req, res) => {
    try {
      const records = await db.getLedger();
      const integrity = ledger.verifyChain(records);
      const anchor = ledger.buildAnchor(integrity.head, records.length);
      if (process.env.GITHUB_ANCHOR_TOKEN && process.env.GITHUB_ANCHOR_REPO) {
        try {
          anchor.external_proof = await publishAnchorToGitHub(anchor);
        } catch (e) {
          console.warn("Anchor publish failed:", e.message);
        }
      }
      await db.saveAnchor(anchor);
      res.json({ ok: true, anchor, verified: ledger.verifyAnchor(anchor) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Live chain verification + tamper demo (the governance "money shot") ---
  // Recomputes the whole hash chain. ?tamper=1 corrupts one entry in a COPY before
  // recomputing, to demonstrate that any edit is detected — tamper-evident, live.
  app.get("/api/ledger/verify", async (req, res) => {
    try {
      let records = await db.getLedger();
      const tamper = req.query.tamper === "1";
      let tamperedIndex = null;
      if (tamper && records.length) {
        records = records.map((r) => ({ ...r, payload: { ...r.payload } }));
        tamperedIndex = Math.floor(records.length / 2);
        records[tamperedIndex] = {
          ...records[tamperedIndex],
          payload: { ...records[tamperedIndex].payload, _edited_after_the_fact: true },
        };
      }
      const result = ledger.verifyChain(records);
      res.json({ ...result, tampered: tamper, tampered_index: tamperedIndex });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Post-market AI risk monitor (EU AI Act Art. 72 style) ---
  // Computed entirely over the signed, hash-chained ledger; every figure is therefore
  // independently re-derivable via scripts/verify-ledger.js. Rates are gated behind a
  // minimum sample size so we never advertise a percentage off 1-2 records.
  app.get("/api/risk-monitor", async (req, res) => {
    try {
      const records = await db.getLedger();
      const n = records.length;
      const MIN_N = 3;
      let groundingFailures = 0, caughtHallucinations = 0, lowConfidence = 0, lowCoverage = 0, sovereign = 0, offSovereign = 0;
      for (const r of records) {
        const p = r.payload || {};
        const g = p.grounding;
        if (g && g.grounded === false) groundingFailures++;
        if (g && Array.isArray(g.unknown_wards)) caughtHallucinations += g.unknown_wards.length;
        const conf = p.prediction && p.prediction.confidence;
        if (typeof conf === "number" && conf < 0.7) lowConfidence++;
        if (p.coverage && typeof p.coverage.group_based_geocoded_pct === "number" && p.coverage.group_based_geocoded_pct < 80) lowCoverage++;
        if (p.model && p.model.sovereign === true) sovereign++; else offSovereign++;
      }
      const enough = n >= MIN_N;
      const pct = (x) => (enough ? Math.round((x / n) * 1000) / 10 : null);
      const alerts = [];
      if (enough) {
        if (groundingFailures / n > 0.1) alerts.push(`Grounding-failure rate ${pct(groundingFailures)}% exceeds the 10% threshold.`);
        if (offSovereign > 0) alerts.push(`${offSovereign}/${n} analyses ran off sovereign (FLock) inference.`);
        if (lowCoverage / n > 0.25) alerts.push(`${lowCoverage}/${n} analyses ran on low data coverage (<80% geocoded).`);
      }
      res.json({
        sample_size: n,
        min_sample: MIN_N,
        status: enough ? "ok" : "insufficient_data",
        metrics: {
          caught_hallucinations: caughtHallucinations, // absolute — always meaningful
          grounding_failure_rate_pct: pct(groundingFailures),
          low_confidence_count: lowConfidence,
          low_coverage_count: lowCoverage,
          sovereign_share_pct: pct(sovereign),
          off_sovereign_count: offSovereign,
        },
        alerts,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Live coverage stats (for the hero) ---
  let _statsCache = null;
  app.get("/api/stats", (req, res) => {
    try {
      if (!_statsCache) {
        const las = store.availableLocalAuthorities();
        let providers = 0, wards = 0;
        for (const la of las) { providers += store.listProviders(la).length; wards += store.listAreas(la).length; }
        _statsCache = { localAuthorities: las.length, providers, wards };
      }
      res.json({ ..._statsCache, sovereign: process.env.SOVEREIGN_AI === "1" || process.env.SOVEREIGN_AI === "true" });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // --- Lead capture (the "apply for a free deep-dive" funnel) ---
  app.post("/api/lead", async (req, res) => {
    const { email, name, business, note, conversationId } = req.body || {};
    if (!email || !/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: "A valid email is required." });
    }
    try {
      const id = await db.saveLead({ email, name, business, note, conversation_id: conversationId });
      res.json({ ok: true, id });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createApp };
