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


def _get_blob_token() -> str | None:
    token = (os.environ.get("BLOB_READ_WRITE_TOKEN") or "").strip()
    return token or None


def get_storage_backend_name() -> str:
    """Return human-readable active storage backend name."""
    if _get_kv_config():
        return "vercel_kv"
    if _get_blob_token():
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
    meta = {
        "username": username,
        "display_name": payload.get("display_name") or username,
        "avatar_url": payload.get("avatar_url"),
        "total_films": payload.get("total_films", 0),
        "rated_films_count": payload.get("rated_films_count", 0),
        "updated_at": payload.get("updated_at"),
    }
    _kv_command(["HSET", "ltrbx:sessions_index", username, json.dumps(meta)])


def _kv_list_sessions() -> list[dict[str, Any]]:
    res = _kv_command(["HGETALL", "ltrbx:sessions_index"])
    if not res or not isinstance(res, list):
        return []
    sessions: list[dict[str, Any]] = []
    for i in range(0, len(res) - 1, 2):
        val_str = res[i + 1]
        try:
            sessions.append(json.loads(val_str))
        except Exception:
            continue
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return sessions


# ---------------------------------------------------------------------------
# 2. Vercel Blob Implementation (Drive / Blob Storage)
# ---------------------------------------------------------------------------

BLOB_API_BASE = "https://blob.vercel-storage.com"
BLOB_PREFIX = "ltrbx/sessions/"


def _blob_headers(token: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "x-api-version": "7",
    }
    if extra:
        headers.update(extra)
    return headers


def _blob_list_raw(token: str, prefix: str = BLOB_PREFIX) -> list[dict[str, Any]]:
    url = f"{BLOB_API_BASE}?prefix={urllib.parse.quote(prefix)}"
    req = urllib.request.Request(url, headers=_blob_headers(token), method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("blobs", [])


def _blob_put_json(token: str, pathname: str, data_obj: Any) -> dict[str, Any]:
    url = f"{BLOB_API_BASE}/{pathname.lstrip('/')}"
    body = json.dumps(data_obj).encode("utf-8")
    headers = _blob_headers(
        token,
        {
            "Content-Type": "application/json",
            "x-content-type": "application/json",
            "x-add-random-suffix": "0",
            "x-cache-control-max-age": "0",
        },
    )
    req = urllib.request.Request(url, data=body, headers=headers, method="PUT")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _blob_fetch_json(token: str, download_url: str) -> Any:
    sep = "&" if "?" in download_url else "?"
    bust_url = f"{download_url}{sep}_t={int(time.time() * 1000)}"
    req = urllib.request.Request(
        bust_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Cache-Control": "no-cache",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _blob_load_session(username: str) -> dict[str, Any] | None:
    token = _get_blob_token()
    if not token:
        return None
    target_path = f"{BLOB_PREFIX}{username}.json"
    blobs = _blob_list_raw(token, prefix=target_path)
    for b in blobs:
        if b.get("pathname") == target_path and b.get("url"):
            try:
                return _blob_fetch_json(token, b["url"])
            except Exception:
                return None
    return None


def _blob_save_session(username: str, payload: dict[str, Any]) -> None:
    token = _get_blob_token()
    if not token:
        return
    target_path = f"{BLOB_PREFIX}{username}.json"
    _blob_put_json(token, target_path, payload)

    # Also update lightweight _index.json for fast saved-session listing
    index_path = f"{BLOB_PREFIX}_index.json"
    existing_index: list[dict[str, Any]] = []
    try:
        blobs = _blob_list_raw(token, prefix=index_path)
        for b in blobs:
            if b.get("pathname") == index_path and b.get("url"):
                loaded = _blob_fetch_json(token, b["url"])
                if isinstance(loaded, list):
                    existing_index = loaded
                break
    except Exception:
        existing_index = []

    meta = {
        "username": username,
        "display_name": payload.get("display_name") or username,
        "avatar_url": payload.get("avatar_url"),
        "total_films": payload.get("total_films", 0),
        "rated_films_count": payload.get("rated_films_count", 0),
        "updated_at": payload.get("updated_at"),
    }
    existing_index = [item for item in existing_index if item.get("username") != username]
    existing_index.insert(0, meta)
    try:
        _blob_put_json(token, index_path, existing_index[:25])
    except Exception:
        pass


def _blob_list_sessions() -> list[dict[str, Any]]:
    token = _get_blob_token()
    if not token:
        return []
    index_path = f"{BLOB_PREFIX}_index.json"
    blobs = _blob_list_raw(token, prefix=BLOB_PREFIX)
    for b in blobs:
        if b.get("pathname") == index_path and b.get("url"):
            try:
                loaded = _blob_fetch_json(token, b["url"])
                if isinstance(loaded, list):
                    return loaded
            except Exception:
                break

    # Fallback: construct list from blob metadata
    sessions = []
    for b in blobs:
        pname = b.get("pathname", "")
        if not pname.endswith(".json") or pname.endswith("_index.json"):
            continue
        uname = pname.split("/")[-1].replace(".json", "")
        sessions.append(
            {
                "username": uname,
                "display_name": uname,
                "avatar_url": None,
                "total_films": 0,
                "rated_films_count": 0,
                "updated_at": b.get("uploadedAt"),
            }
        )
    return sessions


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
            return _kv_load_session(clean)
        except Exception:
            pass
    if _get_blob_token():
        try:
            return _blob_load_session(clean)
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
    if _get_blob_token():
        try:
            _blob_save_session(clean, payload)
            return
        except Exception:
            pass
    _disk_save_session(clean, payload)


def list_saved_sessions() -> list[dict[str, Any]]:
    if _get_kv_config():
        try:
            return _kv_list_sessions()
        except Exception:
            pass
    if _get_blob_token():
        try:
            return _blob_list_sessions()
        except Exception:
            pass
    return _disk_list_sessions()
