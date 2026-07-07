#!/usr/bin/env python3
"""Minimal vibe auth: starts sign-in, prints URL, polls, exchanges, saves key.

Uses httpx.AsyncClient to maintain session cookies across requests.
"""

import asyncio, base64, hashlib, json, os, secrets, sys
import httpx


CODE_VERIFIER = secrets.token_urlsafe(64)
POLL_INTERVAL = 5  # seconds between polls
MAX_POLL_RETRIES = 10  # max consecutive failures before giving up


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def resolve_poll_url(poll_url: str) -> str:
    if poll_url.startswith("http"):
        return poll_url
    if poll_url.startswith("/"):
        return f"https://console.mistral.ai{poll_url}"
    return f"https://console.mistral.ai/api/vibe/sign-in/poll/{poll_url}"


def print_json(**kw):
    print(json.dumps(kw), flush=True)


async def main():
    async with httpx.AsyncClient(
        headers={"User-Agent": "Mistral-Vibe/0.1"},
    ) as client:
        # 1. Create process
        r = await client.post(
            "https://console.mistral.ai/api/vibe/sign-in",
            json={
                "code_challenge": code_challenge(CODE_VERIFIER),
                "code_challenge_method": "S256",
            },
        )
        r.raise_for_status()
        data = r.json()
        sign_in_url = data["sign_in_url"]
        poll_url = resolve_poll_url(data["poll_url"])
        process_id = data["process_id"]

        print_json(action="sign_in_url", sign_in_url=sign_in_url)

        # 2. Poll until completed (with retry on 429)
        exchange_token = None
        poll_failures = 0

        while True:
            try:
                r = await client.get(poll_url)
                if r.status_code == 429:
                    poll_failures += 1
                    if poll_failures >= MAX_POLL_RETRIES:
                        print_json(action="error", message="Rate limited, giving up")
                        sys.exit(1)
                    wait = POLL_INTERVAL * (2 ** poll_failures)
                    await asyncio.sleep(min(wait, 60))
                    continue

                if r.status_code == 410:
                    print_json(action="error", message="Sign-in expired")
                    sys.exit(1)

                r.raise_for_status()
            except httpx.HTTPError as e:
                poll_failures += 1
                if poll_failures >= MAX_POLL_RETRIES:
                    print_json(action="error", message=str(e))
                    sys.exit(1)
                await asyncio.sleep(POLL_INTERVAL * (2 ** poll_failures))
                continue

            poll_failures = 0
            payload = r.json()
            status = payload.get("status")

            if status == "completed":
                exchange_token = payload.get("exchange_token")
                break
            elif status in ("expired",):
                print_json(action="error", message="Sign-in expired")
                sys.exit(1)
            elif status == "denied":
                print_json(action="error", message="Sign-in was denied")
                sys.exit(1)
            elif status == "error":
                print_json(action="error", message=payload.get("message", "Sign-in error"))
                sys.exit(1)

            # pending - wait and retry
            await asyncio.sleep(POLL_INTERVAL)

        if not exchange_token:
            print_json(action="error", message="No exchange token")
            sys.exit(1)

        # 3. Exchange for API key
        r = await client.post(
            f"https://console.mistral.ai/api/vibe/sign-in/{process_id}/exchange",
            json={"exchange_token": exchange_token, "code_verifier": CODE_VERIFIER},
        )
        r.raise_for_status()
        payload = r.json()
        api_key = payload.get("api_key")
        if not api_key:
            print_json(action="error", message="No API key in exchange response")
            sys.exit(1)

        # 4. Save to ~/.vibe/.env
        env_path = os.path.expanduser("~/.vibe/.env")
        os.makedirs(os.path.dirname(env_path), exist_ok=True)

        env_lines = []
        if os.path.exists(env_path):
            with open(env_path) as f:
                env_lines = f.readlines()

        found = False
        for i, line in enumerate(env_lines):
            stripped = line.strip()
            if stripped.startswith("MISTRAL_API_KEY="):
                env_lines[i] = f"MISTRAL_API_KEY='{api_key}'\n"
                found = True
                break

        if not found:
            env_lines.append(f"MISTRAL_API_KEY='{api_key}'\n")

        with open(env_path, "w") as f:
            f.writelines(env_lines)

        print_json(action="api_key", api_key=api_key, save_result="completed")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print_json(action="error", message=str(e))
        sys.exit(1)
