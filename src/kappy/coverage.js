// Data-aware coverage for Kappy. A frontier model has no idea which local authorities this
// deployment actually has data for — so Kappy reads the real data layer and refuses to hand
// Bara a location he can't analyse, steering the client to a covered area instead.
//
// Resolution is LAYERED, not a dumb string match:
//   1. deterministic — match the LA name, or a WARD/neighbourhood name inside a covered LA
//      (so "Selhurst" or "Addiscombe" resolve to Croydon, not "uncovered");
//   2. inference     — if that fails, ask the model which covered LA the place belongs to
//      (handles towns, regions, postcodes and misspellings the data can't enumerate).
// The model only ever CHOOSES from the real covered list; code makes the final call, so the
// guarantee stays hard while the matching gets smart.

const store = require("../data/store");
const { callModel } = require("../llm/adapter");

let _covered = null;
let _wardIndex = null;

function coveredList() {
  if (!_covered) _covered = store.availableLocalAuthorities().filter(Boolean).sort();
  return _covered;
}

const norm = (s) => String(s || "").trim().toLowerCase();

// Map every ward/neighbourhood name -> the covered LA(s) that contain it.
function wardIndex() {
  if (_wardIndex) return _wardIndex;
  _wardIndex = new Map();
  for (const la of coveredList()) {
    for (const a of store.listAreas(la)) {
      const key = norm(a.ward_name);
      if (!key) continue;
      if (!_wardIndex.has(key)) _wardIndex.set(key, new Set());
      _wardIndex.get(key).add(la);
    }
  }
  return _wardIndex;
}

// Step 1 — deterministic resolution (LA name, then exact ward/neighbourhood name).
function resolveLocation(text) {
  const covered = coveredList();
  if (!text || !norm(text)) return { status: "unknown", canonical: null, covered };

  // a) the store's own LA matcher (handles "Croydon, London" / "Croy" etc.)
  const meta = store.datasetMeta(text);
  if (meta) return { status: "covered", canonical: meta.local_authority || text, covered, via: "la-name" };

  // b) a ward / neighbourhood that sits inside a covered LA (e.g. "Selhurst" -> Croydon)
  const hit = wardIndex().get(norm(text));
  if (hit && hit.size === 1) {
    return { status: "covered", canonical: [...hit][0], covered, via: "ward-name" };
  }
  if (hit && hit.size > 1) {
    // ambiguous ward name across LAs — let the caller disambiguate
    return { status: "ambiguous", canonical: null, covered, candidates: [...hit], via: "ward-name" };
  }
  return { status: "uncovered", canonical: null, covered };
}

// Step 2 — inference fallback: ask the model which covered LA the place belongs to. The
// model is constrained to pick from the real list (or NONE); code verifies the pick exists.
async function resolveLocationSmart(text) {
  const det = resolveLocation(text);
  if (det.status === "covered" || det.status === "unknown") return det;

  const covered = coveredList();
  try {
    const out = await callModel({
      role: "KAPPY",
      system:
        "You map a UK place (town, neighbourhood, postcode district, or region) to the single " +
        "local authority that contains it. You MUST choose from the provided list or answer NONE. " +
        "Reply with JSON only.",
      schema: {
        type: "object",
        properties: { local_authority: { type: "string" } },
        required: ["local_authority"],
      },
      temperature: 0,
      messages: [
        {
          role: "user",
          text:
            `Which of these local authorities contains "${text}"? Return the EXACT matching name ` +
            `from this list, or the word NONE if it is not within any:\n${covered.join(", ")}`,
        },
      ],
    });
    const guess = out && out.local_authority;
    if (guess && norm(guess) !== "none") {
      const meta = store.datasetMeta(guess);
      if (meta) return { status: "covered", canonical: meta.local_authority, covered, via: "inference" };
    }
  } catch (_) {
    /* inference unavailable — fall through to deterministic verdict */
  }
  return { status: det.status === "ambiguous" ? "ambiguous" : "uncovered", canonical: null, covered, candidates: det.candidates };
}

module.exports = { coveredList, resolveLocation, resolveLocationSmart };
