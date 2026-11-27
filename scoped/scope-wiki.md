# WIKI Scope Rules

## Operational Constraints [WIKI]

- **`raw/` frontmatter validation**: a `wiki/raw/` file carries exactly `source_url`, `collected`, `collector` — otherwise return it to glass-atrium-intel-researcher; it is not a valid write.
  - Only legacy files can fail: `hooks/validate-pre-write-raw.sh` blocks a non-conforming new Write.
- **Staleness surface**: `~/.glass-atrium/scripts/wiki-staleness.sh` reports notes past the 90-day `updated:` threshold.
