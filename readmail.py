"""Watch a New Outlook Inbox and print each newly arrived subject once."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib import error, parse, request
import webbrowser


GRAPH_URL = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"
SCOPE = "https://graph.microsoft.com/Mail.ReadBasic offline_access"
POLL_SECONDS = 60


class MailReadError(Exception):
    pass


def json_request(url, *, form=None, headers=None):
    data = parse.urlencode(form).encode("utf-8") if form is not None else None
    req = request.Request(url, data=data, headers=headers or {})
    try:
        with request.urlopen(req, timeout=20) as response:
            status, raw = response.status, response.read()
    except error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    except error.URLError as exc:
        raise MailReadError(f"Could not reach Microsoft: {exc.reason}") from exc
    try:
        return status, json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MailReadError(f"Microsoft returned an invalid response (HTTP {status}).") from exc


class GraphAuth:
    def __init__(self, client_id, tenant):
        self.client_id = client_id
        self.authority = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"
        self.access_token = None
        self.refresh_token = None
        self.expires_at = 0

    def _remember(self, result):
        self.access_token = result["access_token"]
        self.refresh_token = result.get("refresh_token", self.refresh_token)
        self.expires_at = time.monotonic() + int(result.get("expires_in", 3600))

    def sign_in(self):
        status, flow = json_request(
            f"{self.authority}/devicecode",
            form={"client_id": self.client_id, "scope": SCOPE},
        )
        if status != 200:
            raise MailReadError(
                f"Sign-in could not start: {flow.get('error_description') or flow.get('error', status)}"
            )
        print(flow.get("message") or
              f"Visit {flow['verification_uri']} and enter code {flow['user_code']}", flush=True)
        try:
            webbrowser.open(flow["verification_uri"])
        except (OSError, webbrowser.Error):
            # The printed URL and code still allow sign-in without a browser launch.
            pass
        interval = max(1, int(flow.get("interval", 5)))
        deadline = time.monotonic() + int(flow["expires_in"])
        while time.monotonic() < deadline:
            time.sleep(interval)
            status, result = json_request(
                f"{self.authority}/token",
                form={
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": self.client_id,
                    "device_code": flow["device_code"],
                },
            )
            if status == 200 and "access_token" in result:
                self._remember(result)
                return
            code = result.get("error")
            if code == "authorization_pending":
                continue
            if code == "slow_down":
                interval += 5
                continue
            raise MailReadError(
                f"Sign-in failed: {result.get('error_description') or code or f'HTTP {status}'}"
            )
        raise MailReadError("Sign-in timed out. Run the program again for a new code.")

    def token(self):
        if not self.access_token:
            self.sign_in()
        elif time.monotonic() >= self.expires_at - 60:
            if not self.refresh_token:
                self.sign_in()
                return self.access_token
            status, result = json_request(
                f"{self.authority}/token",
                form={
                    "grant_type": "refresh_token",
                    "client_id": self.client_id,
                    "refresh_token": self.refresh_token,
                    "scope": SCOPE,
                },
            )
            if status != 200 or "access_token" not in result:
                print("Sign-in needs to be renewed.", flush=True)
                self.sign_in()
            else:
                self._remember(result)
        return self.access_token


def initial_delta_url():
    query = parse.urlencode({
        "changeType": "created",
        "$select": "id,subject,receivedDateTime",
    })
    return f"{GRAPH_URL}?{query}"


def parse_received(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def valid_delta_url(url):
    parsed = parse.urlsplit(url)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "graph.microsoft.com"
        and parsed.path.lower().startswith("/v1.0/me/mailfolders")
        and parsed.path.lower().endswith("/messages/delta")
    )


def load_state(path, client_id, tenant):
    if path.exists():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise MailReadError(f"Cannot read state file {path}: {exc}") from exc
        if state.get("client_id") != client_id or state.get("tenant") != tenant:
            raise MailReadError(
                f"{path} belongs to another app or tenant. Use --state-file for this mailbox."
            )
        if (
            not isinstance(state.get("seen_ids"), list)
            or not state.get("started_at")
            or not isinstance(state.get("initialized"), bool)
        ):
            raise MailReadError(f"Invalid state file: {path}")
        if state.get("cursor") is not None and not valid_delta_url(state["cursor"]):
            raise MailReadError(f"Invalid Inbox cursor in state file: {path}")
        return state
    state = {
        "client_id": client_id,
        "tenant": tenant,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "cursor": None,
        "initialized": False,
        "seen_ids": [],
    }
    save_state(path, state)
    return state


def save_state(path, state):
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    except OSError as exc:
        raise MailReadError(f"Cannot save state file {path}: {exc}") from exc


def poll_inbox(auth, state, state_path):
    url = state["cursor"] or initial_delta_url()
    seen = set(state["seen_ids"])
    started_at = parse_received(state["started_at"])
    reset_attempted = False
    while True:
        status, result = json_request(url, headers={
            "Authorization": f"Bearer {auth.token()}",
            "Prefer": 'IdType="ImmutableId"',
        })
        graph_error = result.get("error", {}) if isinstance(result, dict) else {}
        error_code = graph_error.get("code") if isinstance(graph_error, dict) else None
        if status == 410 or error_code == "syncStateNotFound":
            if reset_attempted:
                raise MailReadError("Inbox change cursor could not be rebuilt.")
            reset_attempted = True
            # Rebuild the cursor. Saved IDs and the original start time still prevent repeats.
            state["cursor"] = None
            save_state(state_path, state)
            url = initial_delta_url()
            continue
        if status != 200:
            detail = graph_error.get("message", f"HTTP {status}") if isinstance(graph_error, dict) else f"HTTP {status}"
            raise MailReadError(f"Could not check Inbox: {detail}")
        if not isinstance(result, dict) or not isinstance(result.get("value"), list):
            raise MailReadError("Microsoft returned an unexpected Inbox response.")
        for message in result["value"]:
            message_id = message.get("id")
            if not message_id or "@removed" in message or message_id in seen:
                continue
            received = parse_received(message.get("receivedDateTime"))
            is_new = state["initialized"] or (received is not None and received > started_at)
            if is_new:
                print(message.get("subject") or "(no subject)", flush=True)
            seen.add(message_id)
            state["seen_ids"].append(message_id)
            if is_new:
                save_state(state_path, state)
        next_url = result.get("@odata.nextLink") or result.get("@odata.deltaLink")
        if not next_url:
            raise MailReadError("Microsoft did not return an Inbox change cursor.")
        if not valid_delta_url(next_url):
            raise MailReadError("Microsoft returned an unexpected Inbox change URL.")
        state["cursor"] = next_url
        if "@odata.deltaLink" in result:
            state["initialized"] = True
        save_state(state_path, state)
        if "@odata.deltaLink" in result:
            return
        url = next_url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state-file", type=Path, default=Path(__file__).with_name("mailRead.state.json"),
        help="Where to keep the Inbox cursor and printed message IDs",
    )
    args = parser.parse_args()
    client_id = os.environ.get("OUTLOOK_CLIENT_ID", "").strip()
    tenant = os.environ.get("OUTLOOK_TENANT", "common").strip()
    try:
        if not client_id:
            raise MailReadError("Set OUTLOOK_CLIENT_ID first. See README.md for setup.")
        if not re.fullmatch(r"[A-Za-z0-9.-]+", tenant):
            raise MailReadError("OUTLOOK_TENANT must be a tenant ID, common, consumers, or organizations.")
        state = load_state(args.state_file, client_id, tenant)
        auth = GraphAuth(client_id, tenant)
        auth.sign_in()
        print("Watching Inbox. Existing mail will be skipped; new subjects appear every 60 seconds.", flush=True)
        while True:
            next_poll = time.monotonic() + POLL_SECONDS
            try:
                poll_inbox(auth, state, args.state_file)
            except MailReadError as exc:
                print(f"Check failed: {exc}", file=sys.stderr, flush=True)
            time.sleep(max(0, next_poll - time.monotonic()))
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0
    except MailReadError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
