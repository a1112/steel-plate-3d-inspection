#!/usr/bin/env python3
"""Enumerate SICK cameras through a validated GenTL producer."""

from sick_capture.cli import probe_main


if __name__ == "__main__":
    raise SystemExit(probe_main())
