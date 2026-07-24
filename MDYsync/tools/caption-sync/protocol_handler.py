"""dafsync:// URL protocol support.

Lets a link on the website (e.g. `dafsync://open?refs=%5B%22Chullin+80b%22%5D`)
launch this app if it isn't already running, optionally carrying along the
readings the user already picked on the website so they don't need to be
re-entered. Windows only — the app self-registers the protocol the first
time it runs, using the per-user registry hive (HKEY_CURRENT_USER), which
needs no administrator rights, unlike the machine-wide hive.
"""

import json
import sys
import urllib.parse


def register_protocol_handler(exe_path: str):
    """Idempotently register the dafsync:// scheme for the current user.
    No-op on anything but Windows."""
    if sys.platform != "win32":
        return
    import winreg

    command = f'"{exe_path}" "%1"'
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,
                                r"Software\Classes\dafsync") as key:
            existing, _ = _try_query(key, None)
            if existing != "URL:DafSync Protocol":
                winreg.SetValueEx(key, None, 0, winreg.REG_SZ,
                                   "URL:DafSync Protocol")
                winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")

        with winreg.CreateKeyEx(
                winreg.HKEY_CURRENT_USER,
                r"Software\Classes\dafsync\shell\open\command") as key:
            existing, _ = _try_query(key, None)
            if existing != command:
                winreg.SetValueEx(key, None, 0, winreg.REG_SZ, command)
    except OSError:
        pass  # registry access can fail in locked-down environments; the
              # app still works fully via manual "Browse" either way.


def _try_query(key, name):
    import winreg
    try:
        return winreg.QueryValueEx(key, name)
    except FileNotFoundError:
        return None, None


def parse_launch_payload(argv):
    """Return {'refs': [...]} if the app was launched via a dafsync:// URL
    carrying a readings list, else None."""
    for arg in argv[1:]:
        if not arg.startswith("dafsync://"):
            continue
        parsed = urllib.parse.urlparse(arg)
        query = urllib.parse.parse_qs(parsed.query)
        refs_raw = query.get("refs", [None])[0]
        if not refs_raw:
            return {}
        try:
            refs = json.loads(refs_raw)
            if isinstance(refs, list) and all(isinstance(r, str) for r in refs):
                return {"refs": refs}
        except (json.JSONDecodeError, TypeError):
            pass
        return {}
    return None
