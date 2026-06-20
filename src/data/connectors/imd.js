// IMD / IDACI connector — English Indices of Multiple Deprivation 2019 (IoD2019).
//
// Source: Ministry of Housing, Communities & Local Government (MHCLG, formerly
// MHCLG/DLUHC). Free, key-less official open data.
//
// Bulk CSV used (the only IoD2019 bulk file published as CSV; Files 1-6, 8-9 are XLSX):
//   "File 7: All ranks, deciles and scores for the indices of deprivation,
//    and population denominators"
//   https://assets.publishing.service.gov.uk/media/5dc407b440f0b6379a7acc8d/File_7_-_All_IoD2019_Scores__Ranks__Deciles_and_Population_Denominators_3.csv
//
// Landing page (lists all IoD2019 files):
//   https://www.gov.uk/government/statistics/english-indices-of-deprivation-2019
//
// Equivalent dataset on the MHCLG Open Data Communities platform (LSOA level):
//   https://opendatacommunities.org/data/societal-wellbeing/imd2019/indices
//
// File 7 column headers (verified against the live CSV header row):
//   key:          "LSOA code (2011)"
//   imd_decile:   "Index of Multiple Deprivation (IMD) Decile (where 1 is most deprived 10% of LSOAs)"
//   idaci_decile: "Income Deprivation Affecting Children Index (IDACI) Decile (where 1 is most deprived 10% of LSOAs)"
//
// Deciles are 1-10 where 1 = most deprived 10% of LSOAs nationally, 10 = least deprived.
// LSOA = Lower-layer Super Output Area (2011 census geography, ~1,500 residents each;
// England has 32,844 of them). Codes look like "E01000001".
//
// No API key is required for this source. Node 24 built-in global fetch is used.

"use strict";

const IMD2019_FILE7_CSV_URL =
  "https://assets.publishing.service.gov.uk/media/5dc407b440f0b6379a7acc8d/" +
  "File_7_-_All_IoD2019_Scores__Ranks__Deciles_and_Population_Denominators_3.csv";

// Exact File 7 header strings (used to locate columns by name, so we are robust
// to column re-ordering should MHCLG re-publish the file).
const COL_LSOA = "LSOA code (2011)";
const COL_IMD_DECILE =
  "Index of Multiple Deprivation (IMD) Decile (where 1 is most deprived 10% of LSOAs)";
const COL_IDACI_DECILE =
  "Income Deprivation Affecting Children Index (IDACI) Decile (where 1 is most deprived 10% of LSOAs)";

// ---------------------------------------------------------------------------
// CSV parsing — File 7 has quoted fields containing commas (e.g. the
// "Education, Skills and Training ..." columns), so we need an RFC-4180-aware
// parser rather than a naive split on ",".
// ---------------------------------------------------------------------------

// Parse a single CSV record (one logical row) into an array of field strings.
// Assumes the row does not contain embedded newlines inside quotes, which holds
// for File 7 (all values are codes/names/numbers). We split the file on line
// breaks first and parse each line.
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Coerce a decile cell to an integer 1-10, or null if absent/invalid.
function toDecile(raw) {
  if (raw == null) return null;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 10) return null;
  return n;
}

/**
 * Fetch the IoD2019 deprivation data and return a map keyed by LSOA code.
 *
 * @param {Object} [opts]
 * @param {string} [opts.url]      Override the source CSV URL (e.g. for testing/mirrors).
 * @param {AbortSignal} [opts.signal]  Optional abort signal for the fetch.
 * @returns {Promise<Object<string, {imd_decile: number, idaci_decile: number}>>}
 *          Map of lsoa_code -> { imd_decile, idaci_decile }, deciles 1-10 (1 = most deprived).
 */
async function fetchDeprivationByLsoa(opts = {}) {
  const url = opts.url || IMD2019_FILE7_CSV_URL;
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(
      `IMD2019 fetch failed: HTTP ${res.status} ${res.statusText} for ${url}`
    );
  }
  const text = await res.text();
  return parseDeprivationCsv(text);
}

/**
 * Parse a File-7-shaped CSV string into the lsoa_code -> deciles map.
 * Exposed separately so the parser can be unit-tested without a network call.
 *
 * @param {string} text  Raw CSV text (with header row).
 * @returns {Object<string, {imd_decile: number, idaci_decile: number}>}
 */
function parseDeprivationCsv(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) throw new Error("IMD2019 CSV is empty");

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const iLsoa = header.indexOf(COL_LSOA);
  const iImd = header.indexOf(COL_IMD_DECILE);
  const iIdaci = header.indexOf(COL_IDACI_DECILE);

  if (iLsoa === -1 || iImd === -1 || iIdaci === -1) {
    throw new Error(
      "IMD2019 CSV is missing expected columns. Found header: " +
        header.join(" | ")
    );
  }

  const byLsoa = {};
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line) continue; // skip blank trailing line
    const cols = parseCsvLine(line);
    const code = (cols[iLsoa] || "").trim();
    if (!code) continue;
    byLsoa[code] = {
      imd_decile: toDecile(cols[iImd]),
      idaci_decile: toDecile(cols[iIdaci]),
    };
  }
  return byLsoa;
}

// ---------------------------------------------------------------------------
// Ward-level aggregation helper.
// ---------------------------------------------------------------------------

// Default aggregator: population-weighted mean if weights are supplied for each
// LSOA, otherwise the simple (unweighted) mean, rounded to the nearest integer
// decile and clamped to 1-10. Aggregating ordinal deciles is inherently lossy;
// the mean is the conventional, transparent choice for ward roll-ups.
function defaultAggregate(values, weights) {
  const pairs = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const w = weights && Number.isFinite(weights[i]) ? weights[i] : 1;
    if (w <= 0) continue;
    pairs.push([v, w]);
  }
  if (!pairs.length) return null;
  let sum = 0;
  let wsum = 0;
  for (const [v, w] of pairs) {
    sum += v * w;
    wsum += w;
  }
  const mean = sum / wsum;
  return Math.min(10, Math.max(1, Math.round(mean)));
}

/**
 * Aggregate LSOA-level deciles up to ward level.
 *
 * @param {Object<string, {imd_decile: number, idaci_decile: number}>} deprivationByLsoa
 *        Output of fetchDeprivationByLsoa().
 * @param {Object<string, string[]>} wardToLsoa
 *        Map of ward_code -> array of LSOA codes that fall within the ward.
 * @param {Object} [opts]
 * @param {Object<string, Object<string, number>>} [opts.weights]
 *        Optional ward_code -> (lsoa_code -> weight), e.g. child population per
 *        LSOA, for a population-weighted aggregation. Defaults to equal weights.
 * @param {(values:number[], weights:number[]) => (number|null)} [opts.aggregate]
 *        Optional custom aggregator. Receives the list of valid LSOA deciles and
 *        their weights; should return a number (1-10) or null.
 * @returns {Object<string, {imd_decile: number, idaci_decile: number, lsoa_count: number}>}
 *        Map of ward_code -> aggregated deciles plus how many LSOAs contributed.
 */
function aggregateToWard(deprivationByLsoa, wardToLsoa, opts = {}) {
  const aggregate = opts.aggregate || defaultAggregate;
  const weightsByWard = opts.weights || {};
  const out = {};

  for (const [wardCode, lsoaCodes] of Object.entries(wardToLsoa || {})) {
    const codes = Array.isArray(lsoaCodes) ? lsoaCodes : [];
    const wardWeights = weightsByWard[wardCode] || {};

    const imdVals = [];
    const imdW = [];
    const idaciVals = [];
    const idaciW = [];
    let contributing = 0;

    for (const code of codes) {
      const rec = deprivationByLsoa[code];
      if (!rec) continue;
      contributing++;
      const w = Number.isFinite(wardWeights[code]) ? wardWeights[code] : 1;
      if (rec.imd_decile != null) {
        imdVals.push(rec.imd_decile);
        imdW.push(w);
      }
      if (rec.idaci_decile != null) {
        idaciVals.push(rec.idaci_decile);
        idaciW.push(w);
      }
    }

    out[wardCode] = {
      imd_decile: aggregate(imdVals, imdW),
      idaci_decile: aggregate(idaciVals, idaciW),
      lsoa_count: contributing,
    };
  }
  return out;
}

module.exports = {
  fetchDeprivationByLsoa,
  aggregateToWard,
  parseDeprivationCsv, // exported for testing / offline parsing
  IMD2019_FILE7_CSV_URL,
  // column-name constants exported for reference / downstream documentation
  COL_LSOA,
  COL_IMD_DECILE,
  COL_IDACI_DECILE,
};

// ---------------------------------------------------------------------------
// CLI self-test:  node src/data/connectors/imd.js
// Fetches the live File 7 CSV, prints summary stats and a small sample, then
// demonstrates ward aggregation on a couple of made-up ward->LSOA lookups.
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log("[imd] fetching:", IMD2019_FILE7_CSV_URL);
    let map;
    try {
      map = await fetchDeprivationByLsoa();
    } catch (err) {
      console.error("[imd] live fetch failed (network may be restricted):", err.message);
      console.error(
        "[imd] code is still valid against the documented File 7 schema; " +
          "run again with network access, or import { parseDeprivationCsv } to test offline."
      );
      process.exitCode = 1;
      return;
    }

    const codes = Object.keys(map);
    console.log(`[imd] parsed ${codes.length} LSOAs (expected ~32,844 for England)`);

    const sample = codes.slice(0, 5).map((c) => ({ lsoa_code: c, ...map[c] }));
    console.log("[imd] sample records:");
    console.table(sample);

    // Demonstrate ward aggregation. (LSOA codes here are real-looking examples;
    // a real run would use an ONS ward->LSOA best-fit lookup, e.g. from the
    // ONS Open Geography Portal LSOA-to-Ward lookup.)
    const demoWardToLsoa = { DEMO_WARD: codes.slice(0, 4) };
    const wardAgg = aggregateToWard(map, demoWardToLsoa);
    console.log("[imd] ward aggregation demo (first 4 LSOAs as one ward):");
    console.log(wardAgg);
  })();
}
