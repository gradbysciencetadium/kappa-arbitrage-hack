// Gemini provider adapter. Translates the neutral message format used by the
// LLM adapter into Gemini's REST shape and normalizes the response.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Convert neutral messages [{ role: "user"|"assistant"|"model", text }]
// into Gemini "contents" [{ role: "user"|"model", parts: [{ text }] }].
function toContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : m.role === "model" ? "model" : "user",
    parts: [{ text: m.text }],
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 5);

// Pull Google's suggested retry delay (e.g. "33s") from a 429 error body, if present.
function suggestedDelayMs(data) {
  const details = data?.error?.details || [];
  for (const d of details) {
    if (d.retryDelay && /^\d+(\.\d+)?s$/.test(d.retryDelay)) {
      return Math.ceil(parseFloat(d.retryDelay) * 1000);
    }
  }
  return null;
}

async function generate({ model, system, messages, schema, temperature = 0.7, apiKey }) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set.");

  const body = {
    contents: toContents(messages),
    generationConfig: { temperature },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  if (schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = schema;
  }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join("");
      if (!text.trim()) {
        const reason = data?.candidates?.[0]?.finishReason || "no content";
        throw new Error(`Gemini returned an empty response (${reason}).`);
      }
      return text;
    }

    // Retry on rate-limit (429) and transient overload (503).
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const wait =
        suggestedDelayMs(data) ||
        Math.min(40000, 4000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 1000);
      await sleep(wait);
      lastErr = data?.error?.message || `HTTP ${res.status}`;
      continue;
    }
    throw new Error(data?.error?.message || `Gemini API error (HTTP ${res.status})`);
  }
  throw new Error(lastErr || "Gemini API: exhausted retries.");
}

module.exports = { generate };
