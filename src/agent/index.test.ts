import { describe, expect, it } from "vitest";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";
import { createAgent } from "./index.js";

describe("createAgent", () => {
  it("selects the configured provider and binary", () => {
    expect(createAgent({ agent: "claude", claudeBinary: "/claude", codexBinary: "/codex" })).toBeInstanceOf(ClaudeAgent);
    expect(createAgent({ agent: "codex", claudeBinary: "/claude", codexBinary: "/codex" })).toBeInstanceOf(CodexAgent);
  });
});
