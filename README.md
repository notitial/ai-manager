<p align="center">
  <img src="assets/icon/manager-icon.svg" alt="ai-manager: a round navy badge showing a cream stone angel with raised wings and its face in its hands" width="160">
</p>

# ai-manager

The manager role for Claude Code, and the tools it runs on: one session per machine that coordinates the other sessions there, so a person running several leads and their lanes has one place that sees all of them.

> **Status:** a personal setup, not a product. It assumes macOS and builds on [ai-toolkit](https://github.com/notitial/ai-toolkit), installed first.

## What This Is

- **The manager role** ([docs/manager/](docs/manager/)): what the session holding the callboard manager grant does. It decides across leads and repos, reviews their work and reports. It does no work itself and approves nothing: every go is typed by the person in the session that acts on it.
- **Callboard** ([tools/callboard/](tools/callboard/)): a Claude Code mod through which a lead creates, starts, compacts, parks and stops its lanes. The person grants each lead with a confirmation, and ending a lane's session asks every time. A VS Code panels extension comes with it.
- **The usage watcher** ([tools/usage-watcher/](tools/usage-watcher/)): a small launchd job that measures how fast each session burns tokens and writes one summary the manager reads to spot a runaway session early.
- **The session lister** ([tools/session-peers/](tools/session-peers/)): lists the live local sessions with the address SendMessage takes.
- **Project skills** ([.claude/skills/](.claude/skills/)): a monthly read-only audit, a bounded keep-awake, a display-off command and a guided setup ([setup-manager](.claude/skills/setup-manager/SKILL.md)).
- **The callboard rule** ([rules/callboard.md](rules/callboard.md)): an always-on rule for how a session answers callboard's keepalive, nudges and notices.

## Getting Started

Install ai-toolkit first, then follow [docs/setup.md](docs/setup.md) for the install order of each part, or type `/setup-manager` in a session in this checkout for the guided version.

## Where to Go Next

- [docs/01-manager-pattern.md](docs/01-manager-pattern.md): the pattern behind the role, a manager over leads and lanes
- [docs/adr/README.md](docs/adr/README.md): the decisions behind the design
- [tools/test-all.sh](tools/test-all.sh): runs every test suite and prints a pass/fail table
- [CLAUDE.md](CLAUDE.md): for agents working in this repo

## License

MIT. See [LICENSE](LICENSE).
