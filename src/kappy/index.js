// Kappy turn handler + brief detection.
// runKappy(history) -> assistant reply text.
// detectBrief(text) -> parsed brief object if Kappy emitted the handoff JSON, else null.

const { callModel } = require("../llm/adapter");
const { KAPPY_SYSTEM_PROMPT } = require("./prompt");
const { coveredList } = require("./coverage");

// Inject live data coverage so Kappy steers clients to areas Bara can actually analyse,
// rather than confidently accepting a location that will yield an empty "no data" report.
function systemPrompt() {
  const covered = coveredList();
  if (!covered.length) return KAPPY_SYSTEM_PROMPT;
  return (
    KAPPY_SYSTEM_PROMPT +
    `\n\nDATA COVERAGE (childcare): Bara has live data ONLY for these UK local authorities: ` +
    covered.join(", ") +
    `. If the client's location is not clearly one of these, say so honestly and steer them to the nearest covered area BEFORE completing the brief — never promise a data-backed analysis for an area we don't cover.`
  );
}

async function runKappy(history) {
  return callModel({
    role: "KAPPY",
    system: systemPrompt(),
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
