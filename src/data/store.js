// Data store + query API. This is the interface Bara's workers read through.
// Today it is backed by JSON fixtures; the real connectors (Phase: workflow) will
// populate the same shape from Ofsted / ONS / IMD so nothing downstream changes.

const fs = require("fs");
const path = require("path");

const FIXTURE_DIR = path.join(__dirname, "fixtures");
const CACHE_DIR = path.join(__dirname, "cache");

// Load datasets keyed by local authority. Fixtures load first; live ingested data in
// cache/ then OVERRIDES the fixture for the same LA — so real data wins where available.
function loadDir(dir, datasets) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const la = (raw._meta && raw._meta.local_authority) || file.replace(/\.json$/, "");
      datasets[la.toLowerCase()] = raw;
    } catch (_) {
      /* skip unreadable dataset */
    }
  }
}

function loadDatasets() {
  const datasets = {};
  loadDir(FIXTURE_DIR, datasets); // sample data
  loadDir(CACHE_DIR, datasets); // live ingested data overrides fixtures
  return datasets;
}

const DATASETS = loadDatasets();

function resolveDataset(locationFocus) {
  // No silent fallback: if we don't have data for the requested area, return null so the
  // analysis is honest ("no data for X yet") rather than quietly analysing the wrong place.
  if (!locationFocus) return null;
  const key = locationFocus.toLowerCase();
  if (DATASETS[key]) return DATASETS[key];
  // substring match so "Croydon, London" / "North Croydon" still resolve to "croydon"
  const hit = Object.keys(DATASETS).find((k) => key.includes(k) || k.includes(key));
  return hit ? DATASETS[hit] : null;
}

// The local authorities we actually have data for (for honest "we cover: …" messaging).
function availableLocalAuthorities() {
  return Object.values(DATASETS).map((d) => (d._meta && d._meta.local_authority) || "?");
}

// ---- Query API (what Bara workers call) ----

function listAreas(locationFocus) {
  const ds = resolveDataset(locationFocus);
  return ds ? ds.areas : [];
}

function getArea(locationFocus, wardCode) {
  return listAreas(locationFocus).find((a) => a.ward_code === wardCode) || null;
}

function listProviders(locationFocus) {
  const ds = resolveDataset(locationFocus);
  return ds ? ds.providers : [];
}

function getProvidersInWard(locationFocus, wardCode) {
  return listProviders(locationFocus).filter((p) => p.ward_code === wardCode);
}

function getComparables(locationFocus) {
  const ds = resolveDataset(locationFocus);
  return (ds && ds.comparables) || [];
}

function datasetMeta(locationFocus) {
  const ds = resolveDataset(locationFocus);
  return ds ? ds._meta : null;
}

function isFixture(locationFocus) {
  const meta = datasetMeta(locationFocus);
  return !!(meta && /FIXTURE|SAMPLE/i.test(meta.source || ""));
}

module.exports = {
  listAreas,
  getArea,
  listProviders,
  getProvidersInWard,
  getComparables,
  datasetMeta,
  isFixture,
  availableLocalAuthorities,
};
