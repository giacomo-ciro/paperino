import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCallError } from "./error.js";
import { CodexAgent } from "./codex.js";
import type { AgentRunOptions } from "../types.js";

const opts: AgentRunOptions = {
  model: "gpt-5.6-luna",
  schema: { type: "object", required: ["verdicts"] },
  timeoutMs: 5000,
};

let dirs: string[] = [];

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Write an executable stand-in for `codex` without making a model call. */
function fakeCodex(body: string): string {
  const dir = temporaryDir("paperino-codex-bin-");
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, "utf-8");
  chmodSync(bin, 0o755);
  return bin;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("CodexAgent", () => {
  it("runs codex exec read-only and parses its schema-validated final message", async () => {
    const tempRoot = temporaryDir("paperino-codex-runs-");
    const agent = new CodexAgent(
      fakeCodex(`
        const fs = require("node:fs");
        const args = process.argv.slice(2);
        const valueAfter = (flag) => args[args.indexOf(flag) + 1];
        const required = ["exec", "--json", "--ephemeral", "--skip-git-repo-check"];
        if (!required.every((arg) => args.includes(arg))) process.exit(20);
        if (valueAfter("--sandbox") !== "read-only") process.exit(21);
        if (valueAfter("--color") !== "never") process.exit(22);
        if (valueAfter("--model") !== "gpt-5.6-luna") process.exit(23);
        const schema = JSON.parse(fs.readFileSync(valueAfter("--output-schema"), "utf-8"));
        if (schema.required[0] !== "verdicts") process.exit(24);
        fs.writeFileSync(valueAfter("--output-last-message"), JSON.stringify({ verdicts: [] }));
        process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
      `),
      tempRoot,
    );

    await expect(agent.run("screen these papers", opts)).resolves.toEqual({ output: { verdicts: [] } });
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("reports malformed final output", async () => {
    const agent = new CodexAgent(fakeCodex(`
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], "not json");
    `));

    const error = await agent.run("prompt", opts).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AgentCallError);
    expect((error as AgentCallError).message).toContain("codex returned malformed structured output");
  });

  it("reports the exit code and stderr when codex exits non-zero", async () => {
    const agent = new CodexAgent(fakeCodex(`process.stderr.write("authentication required\\n"); process.exit(1);`));

    const error = await agent.run("prompt", opts).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AgentCallError);
    expect((error as AgentCallError).exitCode).toBe(1);
    expect((error as AgentCallError).message).toContain("codex exited with code 1");
    expect((error as AgentCallError).message).toContain("stderr: authentication required");
  });

  it("reports a missing final message", async () => {
    const agent = new CodexAgent(fakeCodex(`process.stdout.write("{\\\"type\\\":\\\"turn.completed\\\"}\\n")`));

    const error = await agent.run("prompt", opts).catch((value: unknown) => value);

    expect((error as AgentCallError).message).toContain("codex returned no structured output");
  });

  it("reports a timeout as a timeout", async () => {
    const agent = new CodexAgent(fakeCodex(`process.stderr.write("starting\\n"); setTimeout(() => {}, 30000);`));

    const error = await agent
      .run("prompt", { ...opts, timeoutMs: 1000, signal: AbortSignal.timeout(1000) })
      .catch((value: unknown) => value);

    expect((error as AgentCallError).message).toContain("codex timed out after");
    expect((error as AgentCallError).message).toContain("stderr: starting");
  });
});
