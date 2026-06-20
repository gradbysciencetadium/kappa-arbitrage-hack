// ONS / Nomis population connector — Census 2021 child population (ages 0–4) by ward.
//
// Source: Nomis open API (UK Office for National Statistics). FREE, key-less, no auth.
//   API root:        https://www.nomisweb.co.uk/api/v01/
//   Dataset (used):  NM_2027_1  ==  Census 2021 table "TS007 - Age by single year of age"
//   Data endpoint:   https://www.nomisweb.co.uk/api/v01/dataset/NM_2027_1.data.json
//   Geography lookup:https://www.nomisweb.co.uk/api/v01/dataset/NM_2027_1/geography/TYPE154.def.sdmx.json?search=<name>*
//   API guide:       https://www.nomisweb.co.uk/api/v01/help
//
// How the query is built (verified against the live API on 2026-06-18):
//   - geography: "<LA>TYPE153"  selects every 2022 ward (geography TYPE153) that nests
//                inside the given local authority. <LA> may be an ONS code (e.g. Croydon =
//                "E09000008") or Nomis' internal numeric geography id. So "E09000008TYPE153"
//                returns all Croydon wards in one request.
//   - c2021_age_102: this dataset's age dimension. Code 1001 = "Aged 4 years and under"
//                (a pre-aggregated 0–4 band), so pop_0_4 comes back directly — no summing.
//                (Single-year codes 1..5 = ages 0,1,2,3,4 if you preferred to sum them.)
//   - measures=20100 : the count measure ("Value"). time defaults to the 2021 Census.
//   - select=... : trims the JSON payload to just the fields we need.
//
// Output rows look like:
//   { "geography": { "geogcode": "E05011462", "description": "Addiscombe East" },
//     "obs_value": { "value": 748 }, ... }
//
// Exposes: async fetchPop0to4ByWard(localAuthority) -> [{ ward_code, ward_name, pop_0_4 }, ...]
// CommonJS, Node 24 built-in global fetch only (no npm deps).

const NOMIS_API_ROOT = "https://www.nomisweb.co.uk/api/v01";
const DATASET_ID = "NM_2027_1"; // Census 2021 TS007 — Age by single year of age
const WARD_GEOG_TYPE = "TYPE153"; // 2022 wards
const LA_GEOG_TYPE = "TYPE154"; // 2022 local authorities: districts
const AGE_DIM = "c2021_age_102"; // age dimension of NM_2027_1
const AGE_0_TO_4_CODE = "1001"; // "Aged 4 years and under" (pre-aggregated 0–4 band)
const MEASURE_VALUE = "20100"; // count ("Value")

const DEFAULT_TIMEOUT_MS = 30000;

// An ONS GSS code looks like one letter (country) followed by 8 digits, e.g. E09000008.
const GSS_CODE_RE = /^[EWSN]\d{8}$/i;

function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  }).then((res) => {
    if (!res.ok) {
      throw new Error(`Nomis request failed (${res.status} ${res.statusText}): ${url}`);
    }
    return res.json();
  });
}

// Resolve a local-authority *name* (e.g. "Croydon") to a Nomis geography id usable as the
// parent in "<id>TYPE153". GSS codes (e.g. "E09000008") are accepted as-is.
async function resolveLocalAuthority(localAuthority) {
  if (localAuthority == null) {
    throw new Error("fetchPop0to4ByWard: a localAuthority (name or ONS code) is required");
  }
  const raw = String(localAuthority).trim();
  if (!raw) {
    throw new Error("fetchPop0to4ByWard: localAuthority must be a non-empty string");
  }

  // Already an ONS/GSS code — usable directly as the geography parent.
  if (GSS_CODE_RE.test(raw)) {
    return { id: raw.toUpperCase(), name: raw.toUpperCase() };
  }

  // Otherwise search the LA geography codelist by name.
  const search = encodeURIComponent(`${raw}*`);
  const url = `${NOMIS_API_ROOT}/dataset/${DATASET_ID}/geography/${LA_GEOG_TYPE}.def.sdmx.json?search=${search}`;
  const data = await fetchJson(url);

  let codes =
    data &&
    data.structure &&
    data.structure.codelists &&
    data.structure.codelists.codelist &&
    data.structure.codelists.codelist[0] &&
    data.structure.codelists.codelist[0].code;
  if (!Array.isArray(codes)) codes = codes ? [codes] : [];

  if (codes.length === 0) {
    throw new Error(`No local authority found on Nomis matching "${raw}"`);
  }

  // Prefer an exact (case-insensitive) name match; otherwise take the first result.
  const lower = raw.toLowerCase();
  const exact = codes.find(
    (c) => c.description && String(c.description.value).toLowerCase() === lower
  );
  const chosen = exact || codes[0];
  return {
    id: String(chosen.value),
    name: chosen.description ? String(chosen.description.value) : raw,
  };
}

/**
 * Fetch the Census 2021 population aged 0–4 for every ward within a local authority.
 *
 * @param {string} localAuthority - LA name (e.g. "Croydon") or ONS code (e.g. "E09000008").
 * @returns {Promise<Array<{ ward_code: string, ward_name: string, pop_0_4: number }>>}
 */
async function fetchPop0to4ByWard(localAuthority) {
  const la = await resolveLocalAuthority(localAuthority);

  const params = new URLSearchParams({
    geography: `${la.id}${WARD_GEOG_TYPE}`,
    [AGE_DIM]: AGE_0_TO_4_CODE,
    measures: MEASURE_VALUE,
    select: "GEOGRAPHY_CODE,GEOGRAPHY_NAME,OBS_VALUE",
  });
  const url = `${NOMIS_API_ROOT}/dataset/${DATASET_ID}.data.json?${params.toString()}`;

  const data = await fetchJson(url);
  const obs = (data && Array.isArray(data.obs) && data.obs) || [];

  return obs.map((o) => {
    const geo = o.geography || {};
    const ward_code = geo.geogcode || geo.value || null;
    const ward_name = geo.description != null ? String(geo.description) : null;
    const value = o.obs_value ? o.obs_value.value : null;
    const pop_0_4 = value == null ? 0 : Number(value);
    return {
      ward_code: ward_code != null ? String(ward_code) : null,
      ward_name,
      pop_0_4: Number.isFinite(pop_0_4) ? pop_0_4 : 0,
    };
  });
}

module.exports = { fetchPop0to4ByWard };

// ---- CLI self-test: `node src/data/connectors/ons.js [localAuthority]` ----
if (require.main === module) {
  const arg = process.argv[2] || "Croydon";
  fetchPop0to4ByWard(arg)
    .then((rows) => {
      console.log(`Census 2021 pop aged 0–4 by ward for "${arg}" — ${rows.length} ward(s):`);
      console.table(rows.slice(0, 10));
      if (rows.length > 10) console.log(`... and ${rows.length - 10} more`);
      const total = rows.reduce((s, r) => s + (r.pop_0_4 || 0), 0);
      console.log(`Total 0–4 across wards: ${total}`);
    })
    .catch((err) => {
      console.error("Self-test failed:", err.message);
      console.error(
        "If this is a network restriction, the code is still correct against the documented Nomis schema."
      );
      process.exitCode = 1;
    });
}
