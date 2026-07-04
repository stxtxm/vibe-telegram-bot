"""Wrapper for vibe-acp that patches httpx pool timeout to prevent PoolTimeout errors.

The MistralBackend creates httpx.AsyncClient without an explicit timeout,
inheriting httpx's default 5s pool timeout. While the Mistral SDK sets per-request
timeout to 720s, the underlying httpx client's pool timeout can still trigger
PoolTimeout('') errors during connection pool contention.

This wrapper ensures the httpx client is created with the same 720s timeout
that the SDK intends for individual requests.
"""
import httpx
from vibe.core.llm.backend import mistral as mistral_backend
from vibe.core.utils.http import build_ssl_context


def _patched_create_client(self):
    """Create httpx client with explicit 720s timeout instead of default 5s."""
    self._http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(720.0),
        verify=build_ssl_context(),
        follow_redirects=True,
    )
    from mistralai.client import Mistral

    return Mistral(
        api_key=self._api_key,
        server_url=self._server_url,
        timeout_ms=int(self._timeout * 1000),
        retry_config=self._retry_config,
        async_client=self._http_client,
    )


mistral_backend.MistralBackend._create_mistral_client = _patched_create_client

from vibe.acp.entrypoint import main

main()
