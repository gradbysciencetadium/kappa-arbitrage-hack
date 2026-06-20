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
const { runBara } = require("./bara");

// Resolve the authenticated user from the Authorization: Bearer <token> header (or null).
async function authUser(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return auth.verifyToken(m[1].trim());
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
