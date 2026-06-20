// OpenAI-compatible provider adapter — works with Groq and OpenRouter (both expose
// the OpenAI chat-completions API). Lets you route any stage to a free Llama, etc.
// Configure via env: OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY
// (e.g. Groq: https://api.groq.com/openai/v1 ; OpenRouter: https://openrouter.ai/api/v1).

function toMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    out.push({
      role: m.role === "model" ? "assistant" : m.role,
      content: m.text,
    });
  }
  return out;
}

async function generate({ model, system, messages, schema, temperature = 0.7 }) {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL;
  const key = process.env.OPENAI_COMPAT_API_KEY;
  if (!baseUrl || !key) {
    throw new Error(
      "OpenAI-compatible provider needs OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY."
    );
  }

  const body = {
    model,
    messages: toMessages(system, messages),
    temperature,
  };
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "structured_output", schema, strict: true },
    };
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `OpenAI-compatible API error (HTTP ${res.status})`);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("OpenAI-compatible provider returned an empty response.");
  return text;
}

module.exports = { generate };
