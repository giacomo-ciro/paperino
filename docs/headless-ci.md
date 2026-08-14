# Headless CI Integration for Paperino

When running `paperino` in an automated CI/CD pipeline (e.g., GitHub Actions), you typically need to authenticate the underlying agent CLIs (Claude Code and Codex) without an interactive browser prompt.

If you want to consume your **existing subscriptions** rather than paying for API keys, follow the approaches below to bypass the interactive OAuth flow.

## 1. Claude Code
*Reference: [Claude Code CLI Docs](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)*

Anthropic provides a native way to generate an OAuth token meant specifically for CI pipelines, which allows you to use your Pro/Max subscription without relying on an `ANTHROPIC_API_KEY`.

### Setup Instructions
1. Run `claude setup-token` on your local, authenticated machine.
2. The CLI will output a special OAuth token. Copy this token.
3. In your GitHub repository, create a repository secret named `CLAUDE_CODE_OAUTH_TOKEN` and paste the token as its value.
4. Expose the secret in your workflow YAML:

```yaml
env:
  CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```
*(Ensure `ANTHROPIC_API_KEY` is **not** set, otherwise the CLI will default to pay-as-you-go billing).*

---

## 2. Codex (OpenAI)
*Reference: [Maintain Codex account auth in CI/CD (advanced)](https://learn.chatgpt.com/docs/auth/ci-cd-auth)*

Codex handles headless authentication differently depending on your account tier.

### Approach A: Workspace/Team Users (Recommended)
If you have access to a ChatGPT admin console, you can generate a Personal Access Token.
1. Generate a **Codex Access Token** via the ChatGPT Admin Console.
2. Create a GitHub Secret named `CODEX_ACCESS_TOKEN`.
3. Expose it in your workflow:
```yaml
env:
  CODEX_ACCESS_TOKEN: ${{ secrets.CODEX_ACCESS_TOKEN }}
```

### Approach B: Individual ChatGPT Plus Users (Advanced)
If you cannot generate an access token, you can use Codex's built-in refresh flow by maintaining the `~/.codex/auth.json` file.
Because Codex automatically refreshes tokens and rewrites this file, you **must persist the updated file back to your secret store** after each run when using ephemeral runners (like GitHub-hosted runners).

1. Authenticate locally with `codex login`.
2. Copy the contents of `~/.codex/auth.json` and save it as a GitHub Secret (e.g., `CODEX_AUTH_JSON`).
3. To allow your workflow to update the secret after a run, ensure you have a GitHub Personal Access Token (`GH_TOKEN`) with secret-writing permissions.
4. Implement a round-trip in your workflow:
```yaml
- name: Restore Codex Authentication State
  run: |
    mkdir -p ~/.codex
    # Only seed if missing; for self-hosted runners, it persists.
    if [ ! -f ~/.codex/auth.json ]; then
      echo "${{ secrets.CODEX_AUTH_JSON }}" > ~/.codex/auth.json
      chmod 600 ~/.codex/auth.json
    fi
```
*(After the Codex run completes, see the step in the Example Workflow below to write the refreshed file back.)*

---

## Example Workflow (`.github/workflows/e2e.yml`)
Below is a conceptual GitHub Action that runs an end-to-end test of `paperino` capping paper consumption to 2 to limit usage:

```yaml
name: E2E Pipeline
on:
  push:
    branches: [main]
    paths: ['src/**']

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies & Build
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Install Agent CLIs
        run: |
          npm install -g @anthropic-ai/claude-code
          # npm install -g <codex-cli-package>

      - name: Generate Mock Paperino Config
        run: |
          mkdir -p ~/.paperino
          cat <<EOF > ~/.paperino/config.toml
          [GENERAL]
          agent = "claude"
          arxiv_cat = ["cs.CV"]
          research_interests = "General computer science"
          min_score = 6
          EOF

      - name: Test Claude Pipeline
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: node dist/cli.js --max-papers 2 --force

      - name: Restore Codex Auth
        run: |
          mkdir -p ~/.codex
          if [ ! -f ~/.codex/auth.json ]; then
            echo "${{ secrets.CODEX_AUTH_JSON }}" > ~/.codex/auth.json
            chmod 600 ~/.codex/auth.json
          fi

      - name: Test Codex Pipeline
        run: |
          # Modify config to use codex
          sed -i 's/agent = "claude"/agent = "codex"/' ~/.paperino/config.toml
          node dist/cli.js --max-papers 2 --force

      - name: Persist Refreshed Codex Auth
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GH_TOKEN }} # Needed to update repository secrets
        run: |
          # Write the updated auth.json back to GitHub Secrets to preserve the refreshed token
          gh secret set CODEX_AUTH_JSON --body "$(cat ~/.codex/auth.json)"
```
