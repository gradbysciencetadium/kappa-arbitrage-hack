// Persistence layer. One async interface for conversations, briefs, reports, and leads.
// Backed by Supabase when SUPABASE_URL + SUPABASE_KEY are set; otherwise an in-memory
// fallback so the app still runs locally with zero config. Nothing else in the app needs
// to know which backend is active.

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
let backend = "memory"; // "memory" until the schema probe confirms "supabase"

if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    // Probe the schema. Stay on in-memory until confirmed, so a missing schema never
    // breaks a request — it just means "run supabase/schema.sql".
    supabase
      .from("reports")
      .select("id")
      .limit(1)
      .then(({ error }) => {
        if (error) {
          console.warn(
            "Persistence: Supabase reachable but schema not applied — run supabase/schema.sql. " +
              "Using in-memory until then. (" + error.message + ")"
          );
          supabase = null;
          backend = "memory";
        } else {
          backend = "supabase";
          console.log("Persistence: Supabase connected (schema OK).");
        }
      });
  } catch (e) {
    console.warn("Persistence: Supabase client failed to init, using in-memory:", e.message);
  }
} else {
  console.log("Persistence: in-memory (set SUPABASE_URL + SUPABASE_KEY to persist).");
}

const usingSupabase = () => backend === "supabase";

/* ------------------------------------------------------------------ *
 * In-memory fallback store
 * ------------------------------------------------------------------ */
const mem = {
  conversations: new Map(), // id -> { id, messages: [{role,text}], brief }
  reports: new Map(), // id -> report row
  leads: [],
  ledger: [], // audit-ledger records (append-only)
};

/* ------------------------------------------------------------------ *
 * Conversations + messages
 * ------------------------------------------------------------------ */
async function createConversation() {
  const id = crypto.randomUUID();
  if (usingSupabase()) {
    await supabase.from("conversations").insert({ id });
  } else {
    mem.conversations.set(id, { id, messages: [], brief: null });
  }
  return id;
}

async function appendMessage(conversationId, role, text) {
  if (usingSupabase()) {
    await supabase.from("messages").insert({ conversation_id: conversationId, role, text });
  } else {
    const c = mem.conversations.get(conversationId);
    if (c) c.messages.push({ role, text });
  }
}

// Returns history as [{ role, text }] in order — the shape the LLM adapter expects.
async function getHistory(conversationId) {
  if (usingSupabase()) {
    const { data } = await supabase
      .from("messages")
      .select("role, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return (data || []).map((m) => ({ role: m.role, text: m.text }));
  }
  const c = mem.conversations.get(conversationId);
  return c ? c.messages.slice() : [];
}

async function conversationExists(conversationId) {
  if (usingSupabase()) {
    const { data } = await supabase.from("conversations").select("id").eq("id", conversationId).maybeSingle();
    return !!data;
  }
  return mem.conversations.has(conversationId);
}

/* ------------------------------------------------------------------ *
 * Briefs
 * ------------------------------------------------------------------ */
async function saveBrief(conversationId, brief) {
  if (usingSupabase()) {
    await supabase.from("briefs").upsert({ conversation_id: conversationId, brief });
  } else {
    const c = mem.conversations.get(conversationId);
    if (c) c.brief = brief;
  }
}

async function getBrief(conversationId) {
  if (usingSupabase()) {
    const { data } = await supabase
      .from("briefs")
      .select("brief")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    return data ? data.brief : null;
  }
  const c = mem.conversations.get(conversationId);
  return c ? c.brief : null;
}

/* ------------------------------------------------------------------ *
 * Reports (async job records)
 * ------------------------------------------------------------------ */
async function createReport(conversationId, brief) {
  const id = crypto.randomUUID();
  const row = {
    id,
    conversation_id: conversationId,
    brief,
    status: "pending",
    progress: "queued",
    result: null,
    meta: null,
    error: null,
  };
  if (usingSupabase()) {
    await supabase.from("reports").insert(row);
  } else {
    mem.reports.set(id, { ...row, created_at: new Date().toISOString() });
  }
  return id;
}

async function setReportProgress(reportId, progress) {
  if (usingSupabase()) {
    await supabase.from("reports").update({ status: "running", progress }).eq("id", reportId);
  } else {
    const r = mem.reports.get(reportId);
    if (r) { r.status = "running"; r.progress = progress; }
  }
}

async function finishReport(reportId, result, meta) {
  if (usingSupabase()) {
    await supabase.from("reports").update({ status: "done", progress: "done", result, meta }).eq("id", reportId);
  } else {
    const r = mem.reports.get(reportId);
    if (r) { r.status = "done"; r.progress = "done"; r.result = result; r.meta = meta; }
  }
}

async function failReport(reportId, error) {
  if (usingSupabase()) {
    await supabase.from("reports").update({ status: "failed", error: String(error) }).eq("id", reportId);
  } else {
    const r = mem.reports.get(reportId);
    if (r) { r.status = "failed"; r.error = String(error); }
  }
}

async function getReport(reportId) {
  if (usingSupabase()) {
    const { data } = await supabase.from("reports").select("*").eq("id", reportId).maybeSingle();
    return data || null;
  }
  return mem.reports.get(reportId) || null;
}

/* ------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------ */
async function saveLead(lead) {
  const row = { id: crypto.randomUUID(), ...lead };
  if (usingSupabase()) {
    await supabase.from("leads").insert(row);
  } else {
    mem.leads.push({ ...row, created_at: new Date().toISOString() });
  }
  return row.id;
}

/* ------------------------------------------------------------------ *
 * Audit ledger (append-only, hash-chained)
 * ------------------------------------------------------------------ */
async function getLastLedgerHash() {
  if (usingSupabase()) {
    const { data } = await supabase
      .from("audit_ledger")
      .select("hash")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? data.hash : null;
  }
  const last = mem.ledger[mem.ledger.length - 1];
  return last ? last.hash : null;
}

async function appendLedger(entry) {
  // entry: { report_id, prev_hash, hash, payload }
  if (usingSupabase()) {
    await supabase.from("audit_ledger").insert(entry);
  } else {
    mem.ledger.push({ id: crypto.randomUUID(), ...entry, created_at: new Date().toISOString() });
  }
}

async function getLedger() {
  if (usingSupabase()) {
    const { data } = await supabase
      .from("audit_ledger")
      .select("*")
      .order("created_at", { ascending: true });
    return data || [];
  }
  return mem.ledger.slice();
}

module.exports = {
  usingSupabase,
  createConversation,
  appendMessage,
  getHistory,
  conversationExists,
  saveBrief,
  getBrief,
  createReport,
  setReportProgress,
  finishReport,
  failReport,
  getReport,
  saveLead,
  getLastLedgerHash,
  appendLedger,
  getLedger,
};
