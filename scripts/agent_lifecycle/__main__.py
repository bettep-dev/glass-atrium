"""Package entry point — `python -m agent_lifecycle <command>`."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
