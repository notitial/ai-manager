# Changelog

## 1.1.0

- Removes the commands `callboard.open`, `callboard.reopen` and `callboard.close` and the `close` function behind the last one. The mod never called them: it reaches the extension through the request files under `~/.claude/callboard/open/`, which are unchanged. Panels still open, reopen and close as before.

## 1.0.1

- Reads lanes only from the lane store. The root-owned lane list is gone.
- Installs as a link to the checkout (`link-extension.sh`) instead of a copy.

## 1.0.0

- Opens a lane panel on a lead's request and returns its session id.
- Reopens a parked lane's own conversation.
- Closes a finished lane's tab once its session has ended.
- Registers three commands (`callboard.open`, `callboard.reopen`, `callboard.close`), grouped under "Callboard" and hidden from the Command Palette. The mod does not call them (removed in 1.1.0).
