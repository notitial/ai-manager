# Changelog

## 1.3.0

- A `<NAME>.lead` request waits up to 45 s for its panel to register, in place of 5 s, so a slow cold window has room. A fast open still answers at once. Other requests keep their 5 s.
- While a lead's panel is being waited for (up to 45 s) the window handles no other request; they are handled once it ends.
- The answer to a `<NAME>.lead` request carries the request's nonce: `ok <sid> <nonce>`. Errors and the other requests are unchanged.

## 1.2.0

- Handles `<NAME>.lead` requests from a conductor's `lead_open`: one line naming the repo, answered on `<NAME>.result` like an open. A window opens a panel only when the repo is its first workspace folder and its own real path; a request for another window's repo is left in place. The same limits as an open apply (a gap per name, 8 live sessions per repo, 6 opens a minute).

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
