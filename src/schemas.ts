import type { JsonSchema } from "./types.js";

// additionalProperties maps (arbitrary key -> typed value) reliably trip up
// claude's structured-output tool calling: it passes the value as a string
// and gets stuck retrying against the schema. An array of typed objects
// (same shape as FINE_SCHEMA below) doesn't have this problem.
export const COARSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          coarse: { type: "integer", enum: [0, 1] },
        },
        required: ["id", "coarse"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
};

// The claude CLI's --json-schema is used as a tool input_schema, which the API
// requires to be type:"object" — the per-paper array must be nested under a key.
export const FINE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    papers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer", minimum: 1, maximum: 10 },
          summary: { type: "string" },
          key_contribution: { type: "string" },
          why_it_matters: { type: "string" },
        },
        required: ["id", "score", "summary", "key_contribution", "why_it_matters"],
        additionalProperties: false,
      },
    },
  },
  required: ["papers"],
  additionalProperties: false,
};

/**
 * Replace only the two exact tokens `{research_interests}` and `{papers}` in `template`.
 * Every other brace (e.g. the prompt's inline JSON examples) is left untouched.
 */
export function fillPrompt(
  template: string,
  values: { research_interests: string; papers: string },
): string {
  return template
    .replaceAll("{research_interests}", values.research_interests)
    .replaceAll("{papers}", values.papers);
}
