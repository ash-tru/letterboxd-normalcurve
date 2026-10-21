"""Cloud and local storage abstraction for LTRBX.

Supports (in priority order):
1. Vercel KV / Upstash Redis REST API (`KV_REST_API_URL` + `KV_REST_API_TOKEN`
   or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`)
2. Vercel Blob Storage (`BLOB_READ_WRITE_TOKEN`)
3. Local filesystem fallback (`data/` locally, or `/tmp/ltrbx_data` on read-only serverless disks)
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from letterboxd import normalize_username

try:
    from vercel.blob import BlobNotFoundError
    from vercel.blob import sync as vercel_blob_sync
except ImportError:
    vercel_blob_sync = None  # type: ignore[assignment]
    BlobNotFoundError = FileNotFoundError  # type: ignore[assignment,misc]

BASE_DIR = Path(__file__).resolve().parent


def _get_kv_config() -> tuple[str, str] | None:
    url = (
        os.environ.get("KV_REST_API_URL")
        or os.environ.get("UPSTASH_REDIS_REST_URL")
        or ""
    ).strip().rstrip("/")
    token = (
        os.environ.get("KV_REST_API_TOKEN")
        or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
        or ""
    ).strip()
    if url and token:
        return url, token
    return None


def _is_blob_configured() -> bool:
    """Return True if Vercel Blob is configured via BLOB_STORE_ID (OIDC) or BLOB_READ_WRITE_TOKEN."""
    return bool(
        (os.environ.get("BLOB_STORE_ID") or "").strip()
        or (os.environ.get("BLOB_READ_WRITE_TOKEN") or "").strip()
        or (os.environ.get("VERCEL_BLOB_READ_WRITE_TOKEN") or "").strip()
    )


def get_storage_backend_name() -> str:
    """Return human-readable active storage backend name."""
    if _get_kv_config():
        return "vercel_kv"
    if _is_blob_configured():
        return "vercel_blob"
    return "local_disk"


# ---------------------------------------------------------------------------
# 1. Vercel KV / Upstash Redis Implementation
# ---------------------------------------------------------------------------

def _kv_command(cmd: list[str]) -> Any:
    cfg = _get_kv_config()
    if not cfg:
        raise RuntimeError("KV config not set")
    url, token = cfg
    req = urllib.request.Request(
        url,
        data=json.dumps(cmd).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("result")


def _kv_load_session(username: str) -> dict[str, Any] | None:
    raw = _kv_command(["GET", f"ltrbx:session:{username}"])
    if not raw or not isinstance(raw, str):
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _kv_save_session(username: str, payload: dict[str, Any]) -> None:
    raw_json = json.dumps(payload)
    _kv_command(["SET", f"ltrbx:session:{username}", raw_json])


def _kv_list_sessions() -> list[dict[str, Any]]:
    return []


# ---------------------------------------------------------------------------
# 2. Vercel Blob Implementation (Supports OIDC `BLOB_STORE_ID` + `BLOB_READ_WRITE_TOKEN`)
# ---------------------------------------------------------------------------

BLOB_PREFIX = "ltrbx/sessions/"
_DETECTED_BLOB_ACCESS: str | None = None


def _blob_put_bytes(pathname: str, data_bytes: bytes) -> None:
    global _DETECTED_BLOB_ACCESS
    if vercel_blob_sync is None:
        return
    modes = (
        [_DETECTED_BLOB_ACCESS, "private" if _DETECTED_BLOB_ACCESS == "public" else "public"]
        if _DETECTED_BLOB_ACCESS
        else ["public", "private"]
    )
    last_err: Exception | None = None
    for mode in modes:
        try:
            vercel_blob_sync.put_blob(
                pathname,
                data_bytes,
                access=mode,  # type: ignore[arg-type]
                content_type="application/json",
                add_random_suffix=False,
                allow_overwrite=True,
                cache_control_max_age=0,
            )
            _DETECTED_BLOB_ACCESS = mode
            return
        except Exception as exc:
            last_err = exc
    if last_err:
        raise last_err


def _blob_get_json(pathname: str) -> Any | None:
    global _DETECTED_BLOB_ACCESS
    if vercel_blob_sync is None:
        return None
    modes = (
        [_DETECTED_BLOB_ACCESS, "private" if _DETECTED_BLOB_ACCESS == "public" else "public"]
        if _DETECTED_BLOB_ACCESS
        else ["public", "private"]
    )
    for mode in modes:
        try:
            res = vercel_blob_sync.get_blob(pathname, access=mode)  # type: ignore[arg-type]
            _DETECTED_BLOB_ACCESS = mode
            return json.loads(res.body.decode("utf-8"))
        except BlobNotFoundError:
            return None
        except Exception:
            continue
    return None


def _blob_load_session(username: str) -> dict[str, Any] | None:
    if not _is_blob_configured() or vercel_blob_sync is None:
        return None
    target_path = f"{BLOB_PREFIX}{username}.json"
    data = _blob_get_json(target_path)
    return data if isinstance(data, dict) else None


def _blob_save_session(username: str, payload: dict[str, Any]) -> None:
    if not _is_blob_configured() or vercel_blob_sync is None:
        return
    target_path = f"{BLOB_PREFIX}{username}.json"
    _blob_put_bytes(target_path, json.dumps(payload).encode("utf-8"))


def _blob_list_sessions() -> list[dict[str, Any]]:
    return []


# ---------------------------------------------------------------------------
# 3. Local Disk Fallback (for local dev or unconfigured env)
# ---------------------------------------------------------------------------

def _get_local_data_dir() -> Path:
    if os.environ.get("VERCEL"):
        d = Path("/tmp/ltrbx_data")
    else:
        d = BASE_DIR / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _disk_load_session(username: str) -> dict[str, Any] | None:
    path = _get_local_data_dir() / f"{username}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _disk_save_session(username: str, payload: dict[str, Any]) -> None:
    path = _get_local_data_dir() / f"{username}.json"
    try:
        path.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass


def _disk_list_sessions() -> list[dict[str, Any]]:
    data_dir = _get_local_data_dir()
    sessions = []
    for path in sorted(data_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        if path.name.startswith("_"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            sessions.append(
                {
                    "username": data.get("username", path.stem),
                    "display_name": data.get("display_name", path.stem),
                    "avatar_url": data.get("avatar_url"),
                    "total_films": data.get("total_films", 0),
                    "rated_films_count": data.get("rated_films_count", 0),
                    "updated_at": data.get("updated_at"),
                }
            )
        except Exception:
            continue
    return sessions


# ---------------------------------------------------------------------------
# Public Unified Storage Functions
# ---------------------------------------------------------------------------

def load_user_session(username: str) -> dict[str, Any] | None:
    clean = normalize_username(username)
    if _get_kv_config():
        try:
            res = _kv_load_session(clean)
            if res:
                return res
        except Exception:
            pass
    if _is_blob_configured():
        try:
            res = _blob_load_session(clean)
            if res:
                return res
        except Exception:
            pass
    return _disk_load_session(clean)


def save_user_session(username: str, payload: dict[str, Any]) -> None:
    clean = normalize_username(username)
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload["storage_backend"] = get_storage_backend_name()
    if _get_kv_config():
        try:
            _kv_save_session(clean, payload)
            return
        except Exception:
            pass
    if _is_blob_configured():
        try:
            _blob_save_session(clean, payload)
            return
        except Exception:
            pass
    _disk_save_session(clean, payload)


def list_saved_sessions() -> list[dict[str, Any]]:
    """Saved profile chips are stored per-browser on the client, never globally."""
    return []
