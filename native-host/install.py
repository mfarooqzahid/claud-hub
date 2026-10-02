#!/usr/bin/env python3
"""Install (or remove) the Claude Hub native messaging host.

Run once:

    python3 native-host/install.py

It registers the host manifest with every Chrome/Chromium/Brave profile store it
can find, so the extension can scan profiles and read sessions. Use
`--uninstall` to remove the registration, or `--dry-run` to preview.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

HOST_NAME = "com.claudehub.host"
EXTENSION_ID = "mgkciecihglomejbnikemllhfpgjjjni"
DESCRIPTION = "Claude Hub helper: scan Chrome profiles and read Claude sessions"

HERE = Path(__file__).resolve().parent


def host_executable() -> Path:
    """Prefer a bundled binary, else the Python script."""
    for name in ("claude-hub-host", "claude-hub-host.exe"):
        candidate = HERE / name
        if candidate.exists():
            return candidate
    return HERE / "claude_hub_host.py"


def manifest_targets() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library/Application Support"
        roots = [
            base / "Google/Chrome",
            base / "Chromium",
            base / "BraveSoftware/Brave-Browser",
        ]
        return [r / "NativeMessagingHosts" for r in roots]
    if sys.platform.startswith("win"):
        appdata = Path(os.environ.get("APPDATA", home / "AppData/Roaming"))
        return [appdata / "ClaudeHub" / "NativeMessagingHosts"]
    xdg = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    roots = [
        xdg / "google-chrome",
        xdg / "chromium",
        xdg / "google-chrome-beta",
        xdg / "BraveSoftware/Brave-Browser",
    ]
    return [r / "NativeMessagingHosts" for r in roots]


def registry_targets() -> list[str]:
    return [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Chromium\NativeMessagingHosts",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    ]


def build_manifest(path: Path) -> dict:
    return {
        "name": HOST_NAME,
        "description": DESCRIPTION,
        "path": str(path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
    }


def install(dry_run: bool) -> None:
    executable = host_executable()
    if not executable.exists():
        sys.exit(f"Host executable not found: {executable}")

    if executable.suffix == ".py" and not dry_run:
        mode = executable.stat().st_mode
        executable.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    manifest = build_manifest(executable)
    text = json.dumps(manifest, indent=2)

    print(f"Extension ID : {EXTENSION_ID}")
    print(f"Host path    : {executable}")

    for target_dir in manifest_targets():
        manifest_path = target_dir / f"{HOST_NAME}.json"
        print(f"  write {manifest_path}")
        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(text, encoding="utf-8")

    if sys.platform.startswith("win"):
        import winreg  # noqa: PLC0415

        for sub in registry_targets():
            key_path = f"{sub}\\{HOST_NAME}"
            print(f"  registry HKCU\\{key_path}")
            if not dry_run:
                winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path)
                with winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE
                ) as key:
                    winreg.SetValueEx(
                        key,
                        "",
                        0,
                        winreg.REG_SZ,
                        str(manifest_targets()[0] / f"{HOST_NAME}.json"),
                    )

    print("\nDone. Reload the Claude Hub extension in chrome://extensions.")


def uninstall(dry_run: bool) -> None:
    for target_dir in manifest_targets():
        manifest_path = target_dir / f"{HOST_NAME}.json"
        print(f"  remove {manifest_path}")
        if not dry_run:
            manifest_path.unlink(missing_ok=True)
    if sys.platform.startswith("win"):
        import winreg  # noqa: PLC0415

        for sub in registry_targets():
            key_path = f"{sub}\\{HOST_NAME}"
            print(f"  registry delete HKCU\\{key_path}")
            if not dry_run:
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                except FileNotFoundError:
                    pass
    print("\nDone.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.uninstall:
        uninstall(args.dry_run)
    else:
        install(args.dry_run)


if __name__ == "__main__":
    main()
