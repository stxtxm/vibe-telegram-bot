#!/usr/bin/env python3
"""Vibe auth helper: starts browser sign-in, prints URL, waits, saves key.

Communication protocol (JSON lines on stdout):
  1. {"action":"sign_in_url","sign_in_url":"https://..."}
  2. {"action":"api_key","api_key":"sk-...","save_result":"completed"}
  or {"action":"error","message":"..."}
"""

import asyncio, json, sys

from vibe.setup.auth.browser_sign_in import BrowserSignInService
from vibe.setup.auth.http_browser_sign_in_gateway import HttpBrowserSignInGateway
from vibe.setup.auth.api_key_persistence import (
    persist_api_key,
    resolve_api_key_provider,
)
from vibe.core.config import ProviderConfig
from vibe.core.types import Backend


async def main():
    provider = ProviderConfig(
        name="mistral",
        api_base="https://api.mistral.ai/v1",
        api_key_env_var="MISTRAL_API_KEY",
        browser_auth_base_url="https://console.mistral.ai",
        browser_auth_api_base_url="https://console.mistral.ai/api",
        backend=Backend.MISTRAL,
    )

    gateway = HttpBrowserSignInGateway(
        browser_base_url=provider.browser_auth_base_url,
        api_base_url=provider.browser_auth_api_base_url,
    )
    service = BrowserSignInService(gateway)

    attempt = await service.start_attempt()

    print(json.dumps({"action": "sign_in_url", "sign_in_url": attempt.sign_in_url}), flush=True)

    api_key = await service.complete_attempt(attempt)

    save_result = persist_api_key(resolve_api_key_provider(provider), api_key)

    print(json.dumps({"action": "api_key", "api_key": api_key, "save_result": save_result}), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({"action": "error", "message": str(e)}), flush=True)
        sys.exit(1)
