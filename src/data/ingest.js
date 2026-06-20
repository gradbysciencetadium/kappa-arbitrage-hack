// Ingestion: run the four live connectors for a Local Authority and join them into a
// dataset in the store's record shape, written to src/data/cache/{la}.json. The store
// prefers cache (live) over fixtures. Numbers downstream are still computed by derivations.
//
// Usage: node src/data/ingest.js "Croydon"

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const geography = require("./connectors/geography");
const ofsted = require("./connectors/ofsted");
const ons = require("./connectors/ons");
const imd = require("./connectors/imd");

const CACHE_DIR = path.join(__dirname, "cache");

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function ingest(localAuthority) {
  console.log(`Ingesting live data for: ${localAuthority}`);

  // 1. Providers (Ofsted) — postcode present, lat/lng/ward_code null by design.
  console.log("  · Ofsted providers…");
  const providers = await ofsted.fetchProviders(localAuthority);
  console.log(`    ${providers.length} providers`);

  // 2. Geocode unique postcodes → lat/lng/ward/lsoa.
  const postcodes = uniq(providers.map((p) => p.postcode));
  console.log(`  · geocoding ${postcodes.length} postcodes (postcodes.io)…`);
  const geoEntries = await geography.bulkPostcodeToArea(postcodes);
  const geoByPostcode = new Map();
  for (const e of geoEntries) {
    if (e && e.query && e.area) geoByPostcode.set(e.query.toUpperCase(), e.area);
  }

  // enrich providers with geography
  for (const p of providers) {
    const g = p.postcode ? geoByPostcode.get(p.postcode.toUpperCase()) : null;
    if (g) {
      p.lat = g.lat;
      p.lng = g.lng;
      p.ward_code = g.ward_code;
      p.lsoa_code = g.lsoa_code;
      if (!p.ward_name) p.ward_name = g.ward_name;
    }
  }
  const geocoded = providers.filter((p) => p.ward_code).length;
  console.log(`    ${geocoded} providers geocoded to a ward`);

  // 3. Population 0-4 by ward (ONS Nomis, Census 2021).
  console.log("  · ONS Nomis pop 0-4 by ward…");
  const wardPop = await ons.fetchPop0to4ByWard(localAuthority);
  console.log(`    ${wardPop.length} wards`);

  // 4. IMD/IDACI by LSOA → aggregate to ward using the providers' LSOAs in each ward.
  console.log("  · IMD 2019 deprivation…");
  const imdByLsoa = await imd.fetchDeprivationByLsoa();
  const wardToLsoa = {};
  for (const p of providers) {
    if (p.ward_code && p.lsoa_code) {
      (wardToLsoa[p.ward_code] = wardToLsoa[p.ward_code] || []).push(p.lsoa_code);
    }
  }
  for (const k of Object.keys(wardToLsoa)) wardToLsoa[k] = uniq(wardToLsoa[k]);
  const wardImd =
    typeof imd.aggregateToWard === "function"
      ? imd.aggregateToWard(imdByLsoa, wardToLsoa)
      : {};

  // 5. Assemble areas in store shape.
  const areas = wardPop.map((w) => {
    const dep = wardImd[w.ward_code] || {};
    return {
      ward_code: w.ward_code,
      ward_name: w.ward_name,
      local_authority: localAuthority,
      pop_0_4: w.pop_0_4,
      imd_decile: dep.imd_decile != null ? dep.imd_decile : null,
      idaci_decile: dep.idaci_decile != null ? dep.idaci_decile : null,
    };
  });

  const dataset = {
    _meta: {
      source: `LIVE: Ofsted childcare MI + ONS Nomis Census 2021 + IMD 2019 + postcodes.io. Ingested ${new Date().toISOString().slice(0, 10)}.`,
      local_authority: localAuthority,
      provider_count: providers.length,
      geocoded_count: geocoded,
      ward_count: areas.length,
    },
    areas,
    providers,
    comparables: [], // validation library is populated from real past openings over time
  };

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const outFile = path.join(CACHE_DIR, `${localAuthority.toLowerCase().replace(/\s+/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`  ✓ wrote ${outFile}`);
  return dataset;
}

if (require.main === module) {
  const la = process.argv[2] || "Croydon";
  ingest(la).catch((e) => {
    console.error("INGEST FAILED:", e);
    process.exit(1);
  });
}

module.exports = { ingest };
