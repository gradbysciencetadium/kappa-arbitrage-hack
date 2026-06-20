// Per-stage model routing. Each pipeline stage names a ROLE; this maps the role
// to a concrete provider + model. Swapping a model anywhere = change one line here
// (or set the matching env var). No pipeline code changes.
//
// Providers supported by the adapter: "gemini" (free tier), "openai-compatible"
// (Groq / OpenRouter — set BASE_URL + API key). Defaults stay on Gemini free tier.

function pick(envVar, fallback) {
  return process.env[envVar] || fallback;
}

const DEFAULT_PROVIDER = pick("LLM_PROVIDER", "gemini");
const FLASH = pick("GEMINI_MODEL", "gemini-2.5-flash");

// A "strong" role can be pointed at a more capable model when quota allows.
// Defaults to Flash so everything runs on the free tier out of the box.
const STRONG = pick("GEMINI_STRONG_MODEL", FLASH);

const ROLES = {
  // Intake conversation — cheap, high volume.
  KAPPY: { provider: pick("KAPPY_PROVIDER", DEFAULT_PROVIDER), model: pick("KAPPY_MODEL", FLASH) },
  // Hardest reasoning, low call volume — give it the strongest model available.
  PLANNER: { provider: pick("PLANNER_PROVIDER", DEFAULT_PROVIDER), model: pick("PLANNER_MODEL", STRONG) },
  // Data-blind plan reviewer.
  CRITIC: { provider: pick("CRITIC_PROVIDER", DEFAULT_PROVIDER), model: pick("CRITIC_MODEL", STRONG) },
  // Parallel data workers — narrow scope, high volume.
  WORKER: { provider: pick("WORKER_PROVIDER", DEFAULT_PROVIDER), model: pick("WORKER_MODEL", FLASH) },
  // Final report synthesis — quality matters most.
  SYNTH: { provider: pick("SYNTH_PROVIDER", DEFAULT_PROVIDER), model: pick("SYNTH_MODEL", STRONG) },
  // LLM-as-judge soundness scoring — easy task, cheap model.
  JUDGE: { provider: pick("JUDGE_PROVIDER", DEFAULT_PROVIDER), model: pick("JUDGE_MODEL", FLASH) },
};

// "UK Sovereign AI" mode: one switch routes every stage through FLock's sovereign-aligned
// inference. Per-role overrides above still win if explicitly set.
const SOVEREIGN = process.env.SOVEREIGN_AI === "1" || process.env.SOVEREIGN_AI === "true";
const FLOCK_MODEL = pick("FLOCK_MODEL", "Qwen3-30B");
if (SOVEREIGN) {
  for (const role of Object.keys(ROLES)) {
    const explicitProvider = process.env[`${role}_PROVIDER`];
    if (!explicitProvider) ROLES[role] = { provider: "flock", model: pick(`${role}_MODEL`, FLOCK_MODEL) };
  }
  console.log(`Sovereign AI mode ON — routing inference through FLock (${FLOCK_MODEL}).`);
}

function resolveRole(role) {
  const r = ROLES[role];
  if (!r) throw new Error(`Unknown model role: ${role}`);
  return r;
}

module.exports = { ROLES, resolveRole };
