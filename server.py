"""Web server and REST API for the Letterboxd Bell-Curve Ranker (eggs/ltrbx)."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

import tornado.ioloop
import tornado.web
from letterboxd import (
    compute_bell_curve_assignments,
    fetch_user_watched_films,
    generate_svg_poster,
    normalize_username,
    parse_letterboxd_csv,
    resolve_fallback_poster_url,
    search_letterboxd_films,
    slugify_title,
    sort_films_by_rating,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Stateless in-memory caches (no /data directory or disk writes required)
POSTER_MEM_CACHE: dict[str, str | None] = {}
POSTER_CACHE_LOCK = threading.Lock()

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()


def build_session_payload(
    raw_profile: dict[str, Any],
    include_unrated: bool = True,
    manual_order_slugs: list[str] | None = None,
    mean: float = 2.75,
    std_dev: float = 1.0,
    comparisons_done: int = 0,
) -> dict[str, Any]:
    """Build complete session state including initial rating sort, manual sort, and bell curve."""
    all_films = raw_profile.get("films", [])
    rating_sorted = sort_films_by_rating(all_films, include_unrated=include_unrated)

    if manual_order_slugs:
        film_by_slug: dict[str, dict[str, Any]] = {}
        for f in rating_sorted:
            film_by_slug[f["slug"]] = f
            base_s = slugify_title(f.get("title", ""))
            if base_s and base_s not in film_by_slug:
                film_by_slug[base_s] = f
            legacy_s = re.sub(r"[^a-z0-9]+", "-", f.get("title", "").lower()).strip("-")
            if legacy_s and legacy_s not in film_by_slug:
                film_by_slug[legacy_s] = f

        ordered: list[dict[str, Any]] = []
        seen: set[str] = set()
        for slug in manual_order_slugs:
            matched = film_by_slug.get(slug)
            if matched and matched["slug"] not in seen:
                ordered.append(matched)
                seen.add(matched["slug"])
        for film in rating_sorted:
            if film["slug"] not in seen:
                ordered.append(film)
                seen.add(film["slug"])
        manual_sorted = ordered
    else:
        manual_sorted = [dict(f) for f in rating_sorted]

    bell_curve = compute_bell_curve_assignments(
        manual_sorted,
        mean=mean,
        std_dev=std_dev,
    )

    return {
        "username": raw_profile["username"],
        "display_name": raw_profile.get("display_name") or raw_profile["username"],
        "avatar_url": raw_profile.get("avatar_url"),
        "profile_url": raw_profile.get("profile_url"),
        "total_pages_fetched": raw_profile.get("total_pages_fetched", 1),
        "total_pages_available": raw_profile.get("total_pages_available", 1),
        "total_films": raw_profile.get("total_films", len(all_films)),
        "rated_films_count": raw_profile.get("rated_films_count", 0),
        "unrated_films_count": raw_profile.get("unrated_films_count", 0),
        "settings": {
            "include_unrated": include_unrated,
            "mean": mean,
            "std_dev": std_dev,
            "comparisons_done": comparisons_done,
        },
        "raw_films": all_films,
        "rating_sorted_films": rating_sorted,
        "bell_curve": bell_curve,
    }


class BaseJsonHandler(tornado.web.RequestHandler):
    """Base handler with JSON response helpers."""

    def set_default_headers(self) -> None:
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "Content-Type")
        self.set_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def options(self, *_args: Any, **_kwargs: Any) -> None:
        self.set_status(204)
        self.finish()

    def write_json(self, data: Any, status: int = 200) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json; charset=utf-8")
        self.finish(json.dumps(data))

    def get_json_body(self) -> dict[str, Any]:
        if not self.request.body:
            return {}
        try:
            return json.loads(self.request.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise tornado.web.HTTPError(400, reason=f"Invalid JSON body: {exc}") from exc


class LookupHandler(BaseJsonHandler):
    """POST /api/lookup - start async scrape job for up to 2,000 films (stateless)."""

    def post(self) -> None:
        body = self.get_json_body()
        raw_username = str(body.get("username") or "").strip()
        try:
            username = normalize_username(raw_username)
        except ValueError as exc:
            self.write_json({"error": str(exc)}, status=400)
            return

        include_unrated = bool(body.get("include_unrated", True))
        max_pages_raw = body.get("max_pages")
        max_pages = int(max_pages_raw) if max_pages_raw else None
        prev_slugs = body.get("ordered_slugs") if isinstance(body.get("ordered_slugs"), list) else None
        mean = float(body.get("mean", 2.75))
        std_dev = float(body.get("std_dev", 1.0))
        comparisons_done = int(body.get("comparisons_done", 0))

        job_id = str(uuid.uuid4())
        with JOBS_LOCK:
            JOBS[job_id] = {
                "job_id": job_id,
                "username": username,
                "status": "running",
                "current_page": 0,
                "total_pages": 1,
                "films_loaded": 0,
                "error": None,
                "session": None,
            }

        def _worker() -> None:
            def _on_progress(curr_page: int, total_pages: int, films_so_far: int) -> None:
                with JOBS_LOCK:
                    if job_id in JOBS:
                        JOBS[job_id]["current_page"] = curr_page
                        JOBS[job_id]["total_pages"] = total_pages
                        JOBS[job_id]["films_loaded"] = films_so_far

            try:
                profile = fetch_user_watched_films(
                    username=username,
                    max_pages=max_pages,
                    on_progress=_on_progress,
                )
                session_payload = build_session_payload(
                    raw_profile=profile,
                    include_unrated=include_unrated,
                    manual_order_slugs=prev_slugs,
                    mean=mean,
                    std_dev=std_dev,
                    comparisons_done=comparisons_done,
                )
                with JOBS_LOCK:
                    JOBS[job_id]["status"] = "completed"
                    JOBS[job_id]["session"] = session_payload
            except Exception as exc:
                with JOBS_LOCK:
                    JOBS[job_id]["status"] = "error"
                    JOBS[job_id]["error"] = str(exc)

        threading.Thread(target=_worker, daemon=True).start()
        self.write_json({"status": "running", "job_id": job_id, "username": username})


class JobStatusHandler(BaseJsonHandler):
    """GET /api/jobs/<job_id> - poll scrape job progress."""

    def get(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                self.write_json({"error": "Job not found"}, status=404)
                return
            payload = dict(job)
            if payload.get("status") in ("completed", "error"):
                JOBS.pop(job_id, None)
        self.write_json(payload)


class ImportCsvHandler(BaseJsonHandler):
    """POST /api/import-csv - import Letterboxd ratings.csv or watched.csv (stateless)."""

    def post(self) -> None:
        body = self.get_json_body()
        csv_text = str(body.get("csv_text") or "")
        raw_username = str(body.get("username") or "csv_import").strip()
        try:
            username = normalize_username(raw_username)
        except ValueError:
            username = "csv_import"

        if not csv_text.strip():
            self.write_json({"error": "CSV content is empty."}, status=400)
            return

        profile = parse_letterboxd_csv(csv_text, username=username, resolve_remote=True)
        if not profile["films"]:
            self.write_json(
                {"error": "No valid films found in CSV. Expected columns like Name/Title, Year, Rating."},
                status=400,
            )
            return

        session_payload = build_session_payload(raw_profile=profile, include_unrated=True)
        self.write_json({"status": "completed", "session": session_payload})


class PosterFallbackHandler(tornado.web.RequestHandler):
    """GET /api/poster/<slug> - resolves true Letterboxd poster URL or serves styled SVG poster."""

    async def get(self, slug: str) -> None:
        film_id = self.get_argument("id", "")
        title = self.get_argument("title", slug.replace("-", " ").title())
        year = self.get_argument("year", "")
        cache_key = f"{slug}:{year}" if (year and not film_id.isdigit()) else slug

        with POSTER_CACHE_LOCK:
            has_cached = cache_key in POSTER_MEM_CACHE
            cached_url = POSTER_MEM_CACHE.get(cache_key)

        if not has_cached:
            loop = asyncio.get_running_loop()
            cached_url = await loop.run_in_executor(
                None,
                resolve_fallback_poster_url,
                slug,
                film_id,
                year or None,
            )
            with POSTER_CACHE_LOCK:
                if len(POSTER_MEM_CACHE) > 5000:
                    POSTER_MEM_CACHE.clear()
                POSTER_MEM_CACHE[cache_key] = cached_url

        if cached_url:
            self.set_header("Cache-Control", "public, max-age=86400")
            self.redirect(cached_url, permanent=False)
            return

        svg = generate_svg_poster(title=title, year=year or None)
        self.set_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.set_header("Cache-Control", "public, max-age=86400")
        self.finish(svg)


class SearchFilmHandler(BaseJsonHandler):
    """GET /api/search-film?q=<query> - search Letterboxd films by title/year."""

    async def get(self) -> None:
        query = self.get_argument("q", "").strip()
        if not query:
            self.write_json({"results": []})
            return
        loop = asyncio.get_running_loop()
        results = await loop.run_in_executor(None, search_letterboxd_films, query, 6)
        self.write_json({"results": results})


def make_app() -> tornado.web.Application:
    return tornado.web.Application(
        [
            (r"/api/lookup", LookupHandler),
            (r"/api/jobs/([a-zA-Z0-9-]+)", JobStatusHandler),
            (r"/api/import-csv", ImportCsvHandler),
            (r"/api/search-film", SearchFilmHandler),
            (r"/api/poster/([a-zA-Z0-9_-]+)", PosterFallbackHandler),
            (
                r"/(.*)",
                tornado.web.StaticFileHandler,
                {"path": str(STATIC_DIR), "default_filename": "index.html"},
            ),
        ],
        debug=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Letterboxd Bell-Curve Ranker Server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()

    app = make_app()
    app.listen(args.port, address=args.host)
    print(f"🎬 Letterboxd Bell-Curve Ranker running at http://localhost:{args.port}")
    tornado.ioloop.IOLoop.current().start()


if __name__ == "__main__":
    main()
