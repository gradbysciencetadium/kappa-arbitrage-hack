// JSON schemas for Bara's structured stages. Kept to the subset Gemini's
// responseSchema accepts (type / properties / items / required / enum / nullable)
// so the same schema also works on OpenAI-compatible providers.

const planSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          why: { type: "string" },
        },
        required: ["dimension", "why"],
      },
    },
    comparable_strategy: { type: "string" },
  },
  required: ["tasks"],
};

const critiqueSchema = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    missing_dimensions: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["approved", "notes"],
};

const workerSchema = {
  type: "object",
  properties: {
    dimension: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          evidence: { type: "string" },
          source: { type: "string" },
        },
        required: ["claim", "evidence", "source"],
      },
    },
  },
  required: ["dimension", "findings"],
};

const reportSchema = {
  type: "object",
  properties: {
    executive_summary: { type: "string" },
    strategic_question: { type: "string" },
    recommended_locations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ward_name: { type: "string" },
          rank: { type: "integer" },
          rationale: { type: "string" },
          key_metrics: { type: "string" },
        },
        required: ["ward_name", "rationale"],
      },
    },
    data_analysis: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          finding: { type: "string" },
          sources: { type: "string" },
        },
        required: ["dimension", "finding"],
      },
    },
    validation_cross_check: { type: "string" },
    implementation_roadmap: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase: { type: "string" },
          action: { type: "string" },
        },
        required: ["phase", "action"],
      },
    },
    risks: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    data_sources: { type: "array", items: { type: "string" } },
    caveats: { type: "string" },
  },
  required: [
    "executive_summary",
    "strategic_question",
    "recommended_locations",
    "data_analysis",
    "validation_cross_check",
    "implementation_roadmap",
    "confidence",
  ],
};

const judgeSchema = {
  type: "object",
  properties: {
    factual_grounding: { type: "number" },
    citation_quality: { type: "number" },
    internal_logic: { type: "number" },
    nuance: { type: "number" },
    overall: { type: "number" },
    weaknesses: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["pass", "revise"] },
  },
  required: ["overall", "verdict"],
};

module.exports = { planSchema, critiqueSchema, workerSchema, reportSchema, judgeSchema };
