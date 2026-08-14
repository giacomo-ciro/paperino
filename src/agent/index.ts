import type { Agent, Config } from "../types.js";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";

export function createAgent(config: Pick<Config, "agent" | "claudeBinary" | "codexBinary">): Agent {
  return config.agent === "codex"
    ? new CodexAgent(config.codexBinary)
    : new ClaudeAgent(config.claudeBinary);
}
