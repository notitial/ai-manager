# Callboard Panels

Callboard Panels is the VS Code side of **callboard**, the Claude Code mod that lets one session (a *lead*) run other sessions (*lanes*) in the same repo. The mod handles the cues. This extension opens and closes the Claude Code panels the lanes live in.

![Callboard Panels icon](icon.png)

## What it does

- **Opens a lane.** A lead's `lane_open` writes a request under `~/.claude/callboard/open/`. The window whose first folder is that lane's folder opens one Claude Code panel and answers with the new session's id. The lead then names it and starts it.
- **Reopens a parked lane.** For `lane_unpark`, it reopens that exact conversation as a panel, but only when the lane's record names that session id.
- **Closes finished panels.** After `lane_retire` or `lane_terminate`, it closes the lane's tab once that session has ended. It closes one matching tab only and never a panel with a reserved name. The conversation history stays.

It doesn't touch the terminal, any setting or the network. It reads and writes request files under `~/.claude/callboard`, reads `~/.claude/sessions` and the root-owned lane list at `/usr/local/libexec/callboard/lanes.json`, and runs `/bin/ps` to check a session's process.

## Requirements

- The **Claude Code** extension (`anthropic.claude-code`). It's declared as a dependency.
- The **callboard mod**, installed with callboard's `install.sh` (`--vscode` or `--all`). The installer also puts this extension in place. It isn't on the Marketplace.

## Things to know

- **One repo per window.** Claude Code opens a new panel in the window's *first* folder, so a window answers only for lanes in that folder. In a multi-root workspace, lanes of the other folders need their own window.
- **Limits.** At most 6 panels a minute. A lane made by a lead is refused when its repo already has 8 live sessions. A lane that already has a live session is refused.
- **Focus stays put.** A panel it opens doesn't keep focus: the tab you were on comes back.
- **Commands.** `Callboard: Open lane panel`, `Reopen lane panel by session id` and `Close lane panel by session id` are for the mod. They're hidden from the Command Palette.

## Updating

Reinstall with callboard's `install.sh`, then reload the VS Code windows. A new version keeps the same id, so it installs as an upgrade.

More in the callboard README in the [ai-manager repo](https://github.com/notitial/ai-manager).
