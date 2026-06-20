// Batch-ingest live childcare data for major English local authorities.
// Ofsted (England-only) + ONS Census + IMD + postcodes.io. The national Ofsted/IMD files
// are downloaded once (cached) so this stays fast across dozens of authorities.
// Usage: node scripts/ingest-batch.js
require("dotenv").config();
const { ingest } = require("../src/data/ingest");

// Major English LAs: all 32 London boroughs + the largest cities / metropolitan & unitary
// authorities. Names use the canonical ONS/Ofsted form where it differs from common usage.
const LAS = [
  // London boroughs
  "Camden", "Greenwich", "Hackney", "Hammersmith and Fulham", "Islington",
  "Kensington and Chelsea", "Lambeth", "Lewisham", "Southwark", "Tower Hamlets",
  "Wandsworth", "Westminster", "Barking and Dagenham", "Barnet", "Bexley", "Brent",
  "Bromley", "Croydon", "Ealing", "Enfield", "Haringey", "Harrow", "Havering",
  "Hillingdon", "Hounslow", "Kingston upon Thames", "Merton", "Newham", "Redbridge",
  "Richmond upon Thames", "Sutton", "Waltham Forest",
  // Major cities / metropolitan / unitary
  "Birmingham", "Manchester", "Leeds", "Liverpool", "Sheffield", "Bristol, City of",
  "Newcastle upon Tyne", "Nottingham", "Leicester", "Coventry", "Bradford",
  "Kingston upon Hull, City of", "Stoke-on-Trent", "Wolverhampton", "Derby",
  "Southampton", "Portsmouth", "Plymouth", "Reading", "Brighton and Hove",
  "Milton Keynes", "Wakefield", "Sunderland", "Salford", "Bolton", "Oldham",
  "Rochdale", "Wigan", "Sandwell", "Dudley", "Walsall", "Luton", "Norwich",
  "Cambridge", "Oxford", "York", "Doncaster", "Rotherham", "Barnsley", "Gateshead",
  "Stockport", "Trafford", "Wirral", "Sefton",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = [];
  for (let i = 0; i < LAS.length; i++) {
    const la = LAS[i];
    process.stdout.write(`[${i + 1}/${LAS.length}] ${la}: `);
    try {
      const ds = await ingest(la);
      const m = ds._meta || {};
      const ok = (m.provider_count || 0) > 0 && (m.ward_count || 0) > 0;
      results.push({ la, providers: m.provider_count || 0, geocoded: m.geocoded_count || 0, wards: m.ward_count || 0, ok });
      console.log(`providers=${m.provider_count} geocoded=${m.geocoded_count} wards=${m.ward_count} ${ok ? "OK" : "⚠ name?"}`);
    } catch (e) {
      results.push({ la, error: e.message, ok: false });
      console.log("FAILED:", e.message);
    }
    await sleep(300); // be polite to the public APIs
  }

  const ok = results.filter((r) => r.ok);
  console.log(`\n=== DONE: ${ok.length}/${LAS.length} ingested OK ===`);
  const flagged = results.filter((r) => !r.ok);
  if (flagged.length) {
    console.log("Flagged (likely name mismatch — fix the LA name and re-run just those):");
    flagged.forEach((r) => console.log("  -", r.la, "|", r.error || `providers=${r.providers} wards=${r.wards}`));
  }
})().catch((e) => { console.error("BATCH FAILED:", e); process.exit(1); });
