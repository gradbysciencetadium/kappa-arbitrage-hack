// Persistence layer. One async interface for conversations, briefs, reports, and leads.
// Backed by Supabase when SUPABASE_URL + SUPABASE_KEY are set; otherwise an in-memory
// fallback so the app still runs locally with zero config. Nothing else in the app needs
// to know which backend is active.

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;
let backend = "memory"; // "memory" until the schema probe confirms "supabase"
let userScoped = false; // true once we confirm conversations.user_id exists (accounts enabled)

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
          // Secondary probe: are the account columns present? If not, run the updated
          // supabase/schema.sql. Until then we operate anonymously (no breakage).
          supabase
            .from("conversations")
            .select("user_id")
            .limit(1)
            .then(({ error: e2 }) => {
              userScoped = !e2;
              if (e2) {
                console.warn(
                  "Persistence: accounts disabled — conversations.user_id missing. " +
                    "Run the updated supabase/schema.sql to enable saved consultations."
                );
              } else {
                console.log("Persistence: accounts enabled (per-user consultations).");
              }
            });
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
async function createConversation(userId = null) {
  const id = crypto.randomUUID();
  if (usingSupabase()) {
    await supabase.from("conversations").insert(userScoped ? { id, user_id: userId } : { id });
  } else {
    mem.conversations.set(id, {
      id,
      user_id: userId,
      title: null,
      messages: [],
      brief: null,
      created_at: new Date().toISOString(),
    });
  }
  return id;
}

// Set a conversation's display title (used for the "My consultations" list).
async function setConversationTitle(id, title) {
  title = String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) return;
  if (usingSupabase()) {
    if (!userScoped) return; // title column not present yet
    await supabase.from("conversations").update({ title }).eq("id", id);
  } else {
    const c = mem.conversations.get(id);
    if (c) c.title = title;
  }
}

async function getConversation(id) {
  if (usingSupabase()) {
    if (!userScoped) return null; // can't establish ownership without user_id
    const { data } = await supabase
      .from("conversations")
      .select("id, user_id, title, created_at")
      .eq("id", id)
      .maybeSingle();
    return data || null;
  }
  const c = mem.conversations.get(id);
  return c ? { id: c.id, user_id: c.user_id, title: c.title, created_at: c.created_at } : null;
}

// List a user's conversations (newest first), each annotated with whether a report exists.
async function getUserConversations(userId) {
  if (!userId) return [];
  if (usingSupabase()) {
    if (!userScoped) return [];
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, title, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);
    const list = convs || [];
    if (!list.length) return [];
    const ids = list.map((c) => c.id);
    const { data: reps } = await supabase
      .from("reports")
      .select("conversation_id, status")
      .in("conversation_id", ids);
    const repByConv = {};
    (reps || []).forEach((r) => {
      if (repByConv[r.conversation_id] !== "done") repByConv[r.conversation_id] = r.status;
    });
    return list.map((c) => ({
      id: c.id,
      title: c.title,
      created_at: c.created_at,
      reportStatus: repByConv[c.id] || null,
    }));
  }
  const out = [];
  for (const c of mem.conversations.values()) {
    if (c.user_id !== userId) continue;
    let reportStatus = null;
    for (const r of mem.reports.values()) {
      if (r.conversation_id !== c.id) continue;
      reportStatus = r.status === "done" ? "done" : reportStatus || r.status;
    }
    out.push({ id: c.id, title: c.title, created_at: c.created_at || null, reportStatus });
  }
  out.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return out;
}

// Latest report for a conversation (for resuming a finished consultation).
async function getLatestReportByConversation(conversationId) {
  if (usingSupabase()) {
    const { data } = await supabase
      .from("reports")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data || null;
  }
  let latest = null;
  for (const r of mem.reports.values()) {
    if (r.conversation_id !== conversationId) continue;
    if (!latest || String(r.created_at || "") > String(latest.created_at || "")) latest = r;
  }
  return latest;
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
  setConversationTitle,
  getConversation,
  getUserConversations,
  getLatestReportByConversation,
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
