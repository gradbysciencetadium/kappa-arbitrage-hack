// Deterministic derivations — the analytical metrics for nursery site selection.
// CRITICAL: these are computed here in code, never by the LLM. Bara reasons about
// what to compute and how to interpret it; the numbers come from these functions.
// Every output carries the inputs + source so it can be cited and audited.

const store = require("./store");

const GOOD_RATINGS = new Set(["Good", "Outstanding"]);

// Group-based providers (nurseries) operate from "non-domestic premises" and carry a
// postcode, so they geocode to a ward (~99.9% coverage). Childminders / home-based carers
// have their addresses redacted by Ofsted (no postcode), so they CANNOT be placed in a
// ward — ward-level supply therefore reflects group-based provision, and childminders are
// surfaced separately at LA level. This split is what stops a ward looking like a
// "childcare desert" purely because home-based carers aren't geocodable.
const GROUP_RE = /non-domestic/i;
const isGroupProvider = (p) => GROUP_RE.test(p.type || "");

function round(n, dp = 2) {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function placesInWard(locationFocus, wardCode) {
  return store
    .getProvidersInWard(locationFocus, wardCode)
    .reduce((sum, p) => sum + (p.registered_places || 0), 0);
}

// Places per 100 children aged 0-4, by ward.
function placesPer100(locationFocus, wardCode) {
  const area = store.getArea(locationFocus, wardCode);
  if (!area || !area.pop_0_4) return null;
  return round((placesInWard(locationFocus, wardCode) / area.pop_0_4) * 100, 1);
}

// Local-authority average of places-per-100, for the gap baseline.
function laAveragePlacesPer100(locationFocus) {
  const areas = store.listAreas(locationFocus);
  const vals = areas.map((a) => placesPer100(locationFocus, a.ward_code)).filter((v) => v != null);
  if (!vals.length) return null;
  return round(vals.reduce((s, v) => s + v, 0) / vals.length, 1);
}

// 1. Supply–demand gap vs LA average (negative = under-supplied = opportunity).
function supplyDemandGap(locationFocus, wardCode) {
  const wardVal = placesPer100(locationFocus, wardCode);
  const laAvg = laAveragePlacesPer100(locationFocus);
  if (wardVal == null || !laAvg) return null;
  const gapPct = round(((wardVal - laAvg) / laAvg) * 100, 1);
  return {
    metric: "supply_demand_gap",
    ward_code: wardCode,
    places_per_100: wardVal,
    la_average_per_100: laAvg,
    gap_pct: gapPct,
    interpretation: gapPct < -10 ? "under-supplied" : gapPct > 10 ? "over-supplied" : "balanced",
    source: "Derived from provider registered_places (Ofsted) / pop_0_4 (ONS).",
  };
}

// 2. Childcare-desert index: children aged 0-4 per registered place.
function childcareDesertIndex(locationFocus, wardCode) {
  const area = store.getArea(locationFocus, wardCode);
  const places = placesInWard(locationFocus, wardCode);
  if (!area || !area.pop_0_4 || !places) return null;
  const ratio = round(area.pop_0_4 / places, 2);
  return {
    metric: "childcare_desert_index",
    ward_code: wardCode,
    children_0_4: area.pop_0_4,
    total_places: places,
    children_per_place: ratio,
    classification: ratio > 3 ? "childcare desert" : ratio < 1.5 ? "over-supplied" : "adequate",
    source: "Derived from pop_0_4 (ONS) / registered_places (Ofsted).",
  };
}

// 3. Deprivation-adjusted demand: 0-4 population weighted by income deprivation
//    affecting children (lower IDACI decile = more deprived = higher weight).
function deprivationAdjustedDemand(locationFocus, wardCode) {
  const area = store.getArea(locationFocus, wardCode);
  if (!area || !area.pop_0_4 || area.idaci_decile == null) return null;
  // weight 1.0 (least deprived, decile 10) .. 1.45 (most deprived, decile 1)
  const weight = round(1 + (10 - area.idaci_decile) * 0.05, 2);
  return {
    metric: "deprivation_adjusted_demand",
    ward_code: wardCode,
    pop_0_4: area.pop_0_4,
    idaci_decile: area.idaci_decile,
    weight,
    adjusted_demand: round(area.pop_0_4 * weight, 0),
    source: "pop_0_4 (ONS) weighted by IDACI decile (IMD 2019).",
  };
}

// 4. Competitive quality density: share of nearby providers rated Good/Outstanding.
function competitiveQualityDensity(locationFocus, wardCode) {
  const providers = store.getProvidersInWard(locationFocus, wardCode);
  if (!providers.length) {
    return {
      metric: "competitive_quality_density",
      ward_code: wardCode,
      provider_count: 0,
      good_or_outstanding_share: null,
      interpretation: "no incumbent provision — open field",
      source: "Ofsted ratings by provider.",
    };
  }
  const rated = providers.filter((p) => p.ofsted_rating);
  const good = rated.filter((p) => GOOD_RATINGS.has(p.ofsted_rating)).length;
  const share = rated.length ? round(good / rated.length, 2) : null;
  return {
    metric: "competitive_quality_density",
    ward_code: wardCode,
    provider_count: providers.length,
    rated_count: rated.length,
    good_or_outstanding: good,
    good_or_outstanding_share: share,
    interpretation:
      share == null ? "incumbents unrated" : share >= 0.75 ? "strong incumbents — differentiation needed" : share <= 0.4 ? "weak incumbents — quality gap to exploit" : "mixed",
    source: "Ofsted ratings by provider.",
  };
}

// Per-ward evidence confidence: how much group-based provision underpins this ward's
// supply metrics. Few providers => the desert/gap signal is fragile, so we flag it.
function wardConfidence(locationFocus, wardCode) {
  const providers = store.getProvidersInWard(locationFocus, wardCode);
  const n = providers.length;
  const rated = providers.filter((p) => p.ofsted_rating).length;
  const confidence = n >= 5 ? "high" : n >= 2 ? "medium" : "low";
  const flags = [];
  if (n === 0) flags.push("no_group_providers_in_ward");
  else if (n < 2) flags.push("sparse_supply_evidence");
  return { group_provider_count: n, rated_count: rated, confidence, flags };
}

// LA-level data coverage: what the ward metrics are (and aren't) built on. Makes the
// childminder gap explicit instead of letting it silently undercount ward supply.
function datasetCoverage(locationFocus) {
  const providers = store.listProviders(locationFocus);
  const total = providers.length;
  const geocoded = providers.filter((p) => p.ward_code).length;
  const group = providers.filter(isGroupProvider);
  const groupGeo = group.filter((p) => p.ward_code).length;
  const childminders = providers.filter((p) => !isGroupProvider(p));
  const cmPlaces = childminders.reduce((s, p) => s + (p.registered_places || 0), 0);
  return {
    total_providers: total,
    geocoded,
    geocoded_pct: total ? round((geocoded / total) * 100, 1) : null,
    group_based: {
      total: group.length,
      geocoded: groupGeo,
      geocoded_pct: group.length ? round((groupGeo / group.length) * 100, 1) : null,
      ward_level: true,
    },
    childminders: {
      count: childminders.length,
      registered_places: cmPlaces,
      ward_attributable: false,
    },
    note:
      "Ward-level metrics reflect group-based (nursery) provision, which is ~100% geocoded. " +
      childminders.length +
      " childminders/home-based carers add LA-wide capacity (" +
      cmPlaces +
      " places) that Ofsted does not geolocate, so they are not allocated to wards.",
  };
}

// Convenience: full metric pack for one ward.
function wardMetrics(locationFocus, wardCode) {
  const area = store.getArea(locationFocus, wardCode);
  return {
    ward_code: wardCode,
    ward_name: area ? area.ward_name : wardCode,
    supply_demand_gap: supplyDemandGap(locationFocus, wardCode),
    childcare_desert_index: childcareDesertIndex(locationFocus, wardCode),
    deprivation_adjusted_demand: deprivationAdjustedDemand(locationFocus, wardCode),
    competitive_quality_density: competitiveQualityDensity(locationFocus, wardCode),
    coverage: wardConfidence(locationFocus, wardCode),
  };
}

// Rank all wards in the dataset by opportunity (under-supply + deprivation-weighted demand).
function rankWards(locationFocus) {
  const areas = store.listAreas(locationFocus);
  const scored = areas.map((a) => {
    const m = wardMetrics(locationFocus, a.ward_code);
    const gap = m.supply_demand_gap ? m.supply_demand_gap.gap_pct : 0;
    const desert = m.childcare_desert_index ? m.childcare_desert_index.children_per_place : 0;
    const demand = m.deprivation_adjusted_demand ? m.deprivation_adjusted_demand.adjusted_demand : 0;
    // opportunity rises with under-supply (negative gap), higher children-per-place, higher adjusted demand
    const opportunity_score = round(-gap * 0.5 + desert * 8 + demand / 100, 1);
    // Flag a fragile "opportunity" that rests on thin supply evidence (e.g. a ward that
    // looks like a desert only because it has 0-1 geocoded group providers).
    const cov = m.coverage || {};
    const flags = [...(cov.flags || [])];
    const desertish =
      (m.childcare_desert_index && m.childcare_desert_index.classification === "childcare desert") ||
      (m.supply_demand_gap && m.supply_demand_gap.interpretation === "under-supplied");
    if (desertish && cov.confidence === "low") flags.push("low_confidence_opportunity_signal");
    return { ...m, opportunity_score, confidence: cov.confidence || "low", flags };
  });
  return scored.sort((x, y) => y.opportunity_score - x.opportunity_score);
}

module.exports = {
  placesInWard,
  placesPer100,
  laAveragePlacesPer100,
  supplyDemandGap,
  childcareDesertIndex,
  deprivationAdjustedDemand,
  competitiveQualityDensity,
  wardConfidence,
  datasetCoverage,
  isGroupProvider,
  wardMetrics,
  rankWards,
};
