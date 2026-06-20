// Data-aware coverage for Kappy. A frontier model has no idea which local authorities this
// deployment actually has data for — so Kappy reads the real data layer and refuses to hand
// Bara a location he can't analyse, steering the client to a covered area instead. This is a
// capability a stateless prompt structurally cannot have (it requires reading deployment data).

const store = require("../data/store");

let _cache = null;
function coveredList() {
  if (!_cache) _cache = store.availableLocalAuthorities().filter(Boolean).sort();
  return _cache;
}

// Resolve a free-text location against what Bara can actually analyse, reusing the store's
// own matching so "covered" here means "Bara will find a dataset".
function resolveLocation(text) {
  const covered = coveredList();
  if (!text || !String(text).trim()) return { status: "unknown", canonical: null, covered };
  const meta = store.datasetMeta(text); // null if no dataset resolves
  if (meta) return { status: "covered", canonical: meta.local_authority || text, covered };
  return { status: "uncovered", canonical: null, covered };
}

module.exports = { coveredList, resolveLocation };
