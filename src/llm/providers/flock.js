// FLock provider — "UK Sovereign AI". FLock exposes an OpenAI-compatible inference API
// (https://api.flock.io/v1). Turning on Sovereign mode routes Bara/Kappy through
// sovereign-aligned, auditable inference instead of Gemini. Config:
//   SOVEREIGN_AI=1
//   FLOCK_API_KEY=...        (from api.flock.io)
//   FLOCK_MODEL=<model id>   (from FLock's "list models" — e.g. a Qwen3 model)

const BASE = (process.env.FLOCK_BASE_URL || "https://api.flock.io/v1").replace(/\/$/, "");

function toMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    out.push({ role: m.role === "model" ? "assistant" : m.role, content: m.text });
  }
  return out;
}

async function generate({ model, system, messages, schema, temperature = 0.7 }) {
  const key = process.env.FLOCK_API_KEY;
  if (!key) throw new Error("FLOCK_API_KEY is not set (Sovereign AI / FLock mode).");

  const msgs = toMessages(system, messages);
  // FLock structured-output support is provider-dependent, so we prompt for JSON rather
  // than rely on response_format; the adapter parses + repairs if needed.
  if (schema) {
    msgs.push({
      role: "user",
      text: undefined,
      content:
        "Return ONLY a single JSON object conforming to this JSON schema. No prose, no markdown fences:\n" +
        JSON.stringify(schema),
    });
  }

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: msgs, temperature }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `FLock API error (HTTP ${res.status})`);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("FLock returned an empty response.");
  return text;
}

module.exports = { generate };
