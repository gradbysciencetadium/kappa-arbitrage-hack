// Express app: Kappy intake (/api/chat) + async Bara analysis (/api/analyze + /api/report/:id)
// + lead capture (/api/lead). All state goes through the persistence layer (src/data/db.js),
// which uses Supabase when configured and an in-memory fallback otherwise.

const express = require("express");
const path = require("path");

const db = require("./data/db");
const ledger = require("./governance/ledger");
const validationSeed = require("./governance/validation-seed.json");
const { runKappy, detectBrief, stripBriefBlock } = require("./kappy");
const { runBara } = require("./bara");

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  // --- Kappy intake ---
  app.post("/api/chat", async (req, res) => {
    const { message, conversationId } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }

    try {
      let convId = conversationId;
      if (!convId || !(await db.conversationExists(convId))) {
        convId = await db.createConversation();
      }

      const prior = await db.getHistory(convId);
      const history = [...prior, { role: "user", text: message.trim() }];

      const reply = await runKappy(history); // throws on failure -> nothing persisted

      await db.appendMessage(convId, "user", message.trim());
      await db.appendMessage(convId, "model", reply);

      const brief = detectBrief(reply);
      if (brief) {
        await db.saveBrief(convId, brief);
        return res.json({ conversationId: convId, reply: stripBriefBlock(reply), briefReady: true });
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
            const payload = ledger.buildPayload({ reportId, conversationId, brief, report, meta });
            const prev = await db.getLastLedgerHash();
            const hash = ledger.hashRecord(prev, payload);
            await db.appendLedger({ report_id: reportId, prev_hash: prev, hash, payload });
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
      const live = ledger.accuracyFromRecords(records);
      const seedAgree = seedCases.filter((c) => c.agreement === "agrees").length;
      const validated = seedCases.length + live.validated;
      const agreements = seedAgree + live.agreements;
      const synth = require("./llm/models.config").resolveRole("SYNTH");
      res.json({
        integrity: ledger.verifyChain(records), // recomputes the hash chain
        analyses: records.length,
        records,
        backtest: {
          note: validationSeed._meta && validationSeed._meta.what,
          cases: seedCases,
          validated,
          agreements,
          directional_accuracy_pct: validated ? Math.round((agreements / validated) * 100) : null,
        },
        sovereign: {
          provider: synth.provider,
          model: synth.model,
          active: synth.provider === "flock",
          note: "Inference routed through FLock's sovereign-aligned model when SOVEREIGN_AI=1.",
        },
      });
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
