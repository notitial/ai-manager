# Changelog

## 1.0.1

- Reads lanes only from the lane store. The root-owned lane list is gone.
- Installs as a link to the checkout (`link-extension.sh`) instead of a copy.

## 1.0.0

- Opens a lane panel on a lead's request and returns its session id.
- Reopens a parked lane's own conversation.
- Closes a finished lane's tab once its session has ended.
- The three commands are grouped under "Callboard" and hidden from the Command Palette; the mod calls them.
