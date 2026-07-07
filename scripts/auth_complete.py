#!/usr/bin/env python3
"""Phase 2: poll the sign-in process until complete, exchange for API key, save.

Usage: python3 auth_complete.py <state_file>

Polls at interval, with exponential backoff on 429 rate limiting.
Output (stdout, JSON):
  {"action": "api_key", "api_key": "sk-...", "save_result": "completed"}
or
  {"action": "waiting"} (still pending, emitted periodically to confirm liveness)
or
  {"action": "error", "message": "..."}
"""

import asyncio, json, os, sys, time

import httpx

POLL_INTERVAL = 5
MAX_POLL_RETRIES = 15


def print_json(**kw):
    print(json.dumps(kw), flush=True)


async def main(state_file: str):
    with open(state_file) as f:
        state = json.load(f)

    poll_url = state["poll_url"]
    process_id = state["process_id"]
    code_verifier = state["code_verifier"]

    async with httpx.AsyncClient() as client:
        # 1. Poll until completed
        exchange_token = None
        poll_failures = 0
        last_liveness = time.monotonic()

        while True:
            try:
                r = await client.get(poll_url)

                if r.status_code == 429:
                    poll_failures += 1
                    if poll_failures >= MAX_POLL_RETRIES:
                        print_json(action="error", message="Rate limited, giving up after 15 retries")
                        sys.exit(1)
                    wait = POLL_INTERVAL * (2 ** min(poll_failures, 5))
                    await asyncio.sleep(wait)
                    continue

                if r.status_code == 410:
                    print_json(action="error", message="Sign-in expired (process no longer available)")
                    sys.exit(1)

                r.raise_for_status()
            except httpx.HTTPError as e:
                poll_failures += 1
                if poll_failures >= MAX_POLL_RETRIES:
                    print_json(action="error", message=str(e))
                    sys.exit(1)
                wait = POLL_INTERVAL * (2 ** min(poll_failures, 5))
                await asyncio.sleep(wait)
                continue

            poll_failures = 0
            payload = r.json()
            status = payload.get("status")

            if status == "completed":
                exchange_token = payload.get("exchange_token")
                break
            elif status == "expired":
                print_json(action="error", message="Sign-in expired")
                sys.exit(1)
            elif status == "denied":
                print_json(action="error", message="Sign-in was denied")
                sys.exit(1)
            elif status == "error":
                print_json(action="error", message=payload.get("message", "Sign-in error"))
                sys.exit(1)

            # Send liveness signal every 30 seconds
            now = time.monotonic()
            if now - last_liveness >= 30:
                print_json(action="waiting")
                last_liveness = now

            await asyncio.sleep(POLL_INTERVAL)

        if not exchange_token:
            print_json(action="error", message="No exchange token in poll response")
            sys.exit(1)

        # 2. Exchange for API key
        r = await client.post(
            f"https://console.mistral.ai/api/vibe/sign-in/{process_id}/exchange",
            json={"exchange_token": exchange_token, "code_verifier": code_verifier},
        )
        r.raise_for_status()
        payload = r.json()
        api_key = payload.get("api_key")
        if not api_key:
            print_json(action="error", message="No API key in exchange response")
            sys.exit(1)

        # 3. Save to ~/.vibe/.env
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

        # 4. Set in env so running vibe-acp picks it up (it won't without restart, but future reads work)
        os.environ["MISTRAL_API_KEY"] = api_key

        print_json(action="api_key", api_key=api_key, save_result="completed")


if __name__ == "__main__":
    try:
        state_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vibe-auth-state.json"
        asyncio.run(main(state_file))
    except Exception as e:
        print_json(action="error", message=str(e))
        sys.exit(1)
