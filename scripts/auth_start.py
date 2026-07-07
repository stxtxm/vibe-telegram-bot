#!/usr/bin/env python3
"""Phase 1: create a sign-in process, print the URL, save state to a file.

Usage: python3 auth_start.py <state_file>

Output (stdout, JSON):
  {"action": "sign_in_url", "sign_in_url": "https://..."}
or
  {"action": "error", "message": "..."}
"""

import asyncio, base64, hashlib, json, secrets, sys

import httpx


CODE_VERIFIER = secrets.token_urlsafe(64)


def code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


async def main(state_file: str):
    async with httpx.AsyncClient() as client:
        r = await client.post(
            "https://console.mistral.ai/api/vibe/sign-in",
            json={
                "code_challenge": code_challenge(CODE_VERIFIER),
                "code_challenge_method": "S256",
            },
        )
        r.raise_for_status()
        data = r.json()

        poll_url = data["poll_url"]
        if not poll_url.startswith("http"):
            base = "https://console.mistral.ai"
            poll_url = base + poll_url if poll_url.startswith("/") else f"{base}/api/vibe/sign-in/poll/{poll_url}"

        state = {
            "sign_in_url": data["sign_in_url"],
            "poll_url": poll_url,
            "process_id": data["process_id"],
            "code_verifier": CODE_VERIFIER,
            "expires_at": data["expires_at"],
        }

        with open(state_file, "w") as f:
            json.dump(state, f)

        print(json.dumps({"action": "sign_in_url", "sign_in_url": data["sign_in_url"]}), flush=True)


if __name__ == "__main__":
    try:
        state_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vibe-auth-state.json"
        asyncio.run(main(state_file))
    except Exception as e:
        print(json.dumps({"action": "error", "message": str(e)}), flush=True)
        sys.exit(1)
