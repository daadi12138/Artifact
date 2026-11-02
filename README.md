# Artifact

Artifact is a local-first workflow console for coordinating coding agents through versioned outputs, approval gates, and a visual DAG.

## Run locally

Requirements: Node.js 20+ and npm. Codex is optional, but required for real Agent nodes configured with the Codex executor.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. For a production build:

```bash
npm run build
npm run start
```

## Desktop app and CLI

Artifact ships as an Electron desktop app backed by the same `artifact-core` services used by the Next API routes and companion CLI. Electron starts the bundled local server as infrastructure; it does not execute CLI commands for project or workflow operations.

```bash
npm run electron:dev
npm run electron:doctor
npm run dist:mac
npm run cli:build
./dist-cli/cli.js doctor /path/to/project
./dist-cli/cli.js open /path/to/project
```

`dist:mac` creates an unsigned Apple Silicon app bundle and ZIP under `release/`. Use `npm run dist:all:clean` to rebuild the app, ZIP, and DMG from a clean tree. Signing and notarization are intentionally disabled for local testing; macOS may require Control-clicking the app and choosing Open on first launch.

## Included in this release

- Git project import with detected Node.js commands and approval before an unreviewed validation command runs.
- A dedicated Git Worktree and temporary branch for every Run; the imported working directory is never used for Agent writes.
- Drag-and-drop workflow canvas with persisted prompts, node library, and runtime selection per Agent node.
- Read-only Codex and Claude Code runtime discovery for current CLI status, authorization state, connectivity, and available models.
- DAG validation for duplicate nodes, invalid edges, self edges, and cycles.
- Durable, atomic Run manifests with frozen project/environment snapshots and per-step Attempt history.
- Approval, rejection, cancellation, failed-step retry, and automatic `process_lost` recovery after a service restart.
- Versioned JSON and Markdown Artifact payloads validated against registered schemas, with SHA-256 hashes and upstream lineage.
- Confirmed install/typecheck/test/build/lint commands executed inside the Run Worktree.
- Run, Attempt, Worktree, and Artifact detail views backed by persisted data.
- Codex read-only analysis and workspace-write implementation through `codex exec`.
- Claude Code read-only analysis and workspace-write implementation through its non-interactive JSON CLI mode.

## Deliberate boundaries

This is a single-user, local-first release bound to `127.0.0.1`. Agent changes are isolated under the Artifact state directory's `worktrees/`; Artifact never commits, pushes, opens PRs, merges, or deploys. Web and CLI use `.artifact/` by default, Electron development uses `.artifact-desktop-dev/`, and the packaged desktop app uses its application-data directory. The current release has production adapters for Codex and Claude Code. Gemini CLI, Grok Build, OpenCode, Pi, and delegated subagents require the next adapter-protocol milestone before they are exposed in the UI. Playwright, Figma import, and Visual QA remain outside this core release.

## Agent authentication and models

Artifact never stores an API key. Install and sign in to Codex once with `codex login`; Codex keeps its own login state and Artifact only checks whether that state is available. Claude Code can be signed in from its interactive CLI with `/login`. For API-key use, set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the environment that starts Artifact. In development this can be `OPENAI_API_KEY=... npm run electron:dev`; for the packaged app, CLI login is the reliable option because Finder-launched apps do not inherit shell environment variables.

The runtime page is read-only: it shows the local CLI state, connectivity, and models reported by each CLI. Artifact does not install, update, connect, sign in to, or configure an Agent runtime. Runs defer model selection to the CLI's current default.

## Quality checks

```bash
npm run typecheck
npm test
npm run build
```

Repository-local runtime state is intentionally excluded from source control through `.gitignore`.
