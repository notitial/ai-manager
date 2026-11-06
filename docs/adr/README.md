# Architecture Decision Records

The significant design decisions for this repo, with their context and consequences. Check them before proposing a
change to something they cover.

## Format

Each ADR is a numbered file, `NNNN-short-title.md`, in this folder. The template is the streamlined MADR variant
recorded in ai-toolkit ADR 0002 (https://github.com/notitial/ai-toolkit/blob/main/docs/adr/0002-streamlined-madr-template.md):

- **Status:** proposed, accepted, deprecated or superseded; the index adds "amended" when the ADR carries an
  amendment
- **Date:** when the decision was recorded, plus an optional **Accepted** date when it was accepted later
- **Context:** the forces at play and why a decision is needed
- **Options Considered:** the alternatives evaluated, so a settled choice is not proposed again
- **Decision:** what was chosen and why
- **Consequences:** what becomes easier, harder or constrained

An ADR records what was decided at the time. A later change gets a dated amendment line or a new ADR, not a silent
rewrite. An ai-toolkit decision is cited as "ai-toolkit ADR NNNN" with its URL; a bare "ADR NNNN" always means this
repo's.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| 0001 | The manager role (`0001-manager-role.md`) | accepted, amended | 2026-10-21 |
| 0002 | Callboard (`0002-callboard.md`) | accepted, amended | 2026-10-24 |
| 0003 | Callboard loads from a live checkout (`0003-symlinked-install.md`) | accepted | 2026-11-06 |
