<p align="center">
  <img src="assets/icon/manager-icon.svg" alt="ai-manager: a round navy badge showing a cream stone angel with raised wings and its face in its hands" width="160">
</p>

# ai-manager

The manager role for Claude Code, and the tools it runs on: one session per machine that coordinates the other sessions there, so a person running several leads and their lanes has one place that sees all of them.

> **Status:** a personal setup, not a product. It assumes macOS and builds on [ai-toolkit](https://github.com/notitial/ai-toolkit), installed first.

## What This Is

- **The manager role** (`docs/manager/`): what the session holding the callboard manager grant does. It decides across leads and repos, reviews their work and reports. It does no work itself and approves nothing: every go is typed by the person in the session that acts on it.
- **Callboard** (`tools/callboard/`): a Claude Code mod through which a lead creates, starts, compacts, parks and stops its lanes. The person grants each lead with a confirmation, and ending a lane's session asks every time. A VS Code panels extension comes with it.
- **The usage watcher** (`tools/usage-watcher/`): a small launchd job that measures how fast each session burns tokens and writes one summary the manager reads to spot a runaway session early.
- **The session lister** (`tools/session-peers/`): lists the live local sessions with the address SendMessage takes.
- **Project skills** (`.claude/skills/`): a monthly read-only audit, a bounded keep-awake and a display-off command.

## Getting Started

Install ai-toolkit first, then follow `docs/setup.md` for the install order of each part.

## Where to Go Next

- [docs/adr/README.md](docs/adr/README.md): the decisions behind the design
- [CLAUDE.md](CLAUDE.md): for agents working in this repo

## License

MIT. See [LICENSE](LICENSE).
