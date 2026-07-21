import { describe, expect, it } from "vitest";
import { fillPrompt } from "./schemas.js";

describe("fillPrompt", () => {
  it("replaces only the two exact tokens and leaves other braces untouched", () => {
    const template = [
      'Project: {research_interests}',
      'Papers: {papers}',
      'Output ONLY a valid JSON object, e.g. {{"2501.01234v1": 1, "2501.05678v1": 0}}.',
      "Unrelated braces: {not_a_token} {{also not}}",
    ].join("\n");

    const result = fillPrompt(template, {
      research_interests: "point cloud aggregation",
      papers: "2601.00001v1 — A Paper",
    });

    expect(result).toContain("Project: point cloud aggregation");
    expect(result).toContain("Papers: 2601.00001v1 — A Paper");
    expect(result).toContain('{{"2501.01234v1": 1, "2501.05678v1": 0}}');
    expect(result).toContain("Unrelated braces: {not_a_token} {{also not}}");
  });

  it("replaces every occurrence when a token appears multiple times", () => {
    const result = fillPrompt("{papers}\n\n{papers}", {
      research_interests: "",
      papers: "X",
    });
    expect(result).toBe("X\n\nX");
  });
});
