// Kappy turn handler + brief detection.
// runKappy(history) -> assistant reply text.
// detectBrief(text) -> parsed brief object if Kappy emitted the handoff JSON, else null.

const { callModel } = require("../llm/adapter");
const { KAPPY_SYSTEM_PROMPT } = require("./prompt");

async function runKappy(history) {
  return callModel({
    role: "KAPPY",
    system: KAPPY_SYSTEM_PROMPT,
    messages: history,
    temperature: 0.7,
  });
}

// Pull the handoff brief out of Kappy's message, if present.
function detectBrief(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (!fenced) return null;
  try {
    const parsed = JSON.parse(fenced[1].trim());
    if (parsed && parsed.brief && parsed.brief.strategic_question) {
      return parsed.brief;
    }
  } catch (_) {
    /* not a valid brief block */
  }
  return null;
}

// The prose Kappy shows the user once the brief is ready (strip the JSON block).
function stripBriefBlock(text) {
  return text.replace(/```json\s*[\s\S]*?```/i, "").trim();
}

module.exports = { runKappy, detectBrief, stripBriefBlock };
