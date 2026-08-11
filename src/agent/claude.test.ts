import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAgent, ClaudeCallError } from "./claude.js";
import type { AgentRunOptions } from "../types.js";

const opts: AgentRunOptions = { model: "haiku", schema: {}, timeoutMs: 5000 };

let dirs: string[] = [];

/** Write an executable stand-in for the claude binary running `body` under node. */
function fakeClaude(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "paperino-claude-"));
  dirs.push(dir);
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, "utf-8");
  chmodSync(bin, 0o755);
  return bin;
}

function resultEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { verdicts: [] },
    ...overrides,
  });
}

afterEach(() => {
  dirs = [];
});

describe("ClaudeAgent", () => {
  it("parses a final result event that arrives without a trailing newline", async () => {
    // claude is not obliged to newline-terminate its last line; dropping it used to
    // turn a perfectly good call into "claude returned no result event"
    const agent = new ClaudeAgent(fakeClaude(`process.stdout.write(${JSON.stringify(resultEvent())})`));

    await expect(agent.run("prompt", opts)).resolves.toEqual({ output: { verdicts: [] } });
  });

  it("reports the exit code and stderr when claude exits non-zero", async () => {
    const agent = new ClaudeAgent(
      fakeClaude(`process.stderr.write("Credit balance is too low\\n"); process.exit(1)`),
    );

    const error = await agent.run("prompt", opts).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeCallError);
    expect((error as ClaudeCallError).exitCode).toBe(1);
    expect((error as ClaudeCallError).message).toContain("claude exited with code 1");
    expect((error as ClaudeCallError).message).toContain("stderr: Credit balance is too low");
  });

  it("keeps non-JSON stdout so plain-text CLI diagnostics are not lost", async () => {
    const agent = new ClaudeAgent(fakeClaude(`console.log("Invalid API key · Please run /login")`));

    const error = await agent.run("prompt", opts).catch((e: unknown) => e);

    expect((error as ClaudeCallError).message).toContain("claude returned no result event");
    expect((error as ClaudeCallError).message).toContain("unparsed stdout: Invalid API key · Please run /login");
  });

  it("includes claude's own result event when it reports an error", async () => {
    const event = resultEvent({
      subtype: "error_during_execution",
      is_error: true,
      structured_output: null,
      result: "usage limit reached",
    });
    const agent = new ClaudeAgent(fakeClaude(`console.log(${JSON.stringify(event)})`));

    const error = await agent.run("prompt", opts).catch((e: unknown) => e);

    expect((error as ClaudeCallError).message).toContain("claude reported an error");
    expect((error as ClaudeCallError).message).toContain("usage limit reached");
    expect((error as ClaudeCallError).resultEvent).toMatchObject({ result: "usage limit reached" });
  });

  it("reports a timeout as a timeout, with the stderr seen so far", async () => {
    const agent = new ClaudeAgent(
      fakeClaude(`process.stderr.write("starting\\n"); setTimeout(() => {}, 30000)`),
    );

    const error = await agent
      .run("prompt", { ...opts, timeoutMs: 1000, signal: AbortSignal.timeout(1000) })
      .catch((e: unknown) => e);

    expect((error as ClaudeCallError).message).toContain("claude timed out after");
    expect((error as ClaudeCallError).message).toContain("stderr: starting");
  });

  it("reports a missing binary without pretending it timed out", async () => {
    const agent = new ClaudeAgent(join(tmpdir(), "paperino-does-not-exist"));

    const error = await agent.run("prompt", opts).catch((e: unknown) => e);

    expect((error as ClaudeCallError).message).toContain("failed to spawn claude");
  });
});
