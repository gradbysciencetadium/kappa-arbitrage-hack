// Ofsted early-years connector — registered childcare providers + inspection outcomes.
//
// REAL SOURCE (free, key-less, official):
//   Ofsted "Childcare providers and inspections: management information" statistical data set on GOV.UK.
//   Landing page (lists every published CSV + the as-at date):
//     https://www.gov.uk/government/statistical-data-sets/childcare-providers-and-inspections-management-information
//   data.gov.uk record:
//     https://www.data.gov.uk/dataset/c893a919-98e4-4cdb-89fa-be989113223e/early-years-and-childcare-inspections-and-outcomes
//
//   We download the "most recent inspections data" bulk CSV (one row per registered provider,
//   carrying each provider's latest full inspection). The default URL below points at the
//   "as at 31 December 2025" release. Ofsted publishes twice a year (Jan/Feb for 31 Dec data,
//   Jul/Aug for 30 Jun data) and MINTS A NEW URL each time, so the asset URL is overridable via
//   the OFSTED_CSV_URL env var (no API key is ever required — this is a plain public asset).
//   Default asset (as at 31 December 2025, ~18.6 MB):
//     https://assets.publishing.service.gov.uk/media/6973934c67ae94b3280137b4/Management_information_-_childcare_providers_and_inspections_-_most_recent_inspections_data_as_at_31_December_2025.csv
//
// CSV STRUCTURE (verified against the live 31 Dec 2025 file):
//   - Row 1: a free-text title line  ("Latest inspections of all registered providers as at ...").
//   - Row 2: a free-text note line   ("This worksheet contains one table. ...").
//   - Row 3: the real column header row, beginning "Provider URN,Registration Date,Provider Type,...".
//   - Columns used here: Provider URN, Provider Type, Provider Subtype, Provider Status,
//       Provider Early Years Register Flag, Provider Compulsory Childcare Register Flag,
//       Provider Voluntary Childcare Register Flag, Provider Name, Provider Postcode,
//       Local Authority, Places, Places including Estimates,
//       "Most Recent Full: Inspection Date", "Most Recent Full: Overall Effectiveness".
//   - "Overall Effectiveness" is a NUMERIC grade (1=Outstanding, 2=Good, 3=Requires improvement,
//       4=Inadequate); blank = never had a full inspection => "Not yet inspected".
//   - Dates are DD/MM/YYYY and are converted to YYYY-MM-DD here.
//   - Childminder rows are partly REDACTED (name/address/postcode = "REDACTED") for privacy; those
//       fields are emitted as null. Provider URN, type, LA, places and rating are still present.
//
// GEOGRAPHY NOTE (important): the Ofsted file does NOT contain lat/lng or a ward_code. This connector
//   therefore emits lat:null, lng:null, ward_code:null. Those fields are intended to be enriched
//   downstream by the geography connector (postcode -> lat/lng/ward via ONS Postcode Directory /
//   postcodes.io). Records here are otherwise complete and correctly typed.
//
// Uses only Node's built-in global fetch (Node 18+/24). No npm dependencies. CommonJS module.

"use strict";

const DEFAULT_CSV_URL =
  process.env.OFSTED_CSV_URL ||
  "https://assets.publishing.service.gov.uk/media/6973934c67ae94b3280137b4/" +
    "Management_information_-_childcare_providers_and_inspections_-_most_recent_inspections_data_as_at_31_December_2025.csv";

// Numeric Ofsted "Overall Effectiveness" grade -> canonical rating string (target shape).
const GRADE_TO_RATING = {
  "1": "Outstanding",
  "2": "Good",
  "3": "Requires improvement",
  "4": "Inadequate",
};
const NOT_YET_INSPECTED = "Not yet inspected";

// Header labels we need, mapped to the keys we use internally. Matched case/space-insensitively
// so minor header churn between releases (capitalisation, stray spaces) does not break parsing.
const COLUMN_ALIASES = {
  urn: ["Provider URN"],
  type: ["Provider Type"],
  subtype: ["Provider Subtype"],
  status: ["Provider Status"],
  eyr: ["Provider Early Years Register Flag"],
  ccr: ["Provider Compulsory Childcare Register Flag"],
  vcr: ["Provider Voluntary Childcare Register Flag"],
  name: ["Provider Name"],
  postcode: ["Provider Postcode"],
  localAuthority: ["Local Authority"],
  places: ["Places"],
  placesEst: ["Places including Estimates"],
  inspectionDate: ["Most Recent Full: Inspection Date"],
  overall: ["Most Recent Full: Overall Effectiveness"],
};

const REDACTED = "REDACTED";

function norm(s) {
  return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
}

// --- Minimal RFC-4180-ish CSV line splitter (handles quoted fields, escaped "" quotes, commas). ---
function splitCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

// Split full CSV text into logical records, respecting quoted fields that contain newlines.
function splitCsvRecords(text) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // trailing field/record (no terminating newline)
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// Find the real header row (the line that starts with the "Provider URN" column) and build a
// {internalKey -> columnIndex} map from COLUMN_ALIASES.
function buildHeaderIndex(records) {
  let headerRow = -1;
  for (let r = 0; r < Math.min(records.length, 10); r++) {
    if (records[r].some((c) => norm(c) === "provider urn")) {
      headerRow = r;
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error("Ofsted CSV: could not locate the 'Provider URN' header row (unexpected file format).");
  }
  const header = records[headerRow].map(norm);
  const idx = {};
  for (const [key, labels] of Object.entries(COLUMN_ALIASES)) {
    let found = -1;
    for (const label of labels) {
      const j = header.indexOf(norm(label));
      if (j !== -1) {
        found = j;
        break;
      }
    }
    idx[key] = found; // -1 if absent; handled per-field below
  }
  if (idx.urn === -1) {
    throw new Error("Ofsted CSV: 'Provider URN' column not found in header row.");
  }
  return { headerRow, idx };
}

function cell(row, i) {
  if (i == null || i < 0 || i >= row.length) return "";
  return String(row[i] == null ? "" : row[i]).trim();
}

function cleanText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toUpperCase() === REDACTED) return null;
  return s;
}

// DD/MM/YYYY -> YYYY-MM-DD (returns null on blank/unparseable).
function toIsoDate(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // already ISO?
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  return null;
}

function toNumberOrNull(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Map the numeric "Overall Effectiveness" grade to the canonical rating string.
// Blank grade => the provider has no recorded full inspection => "Not yet inspected".
function mapRating(overallCell) {
  const s = String(overallCell == null ? "" : overallCell).trim();
  if (!s || s === "-") return NOT_YET_INSPECTED;
  if (GRADE_TO_RATING[s]) return GRADE_TO_RATING[s];
  // Some releases may carry the textual rating directly; pass it through if it is one of ours.
  const canon = Object.values(GRADE_TO_RATING).find((r) => norm(r) === norm(s));
  return canon || NOT_YET_INSPECTED;
}

// Derive [age_min, age_max] from the Ofsted register flags / provider type.
//   Early Years Register (EYR)             => birth to 5         (0..5)
//   Compulsory Childcare Register (CCR)     => 5 to 8            (extends max to 8)
//   Voluntary Childcare Register (VCR) only => 8 and over        (8..18 nominal)
// Returns numbers (never null) so the target shape's age_min/age_max are always present.
function deriveAgeRange(flags) {
  const eyr = norm(flags.eyr) === "y";
  const ccr = norm(flags.ccr) === "y";
  const vcr = norm(flags.vcr) === "y";
  if (eyr) {
    let max = 5;
    if (ccr) max = 8; // also looks after compulsory-register school-age children
    return [0, max];
  }
  if (ccr) return [5, 8];
  if (vcr) return [8, 18];
  return [0, 5]; // sensible early-years default if no flags are set
}

// Build the provider "type" string from Provider Type (+ Subtype when present), so callers see e.g.
// "Childcare on non-domestic premises - Full day care" or "Childminder".
function buildType(typeCell, subtypeCell) {
  const t = cleanText(typeCell);
  const sub = cleanText(subtypeCell);
  if (t && sub) return `${t} - ${sub}`;
  return t || sub || "Unknown";
}

// Transform one CSV data row into a target-shape provider record (or null if it has no URN).
function rowToProvider(row, idx) {
  const urn = cell(row, idx.urn);
  if (!urn) return null;

  const [ageMin, ageMax] = deriveAgeRange({
    eyr: cell(row, idx.eyr),
    ccr: cell(row, idx.ccr),
    vcr: cell(row, idx.vcr),
  });

  // Prefer the integer "Places"; fall back to "Places including Estimates" (can be fractional).
  let places = toNumberOrNull(cell(row, idx.places));
  if (places == null) places = toNumberOrNull(cell(row, idx.placesEst));

  return {
    urn,
    name: cleanText(cell(row, idx.name)), // null for REDACTED childminder rows
    type: buildType(cell(row, idx.type), cell(row, idx.subtype)),
    postcode: cleanText(cell(row, idx.postcode)), // null for REDACTED rows
    lat: null, // not in Ofsted file — enriched by the geography connector (from postcode)
    lng: null, // not in Ofsted file — enriched by the geography connector (from postcode)
    ward_code: null, // not in Ofsted file — enriched by the geography connector (from postcode)
    ofsted_rating: mapRating(cell(row, idx.overall)),
    inspection_date: toIsoDate(cell(row, idx.inspectionDate)),
    registered_places: places == null ? 0 : places,
    age_min: ageMin,
    age_max: ageMax,
    // ---- extra context (allowed; not part of the named target shape) ----
    provider_status: cleanText(cell(row, idx.status)),
    local_authority: cleanText(cell(row, idx.localAuthority)),
  };
}

// Case/space-insensitive local-authority match. EXACT match only (after normalising and
// stripping common prefixes), to avoid substring collisions like "York" vs "North Yorkshire",
// "Derby" vs "Derbyshire", "Bedford" vs "Central Bedfordshire", etc. (flagged in review).
function canonicalLa(s) {
  // drop administrative prefixes so "London Borough of Croydon" === "Croydon"
  return norm(s)
    .replace(/^(london borough of|royal borough of|metropolitan borough of|borough of|city of|county of)\s+/i, "")
    .trim();
}
function matchesLocalAuthority(rowLa, wanted) {
  if (!wanted) return true; // no filter => return everything
  const a = canonicalLa(rowLa);
  if (!a) return false;
  return a === canonicalLa(wanted);
}

async function fetchCsvText(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "kappa-arbitrage-ofsted-connector/1.0 (+nodejs)" },
  });
  if (!res.ok) {
    throw new Error(`Ofsted CSV fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return await res.text();
}

/**
 * fetchProviders(localAuthority)
 * Download + parse the Ofsted "most recent inspections" management-information CSV and return an
 * array of provider records in the target shape, filtered to the given local authority.
 *
 * @param {string} [localAuthority] e.g. "Croydon". If omitted/empty, ALL providers are returned
 *                                  (large — the national file has ~70k+ rows).
 * @returns {Promise<Array<object>>} array of provider records (see module-top shape).
 */
async function fetchProviders(localAuthority) {
  const url = DEFAULT_CSV_URL;
  const text = await fetchCsvText(url);
  const records = splitCsvRecords(text);
  if (!records.length) return [];

  const { headerRow, idx } = buildHeaderIndex(records);

  const providers = [];
  for (let r = headerRow + 1; r < records.length; r++) {
    const row = records[r];
    // skip blank/padding rows (the file has many trailing-comma-only rows)
    if (!row || !row.some((c) => String(c == null ? "" : c).trim() !== "")) continue;
    if (!matchesLocalAuthority(cell(row, idx.localAuthority), localAuthority)) continue;
    const provider = rowToProvider(row, idx);
    if (provider) providers.push(provider);
  }
  return providers;
}

module.exports = { fetchProviders };

// ---- CLI self-test: `node src/data/connectors/ofsted.js [LocalAuthority]` ----
if (require.main === module) {
  (async () => {
    const la = process.argv[2] || "Croydon";
    process.stderr.write(`[ofsted] fetching providers for local authority: "${la}"\n`);
    process.stderr.write(`[ofsted] source: ${DEFAULT_CSV_URL}\n`);
    try {
      const all = await fetchProviders(la);
      process.stderr.write(`[ofsted] matched ${all.length} provider record(s) for "${la}".\n`);
      const sample = all.slice(0, 5);
      console.log(JSON.stringify(sample, null, 2));
      // tiny shape assertions on the first record (sanity only)
      if (sample.length) {
        const p = sample[0];
        const ratings = ["Outstanding", "Good", "Requires improvement", "Inadequate", "Not yet inspected"];
        const checks = [
          ["urn is string", typeof p.urn === "string"],
          ["registered_places is number", typeof p.registered_places === "number"],
          ["age_min is number", typeof p.age_min === "number"],
          ["age_max is number", typeof p.age_max === "number"],
          ["lat is null (geo-enrich later)", p.lat === null],
          ["ward_code is null (geo-enrich later)", p.ward_code === null],
          ["ofsted_rating in enum", ratings.includes(p.ofsted_rating)],
          ["inspection_date ISO or null", p.inspection_date === null || /^\d{4}-\d{2}-\d{2}$/.test(p.inspection_date)],
        ];
        process.stderr.write("[ofsted] self-test:\n");
        for (const [label, ok] of checks) {
          process.stderr.write(`  ${ok ? "PASS" : "FAIL"}  ${label}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`[ofsted] self-test error: ${err && err.message ? err.message : err}\n`);
      process.stderr.write("[ofsted] (network may be restricted in this environment; the parser is\n");
      process.stderr.write("         written against the documented CSV schema — see module-top comment.)\n");
      process.exitCode = 1;
    }
  })();
}
