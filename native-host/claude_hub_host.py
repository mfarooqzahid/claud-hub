#!/usr/bin/env python3
"""Claude Hub — Chrome native messaging host.

Launched by Chrome on demand (no server, no port). Gives the extension the
things an extension cannot do alone:

  * enumerate the user's Chrome profiles,
  * read the full claude.ai cookie set out of any profile,
  * launch a specific Chrome profile.

It speaks Chrome's native messaging protocol: a 4-byte native-endian length
prefix followed by UTF-8 JSON, on stdin/stdout.

Commands (JSON `type`):
  ping           -> {ok, host, version}
  listProfiles   -> {ok, profiles: [...]}
  readSession    -> {ok, sessionKey}   (body: profileId)
  readCookies    -> {ok, cookies, sessionKey}   (body: profileId)
  readAllCookies -> {ok, profiles: [{id, …, cookies}]}   (every signed-in profile)
  openProfile    -> {ok}               (body: profileId, url?)

Run `python3 claude_hub_host.py --list` to test discovery without Chrome.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOST_NAME = "com.claudehub.host"
VERSION = "1.2.0"
COOKIE_DOMAIN = "claude.ai"
SESSION_COOKIE = "sessionKey"
LOGIN_URL = "https://claude.ai/login"

# Cross-profile context hand-off. chrome.storage.local is per Chrome profile, so
# the conversation captured in one profile is written here and read by the
# profile that gets opened.
TRANSFER_FILENAME = "claude-hub-transfer.json"
TRANSFER_TTL_SECONDS = 30 * 60


# --------------------------------------------------------------------- paths
def user_data_dirs() -> list[tuple[Path, str, str]]:
    """Return (user_data_dir, browser_key, browser_label) candidates."""
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library/Application Support"
        return [
            (base / "Google/Chrome", "chrome", "Chrome"),
            (base / "Chromium", "chromium", "Chromium"),
            (base / "BraveSoftware/Brave-Browser", "brave", "Brave"),
        ]
    if sys.platform.startswith("win"):
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local"))
        return [
            (local / "Google/Chrome/User Data", "chrome", "Chrome"),
            (local / "Chromium/User Data", "chromium", "Chromium"),
            (local / "BraveSoftware/Brave-Browser/User Data", "brave", "Brave"),
        ]
    xdg = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    return [
        (xdg / "google-chrome", "chrome", "Chrome"),
        (xdg / "chromium", "chromium", "Chromium"),
        (xdg / "google-chrome-beta", "chrome-beta", "Chrome Beta"),
        (xdg / "BraveSoftware/Brave-Browser", "brave", "Brave"),
    ]


def browser_binary() -> str | None:
    if sys.platform == "darwin":
        for candidate in (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ):
            if Path(candidate).exists():
                return candidate
    for name in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "brave",
    ):
        path = shutil.which(name)
        if path:
            return path
    return None


# ----------------------------------------------------------------- profiles
def _cookies_file(profile_dir: Path) -> Path | None:
    for relative in ("Network/Cookies", "Cookies"):
        candidate = profile_dir / relative
        if candidate.exists():
            return candidate
    return None


def _local_state_info(user_data: Path) -> dict:
    try:
        data = json.loads(
            (user_data / "Local State").read_text(encoding="utf-8", errors="ignore")
        )
        return (data.get("profile", {}) or {}).get("info_cache", {}) or {}
    except Exception:
        return {}


def _last_used_profile(user_data: Path) -> str | None:
    """The profile Chrome most recently ran (from Local State)."""
    try:
        data = json.loads(
            (user_data / "Local State").read_text(encoding="utf-8", errors="ignore")
        )
        return (data.get("profile", {}) or {}).get("last_used")
    except Exception:
        return None


def _profile_has_extension(profile_dir: Path, extension_id: str | None) -> bool:
    """Is this the Chrome profile Claude Hub is loaded in?

    chrome.storage.local for an unpacked extension lives in
    <profile>/Local Extension Settings/<id>/, so its presence identifies the
    hub profile. We only check for the directory; nothing is read from it.
    """
    if not extension_id:
        return False
    return (profile_dir / "Local Extension Settings" / extension_id).is_dir()


def discover_profiles(extension_id: str | None = None) -> list[dict]:
    profiles: list[dict] = []
    for user_data, browser_key, browser_label in user_data_dirs():
        if not user_data.is_dir():
            continue
        info = _local_state_info(user_data)
        last_used = _last_used_profile(user_data)
        for entry in sorted(user_data.iterdir()):
            if not entry.is_dir():
                continue
            name = entry.name
            if name in {"System Profile", "Guest Profile"}:
                continue
            if name != "Default" and not name.startswith("Profile "):
                continue
            cookies = _cookies_file(entry)
            if cookies is None:
                continue
            meta = info.get(name, {}) or {}
            signed_in = has_session_cookie(cookies)
            # A stable, non-secret identity for the session (a hash, not the key)
            # so the extension can match accounts to profiles reliably.
            session_id = None
            if signed_in:
                value = _decrypt_session(cookies)
                if value:
                    session_id = hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]
            profiles.append(
                {
                    "id": f"{browser_key}:{name}",
                    "browser": browser_key,
                    "browser_label": browser_label,
                    "profile": name,
                    "label": meta.get("name") or name,
                    "email": meta.get("user_name") or None,
                    "has_session": signed_in and session_id is not None,
                    "session_id": session_id,
                    "is_current": name == last_used,
                    "has_extension": _profile_has_extension(entry, extension_id),
                }
            )
    return profiles


# ------------------------------------------------------------------ cookies
def _copy_readable(path: Path) -> Path:
    """Copy a (possibly locked) SQLite file so we can read it safely."""
    handle, tmp = tempfile.mkstemp(prefix="claude-hub-cookies-")
    os.close(handle)
    shutil.copyfile(path, tmp)
    return Path(tmp)


def has_session_cookie(cookies_path: Path) -> bool:
    """Fast check: is a claude.ai sessionKey row present? (no decryption)"""
    try:
        tmp = _copy_readable(cookies_path)
        try:
            conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
            row = conn.execute(
                "SELECT 1 FROM cookies WHERE name = ? AND host_key LIKE ? LIMIT 1",
                (SESSION_COOKIE, f"%{COOKIE_DOMAIN}%"),
            ).fetchone()
            conn.close()
            return row is not None
        finally:
            tmp.unlink(missing_ok=True)
    except Exception:
        return False


def read_session(profile_id: str) -> str | None:
    """Decrypt and return the claude.ai sessionKey for a profile id."""
    browser_key, _, profile = profile_id.partition(":")
    for user_data, candidate_key, _ in user_data_dirs():
        if candidate_key != browser_key:
            continue
        cookies = _cookies_file(user_data / profile)
        if cookies is None:
            return None
        return _decrypt_session(cookies)
    return None


def _decrypt_session(cookies_path: Path) -> str | None:
    try:
        import browser_cookie3  # type: ignore
    except Exception:
        return None
    try:
        jar = browser_cookie3.chrome(
            cookie_file=str(cookies_path), domain_name=COOKIE_DOMAIN
        )
        for cookie in jar:
            if cookie.name == SESSION_COOKIE and cookie.value:
                return cookie.value
    except Exception:
        return None
    return None


# Chrome stores cookie expiry as microseconds since 1601-01-01 UTC.
_CHROME_EPOCH_OFFSET = 11644473600
_SAMESITE = {-1: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict"}


def _chrome_expiry_to_unix(expires_utc: int) -> int | None:
    if not expires_utc:
        return None
    seconds = expires_utc / 1_000_000 - _CHROME_EPOCH_OFFSET
    return int(seconds) if seconds > 0 else None


def _read_profile_cookies(cookies_path: Path) -> list[dict] | None:
    """Return every claude.ai cookie for a profile, decrypted, with metadata.

    A single sessionKey cookie is not enough: Claude stores a paired set
    (sessionKey + sessionKeyLC + lastActiveOrg + routingHint + …). Replaying the
    whole set is what makes a switch actually take effect.
    """
    try:
        import browser_cookie3  # type: ignore
    except Exception:
        return None

    try:
        jar = browser_cookie3.chrome(
            cookie_file=str(cookies_path), domain_name=COOKIE_DOMAIN
        )
        values = {(c.name, c.domain, c.path or "/"): c.value for c in jar}
    except Exception:
        return None

    try:
        tmp = _copy_readable(cookies_path)
    except Exception:
        return None
    try:
        conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        rows = conn.execute(
            "SELECT host_key, name, path, is_secure, is_httponly, samesite, "
            "expires_utc, is_persistent FROM cookies "
            "WHERE host_key = ? OR host_key = ?",
            (COOKIE_DOMAIN, f".{COOKIE_DOMAIN}"),
        ).fetchall()
        conn.close()
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)

    cookies: list[dict] = []
    for (
        host_key,
        name,
        path,
        is_secure,
        is_httponly,
        samesite,
        expires_utc,
        is_persistent,
    ) in rows:
        value = values.get((name, host_key, path or "/"))
        if value is None:
            continue
        persistent = bool(is_persistent)
        cookies.append(
            {
                "name": name,
                "value": value,
                "domain": host_key,
                "path": path or "/",
                "secure": bool(is_secure),
                "httpOnly": bool(is_httponly),
                "sameSite": _SAMESITE.get(samesite, "unspecified"),
                "hostOnly": not host_key.startswith("."),
                "session": not persistent,
                "expirationDate": (
                    _chrome_expiry_to_unix(expires_utc) if persistent else None
                ),
            }
        )
    return cookies


def read_cookies(profile_id: str) -> list[dict] | None:
    """Decrypt and return all claude.ai cookies for a profile id."""
    browser_key, _, profile = profile_id.partition(":")
    for user_data, candidate_key, _ in user_data_dirs():
        if candidate_key != browser_key:
            continue
        cookies = _cookies_file(user_data / profile)
        if cookies is None:
            return None
        return _read_profile_cookies(cookies)
    return None


def read_all_cookies() -> list[dict]:
    """Full claude.ai cookie set for every signed-in profile, in one pass.

    The hub profile needs each account's whole cookie set to switch to it, so
    gather them together instead of spawning one helper process per profile.
    """
    result: list[dict] = []
    for profile in discover_profiles():
        if not profile.get("has_session"):
            continue
        cookies = read_cookies(profile["id"])
        if not cookies:
            continue
        result.append(
            {
                "id": profile["id"],
                "browser": profile["browser"],
                "browser_label": profile["browser_label"],
                "profile": profile["profile"],
                "label": profile["label"],
                "email": profile.get("email"),
                "session_id": profile["session_id"],
                "cookies": cookies,
            }
        )
    return result



# --------------------------------------------------------------------- open
def open_profile(profile_id: str, url: str | None = None) -> None:
    _, _, profile = profile_id.partition(":")
    binary = browser_binary()
    if not binary:
        raise RuntimeError("Could not find a Chrome/Chromium binary.")
    target = url or LOGIN_URL
    subprocess.Popen(
        [binary, f"--profile-directory={profile}", target],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


# ----------------------------------------------------------------- transfer
def _transfer_path() -> Path:
    return Path(tempfile.gettempdir()) / TRANSFER_FILENAME


def write_transfer(text: str) -> dict:
    """Store the rendered conversation context for another profile to pick up."""
    if not text:
        return {"ok": False, "error": "Nothing to transfer."}
    payload = {"text": text, "createdAt": int(time.time() * 1000)}
    try:
        _transfer_path().write_text(json.dumps(payload), encoding="utf-8")
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def read_transfer(consume: bool = False) -> dict:
    """Return a fresh hand-off, optionally deleting it so it is used once."""
    path = _transfer_path()
    if not path.exists():
        return {"ok": True, "data": None}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        path.unlink(missing_ok=True)
        return {"ok": True, "data": None}
    created = data.get("createdAt") or 0
    if created and (time.time() * 1000 - created) > TRANSFER_TTL_SECONDS * 1000:
        path.unlink(missing_ok=True)
        return {"ok": True, "data": None}
    if consume:
        path.unlink(missing_ok=True)
    return {"ok": True, "data": data}


def clear_transfer() -> dict:
    _transfer_path().unlink(missing_ok=True)
    return {"ok": True}


# ----------------------------------------------------------------- protocol
def handle(message: dict) -> dict:
    command = message.get("type")
    if command == "ping":
        return {"ok": True, "host": HOST_NAME, "version": VERSION}
    if command == "listProfiles":
        return {
            "ok": True,
            "profiles": discover_profiles(message.get("extensionId")),
        }
    if command == "readSession":
        value = read_session(message.get("profileId") or "")
        if not value:
            return {
                "ok": False,
                "error": "No claude.ai session found in that Chrome profile.",
            }
        return {"ok": True, "sessionKey": value}
    if command == "readCookies":
        cookies = read_cookies(message.get("profileId") or "")
        if not cookies:
            return {
                "ok": False,
                "error": "No claude.ai cookies found in that Chrome profile.",
            }
        session_key = next(
            (c["value"] for c in cookies if c["name"] == SESSION_COOKIE), None
        )
        return {"ok": True, "cookies": cookies, "sessionKey": session_key}
    if command == "readAllCookies":
        return {"ok": True, "profiles": read_all_cookies()}
    if command == "openProfile":
        open_profile(message.get("profileId") or "", message.get("url"))
        return {"ok": True}
    if command == "writeTransfer":
        return write_transfer(message.get("text") or "")
    if command == "readTransfer":
        return read_transfer(bool(message.get("consume")))
    if command == "clearTransfer":
        return clear_transfer()
    return {"ok": False, "error": f"Unknown command: {command!r}"}


def _read_message() -> dict | None:
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    payload = sys.stdin.buffer.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def _send_message(message: dict) -> None:
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main() -> None:
    while True:
        try:
            message = _read_message()
        except Exception:
            break
        if message is None:
            break
        try:
            response = handle(message)
        except Exception as exc:  # never crash the host on one bad request
            response = {"ok": False, "error": str(exc)}
        _send_message(response)


if __name__ == "__main__":
    if "--list" in sys.argv:
        print(json.dumps(discover_profiles(), indent=2))
    elif "--ping" in sys.argv:
        print(json.dumps(handle({"type": "ping"})))
    else:
        main()
