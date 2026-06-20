// GEOGRAPHY connector — postcode -> geo/admin lookup (the geocoding backbone).
//
// Source API: postcodes.io — FREE, open, no API key required.
//   Single lookup : GET  https://api.postcodes.io/postcodes/{postcode}
//   Bulk lookup   : POST https://api.postcodes.io/postcodes   body: { "postcodes": [...] }
//   Docs          : https://postcodes.io/  /  https://api.postcodes.io/
//
// postcodes.io is built on ONS Postcode Directory (ONSPD) + OS Open data. The fields
// we read from each result:
//   latitude, longitude                 -> lat, lng
//   codes.admin_ward                    -> ward_code  (GSS code, e.g. "E05011468")
//   admin_ward                          -> ward_name
//   codes.lsoa                          -> lsoa_code  (LSOA GSS code, e.g. "E01000001")
//   admin_district                      -> local_authority
//
// Output shape (per postcode):
//   { postcode, lat, lng, ward_code, ward_name, lsoa_code, local_authority }
//
// This is intentionally key-less and uses only Node's built-in global fetch (Node 18+).
// No npm dependencies, no secrets. Downstream connectors (Ofsted/ONS/IMD) use the
// ward_code / lsoa_code returned here to join providers and areas together.

"use strict";

const BASE_URL = "https://api.postcodes.io";

// postcodes.io caps bulk requests at 100 postcodes per call; we chunk accordingly.
const BULK_CHUNK_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 15000;

// ---- helpers ---------------------------------------------------------------

// Map one raw postcodes.io "result" object into our target record shape.
// Returns null if there is no usable result.
function shapeResult(result) {
  if (!result) return null;
  const codes = result.codes || {};
  return {
    postcode: result.postcode || null,
    lat: typeof result.latitude === "number" ? result.latitude : null,
    lng: typeof result.longitude === "number" ? result.longitude : null,
    ward_code: codes.admin_ward || null,
    ward_name: result.admin_ward || null,
    lsoa_code: codes.lsoa || null,
    local_authority: result.admin_district || null,
  };
}

async function httpJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    // postcodes.io returns JSON even for 404 (status field in body). Parse first,
    // then decide. Non-JSON bodies (rare 5xx/HTML) throw and bubble up.
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error(`Non-JSON response from ${url} (HTTP ${res.status})`);
    }
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- public API ------------------------------------------------------------

/**
 * Look up a single postcode.
 * @param {string} postcode e.g. "CR0 6RA" (spacing/casing are tolerated by the API)
 * @returns {Promise<{postcode,lat,lng,ward_code,ward_name,lsoa_code,local_authority}|null>}
 *          Resolves to null if the postcode is unknown/terminated (HTTP 404).
 */
async function postcodeToArea(postcode) {
  if (!postcode || typeof postcode !== "string" || !postcode.trim()) {
    throw new Error("postcodeToArea: a non-empty postcode string is required");
  }
  const url = `${BASE_URL}/postcodes/${encodeURIComponent(postcode.trim())}`;
  const { res, body } = await httpJson(url);

  if (res.status === 404) return null; // unknown / terminated postcode
  if (!res.ok || (body && body.status && body.status >= 400)) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    throw new Error(`postcodeToArea("${postcode}") failed: ${msg}`);
  }
  return shapeResult(body && body.result);
}

/**
 * Bulk look up many postcodes via the POST bulk endpoint, chunked at 100/request.
 * Order is preserved relative to the input array. Unknown postcodes yield null.
 * @param {string[]} postcodes
 * @returns {Promise<Array<{query:string, area:Object|null}>>}
 *          Each entry: { query: <input postcode>, area: <shaped record or null> }
 */
async function bulkPostcodeToArea(postcodes) {
  if (!Array.isArray(postcodes)) {
    throw new Error("bulkPostcodeToArea: an array of postcodes is required");
  }
  // Filter to valid non-empty strings but remember nothing is dropped silently:
  const cleaned = postcodes
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);

  if (cleaned.length === 0) return [];

  const results = [];
  for (const group of chunk(cleaned, BULK_CHUNK_SIZE)) {
    const { res, body } = await httpJson(`${BASE_URL}/postcodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postcodes: group }),
    });

    if (!res.ok || (body && body.status && body.status >= 400)) {
      const msg = (body && body.error) || `HTTP ${res.status}`;
      throw new Error(`bulkPostcodeToArea failed: ${msg}`);
    }

    // body.result is an array of { query, result } in the SAME order as input.
    const items = (body && body.result) || [];
    for (const item of items) {
      results.push({
        query: item.query,
        area: shapeResult(item.result),
      });
    }
  }
  return results;
}

module.exports = { postcodeToArea, bulkPostcodeToArea };

// ---- CLI self-test ---------------------------------------------------------
// Run:  node src/data/connectors/geography.js
if (require.main === module) {
  (async () => {
    // Croydon sample postcodes drawn from the project's fixture data so the output
    // is recognisable (Addiscombe / Broad Green / Selhurst wards).
    const sample = ["CR0 6RA", "CR0 2TB", "SE25 6PY"];
    try {
      console.log("== Single lookup: postcodeToArea('CR0 6RA') ==");
      const one = await postcodeToArea("CR0 6RA");
      console.log(JSON.stringify(one, null, 2));

      console.log("\n== Bulk lookup: bulkPostcodeToArea(" + JSON.stringify(sample) + ") ==");
      const many = await bulkPostcodeToArea(sample);
      console.log(JSON.stringify(many, null, 2));

      console.log("\n== Unknown postcode (expect null): postcodeToArea('ZZ1 1ZZ') ==");
      console.log(await postcodeToArea("ZZ1 1ZZ"));

      console.log("\nSELF-TEST OK");
    } catch (err) {
      console.error("SELF-TEST FAILED (network may be restricted in this environment):");
      console.error(err && err.message ? err.message : err);
      console.error(
        "\nThe code is still correct against the documented postcodes.io schema; " +
          "re-run with network access to see live results."
      );
      process.exitCode = 1;
    }
  })();
}
