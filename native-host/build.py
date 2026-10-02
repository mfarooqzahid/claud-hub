#!/usr/bin/env python3
"""Optionally build the native host as a standalone binary (needs PyInstaller).

    pip install pyinstaller
    python3 native-host/build.py

This produces ``native-host/claude-hub-host``. install.py automatically prefers
that binary over the Python script, so a machine without Python can still run
the helper. Build once per OS you want to support.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> None:
    if shutil.which("pyinstaller") is None:
        sys.exit("PyInstaller not found. Install it with: pip install pyinstaller")

    subprocess.check_call(
        [
            "pyinstaller",
            "--onefile",
            "--name",
            "claude-hub-host",
            "--distpath",
            str(HERE),
            "--workpath",
            str(HERE / "build"),
            "--specpath",
            str(HERE / "build"),
            str(HERE / "claude_hub_host.py"),
        ]
    )
    built = HERE / "claude-hub-host"
    if built.exists():
        print(f"\nBuilt {built}\nRun install.py again to register the binary.")
    else:
        sys.exit("Build finished but binary not found.")


if __name__ == "__main__":
    main()
