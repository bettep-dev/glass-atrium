# WIKI Scope Rules

Curation rules for glass-atrium-wiki-curator.

## Absolute Rules [WIKI]

- **`raw/` holds web-sourced originals only**: moving an internal managed (clauded-docs) document into `~/.glass-atrium/wiki/raw/` is FORBIDDEN.

## Operational Constraints [WIKI]

- **`raw/` frontmatter validation**: an incoming `wiki/raw/` file carries exactly the 3 fields `source_url`, `collected`, `collector` — missing or extra fields → return it to glass-atrium-intel-researcher, and do not count it as a valid write.
  - Live scope is legacy / pre-contract files: `hooks/validate-pre-write-raw.sh` blocks a non-conforming NEW write at creation time, so that failure state is unreachable for anything landing today.
- **Staleness surface**: `~/.glass-atrium/scripts/wiki-staleness.sh` reports notes past the 90-day `updated:` threshold and writes nothing under `wiki/`.
