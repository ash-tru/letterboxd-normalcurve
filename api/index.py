"""Vercel Python Serverless Function entrypoint for LTRBX."""

from __future__ import annotations

import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from letterboxd import (  # noqa: E402
    export_normal_curve_csv,
    generate_svg_poster,
    normalize_username,
    resolve_fallback_poster_url,
    search_letterboxd_films,
)
from server import (  # noqa: E402
    POSTER_CACHE_LOCK,
    POSTER_MEM_CACHE,
    STATIC_DIR,
    process_import_csv,
    process_lookup_sync,
    process_save_order,
)
from storage import (  # noqa: E402
    get_storage_backend_name,
    list_saved_sessions,
    load_user_session,
)

try:
    from vercel.headers import set_headers as set_vercel_headers
except ImportError:
    set_vercel_headers = None  # type: ignore[assignment]


class handler(BaseHTTPRequestHandler):  # noqa: N801
    """Vercel @vercel/python request handler."""

    def _register_oidc_headers(self) -> None:
        if set_vercel_headers is not None:
            hdrs = {k.lower(): v for k, v in self.headers.items()}
            set_vercel_headers(hdrs)

    def _resolve_route(self) -> tuple[str, dict[str, list[str]]]:
        """Resolve original request path and query parameters across Vercel rewrites."""
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        raw_path = parsed.path

        if "__route" in qs and qs["__route"]:
            routed = qs["__route"][0]
            if not routed.startswith("/"):
                routed = f"/{routed}"
            raw_path = routed

        clean_path = raw_path.rstrip("/") or "/"
        return clean_path, qs

    def _send_json(self, data: Any, status: int = 200) -> None:
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._register_oidc_headers()
        path, qs = self._resolve_route()

        if path == "/api/saved":
            self._send_json(
                {
                    "sessions": list_saved_sessions(),
                    "storage_backend": get_storage_backend_name(),
                }
            )
            return

        if path == "/api/search-film":
            q = (qs.get("q") or [""])[0].strip()
            results = search_letterboxd_films(q, 6) if q else []
            self._send_json({"results": results})
            return

        if path.startswith("/api/export-csv/"):
            raw_user = path.split("/api/export-csv/")[-1].strip("/")
            try:
                clean = normalize_username(raw_user)
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=400)
                return
            session = load_user_session(clean)
            if not session:
                self._send_json({"error": "Session not found"}, status=404)
                return
            films = session.get("normal_curve", {}).get("films", [])
            csv_bytes = export_normal_curve_csv(films).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{clean}_letterboxd_normal_curve.csv"',
            )
            self.send_header("Content-Length", str(len(csv_bytes)))
            self.end_headers()
            self.wfile.write(csv_bytes)
            return

        if path.startswith("/api/poster/"):
            slug = path.split("/api/poster/")[-1].strip("/")
            film_id = (qs.get("id") or [""])[0]
            title = (qs.get("title") or [slug.replace("-", " ").title()])[0]
            year = (qs.get("year") or [""])[0]
            cache_key = f"{slug}:{year}" if (year and not film_id.isdigit()) else slug

            with POSTER_CACHE_LOCK:
                has_cached = cache_key in POSTER_MEM_CACHE
                cached_url = POSTER_MEM_CACHE.get(cache_key)

            if not has_cached:
                cached_url = resolve_fallback_poster_url(slug, film_id, year or None)
                with POSTER_CACHE_LOCK:
                    if len(POSTER_MEM_CACHE) > 5000:
                        POSTER_MEM_CACHE.clear()
                    POSTER_MEM_CACHE[cache_key] = cached_url

            if cached_url:
                self.send_response(302)
                self.send_header("Location", cached_url)
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                return

            svg_bytes = generate_svg_poster(title=title, year=year or None).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Content-Length", str(len(svg_bytes)))
            self.end_headers()
            self.wfile.write(svg_bytes)
            return

        # Serve static frontend files if routed here
        rel_name = "index.html" if path in ("", "/", "/api/index.py") else path.lstrip("/")
        if rel_name == "favicon.ico":
            rel_name = "favicon.svg"
        if rel_name.startswith("static/"):
            rel_name = rel_name[len("static/"):]
        static_file = (STATIC_DIR / rel_name).resolve()
        if STATIC_DIR.resolve() in static_file.parents and static_file.is_file():
            content = static_file.read_bytes()
            ctype = "text/html; charset=utf-8"
            if static_file.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            elif static_file.suffix == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif static_file.suffix == ".svg":
                ctype = "image/svg+xml; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        self._send_json({"error": f"Not found: {path}"}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        self._register_oidc_headers()
        path, _qs = self._resolve_route()
        body = self._read_json_body()

        if path == "/api/lookup":
            res_data, status_code = process_lookup_sync(body)
            self._send_json(res_data, status=status_code)
            return

        if path == "/api/save-order":
            res_data, status_code = process_save_order(body)
            self._send_json(res_data, status=status_code)
            return

        if path == "/api/import-csv":
            res_data, status_code = process_import_csv(body)
            self._send_json(res_data, status=status_code)
            return

        self._send_json({"error": f"Not found: {path}"}, status=404)
