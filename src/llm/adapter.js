// Neutral LLM interface. Every pipeline stage calls callModel({ role, ... }) and
// never touches a provider directly — so changing a model is a config edit, not a
// code change. Handles JSON parsing + one repair retry when a schema is requested.

const { resolveRole } = require("./models.config");
const gemini = require("./providers/gemini");
const openaiCompatible = require("./providers/openaiCompatible");
const flock = require("./providers/flock");

const PROVIDERS = {
  gemini,
  "openai-compatible": openaiCompatible,
  flock,
};

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown LLM provider: ${name}`);
  return p;
}

function stripCodeFences(text) {
  // Models sometimes wrap JSON in ```json ... ``` despite instructions.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * callModel
 * @param {object} opts
 * @param {string} opts.role      - KAPPY | PLANNER | CRITIC | WORKER | SYNTH | JUDGE
 * @param {string} [opts.system]  - system instruction
 * @param {Array}  opts.messages  - [{ role: "user"|"assistant"|"model", text }]
 * @param {object} [opts.schema]  - JSON schema; when given, returns parsed JSON
 * @param {number} [opts.temperature]
 * @returns {Promise<string|object>} text, or parsed object if schema given
 */
async function callModel({ role, system, messages, schema, temperature }) {
  const { provider, model } = resolveRole(role);
  const impl = getProvider(provider);

  const raw = await impl.generate({ model, system, messages, schema, temperature });
  if (!schema) return raw;

  // Parse + one repair attempt.
  try {
    return JSON.parse(stripCodeFences(raw));
  } catch (_) {
    const repair = await impl.generate({
      model,
      system,
      messages: [
        ...messages,
        { role: "assistant", text: raw },
        { role: "user", text: "That was not valid JSON. Return ONLY the JSON object, no prose, no code fences." },
      ],
      schema,
      temperature: 0,
    });
    return JSON.parse(stripCodeFences(repair));
  }
}

module.exports = { callModel };
