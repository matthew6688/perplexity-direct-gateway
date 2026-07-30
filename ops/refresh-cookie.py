#!/usr/bin/env python3
"""
Refresh Perplexity session cookie from the already-logged-in Chrome session,
then notify the running gateway to reload it.

Run periodically (launchd) to keep the session cookie fresh.
Works even when the gateway is down — the new cookie is written to disk and
picked up on next gateway start.

Flow:
  1. Read current cookie from ~/.perplexity-session.txt
  2. GET https://www.perplexity.ai/api/auth/session with the current cookie
  3. Extract new cookie from Set-Cookie response header
  4. Write new cookie to ~/.perplexity-session.txt
  5. POST http://127.0.0.1:8788/refresh to tell gateway to reload

If HTTP refresh fails (cookie too stale), falls back to CDP extraction via
the gateway's extract-session.mjs — which pulls a fresh cookie directly
from Chrome's httpOnly cookie store (no re-login needed as long as
perplexity.ai is still logged in).
"""
import subprocess, json, os, sys, time
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

SESSION_FILE = os.path.expanduser("~/.perplexity-session.txt")
GATEWAY_URL = "http://127.0.0.1:8788"
PPLX_AUTH_URL = "https://www.perplexity.ai/api/auth/session"
EXTRACT_SCRIPT = os.path.expanduser("~/perplexity-direct-gateway/extract-session.mjs")
LOG_DIR = os.path.expanduser("~/Library/Logs/perplexity-direct")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"


def read_current_cookie():
    """Read the current session cookie from disk, or None."""
    try:
        with open(SESSION_FILE) as f:
            val = f.read().strip()
            return val if val else None
    except FileNotFoundError:
        return None


def write_cookie(value):
    """Write a new cookie value to the session file."""
    os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
    with open(SESSION_FILE, "w") as f:
        f.write(value + "\n")
    os.chmod(SESSION_FILE, 0o600)


def refresh_via_http(cookie_value):
    """Try to refresh the cookie via Perplexity's /api/auth/session endpoint.
    Returns the new cookie value, or None."""
    req = Request(PPLX_AUTH_URL, method="GET")
    req.add_header("Cookie", f"__Secure-next-auth.session-token={cookie_value}")
    req.add_header("User-Agent", UA)
    req.add_header("Origin", "https://www.perplexity.ai")
    try:
        resp = urlopen(req, timeout=30)
        # Perplexity returns Set-Cookie with the refreshed session token
        set_cookie = resp.headers.get("Set-Cookie", "")
        for part in set_cookie.split(", "):
            m = __import__("re").match(
                r"^__Secure-next-auth\.session-token=([^;]+)", part
            )
            if m:
                return m.group(1)
        # Try the full header if split didn't work
        m = __import__("re").match(
            r"^__Secure-next-auth\.session-token=([^;]+)", set_cookie
        )
        if m:
            return m.group(1)
    except (URLError, HTTPError) as e:
        print(f"HTTP refresh failed: {e}")
    return None


def extract_from_chrome():
    """Fall back to CDP extraction from Chrome.
    Returns the cookie value, or None."""
    try:
        result = subprocess.run(
            ["node", EXTRACT_SCRIPT],
            capture_output=True, text=True, timeout=30,
            cwd=os.path.expanduser("~/perplexity-direct-gateway"),
        )
        if result.returncode != 0:
            print(f"extract-session.mjs failed: {result.stderr.strip()[:300]}")
            return None
        # Output format: __Secure-next-auth.session-token=<value>
        for line in result.stdout.strip().split("\n"):
            if line.startswith("__Secure-next-auth.session-token="):
                return line.split("=", 1)[1]
        print(f"extract-session.mjs returned unexpected output: {result.stdout[:200]}")
    except Exception as e:
        print(f"Chrome extraction failed: {e}")
    return None


def notify_gateway():
    """Tell the running gateway to reload its cookie from the file."""
    try:
        req = Request(f"{GATEWAY_URL}/refresh", method="POST", data=b"")
        req.add_header("Content-Type", "application/json")
        urlopen(req, timeout=10)
        print("Gateway notified to reload cookie.")
        return True
    except Exception as e:
        print(f"Gateway notification failed (gateway may be down): {e}")
        return False


def main():
    os.makedirs(LOG_DIR, exist_ok=True)

    current = read_current_cookie()
    if not current:
        print("No session cookie on disk — bootstrapping from Chrome...")
        new_cookie = extract_from_chrome()
        if not new_cookie:
            print("ERROR: Cannot bootstrap — is perplexity.ai logged in Chrome?")
            sys.exit(1)
        write_cookie(new_cookie)
        print("Cookie bootstrapped from Chrome.")
        notify_gateway()
        return

    # Try HTTP refresh first (matches aurora-ops pattern)
    new_cookie = refresh_via_http(current)
    if new_cookie:
        write_cookie(new_cookie)
        print("Cookie refreshed via HTTP.")
        notify_gateway()
        return

    # HTTP refresh failed — fall back to Chrome CDP extraction
    print("HTTP refresh failed, falling back to Chrome CDP extraction...")
    new_cookie = extract_from_chrome()
    if new_cookie:
        write_cookie(new_cookie)
        print("Cookie refreshed via Chrome CDP.")
        notify_gateway()
        return

    print("ERROR: All refresh methods failed.")
    sys.exit(1)


if __name__ == "__main__":
    main()
