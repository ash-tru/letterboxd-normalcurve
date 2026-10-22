"""Letterboxd scraper, CSV importer/exporter, and rating curve engine."""

from __future__ import annotations

import bisect
import csv
import http.cookiejar
import io
import json
import math
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from typing import Any, Callable

import lxml.html

MAX_FILMS_LIMIT = 10000
MAX_PAGES_LIMIT = 139  # 139 * 72 = 10,008 films
DEFAULT_STD_DEV = 1.0
DEFAULT_MEAN = 2.75
DEFAULT_BIAS = 0.0
_THREAD_LOCAL = threading.local()

# Slackbot & Discordbot run on AWS (same ASN as Vercel/Render) and are whitelisted
# by Letterboxd's Cloudflare WAF (cf-mitigated: None on all /films/page/N/ & /s/search/ routes).
USER_AGENTS: list[str] = [
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
]

STAR_BUCKETS: list[float] = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]

STAR_LABELS: dict[float, str] = {
    0.5: "½",
    1.0: "★",
    1.5: "★½",
    2.0: "★★",
    2.5: "★★½",
    3.0: "★★★",
    3.5: "★★★½",
    4.0: "★★★★",
    4.5: "★★★★½",
    5.0: "★★★★★",
}

DEFAULT_HEADERS: dict[str, str] = {
    "User-Agent": USER_AGENTS[0],
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass
class FilmEntry:
    """Represents a single movie watched by a Letterboxd user."""

    id: str
    slug: str
    title: str
    year: int | None
    full_title: str
    letterboxd_uri: str
    poster_url: str | None
    original_rating: float | None
    liked: bool
    watched_order: int

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["original_stars"] = format_stars(self.original_rating)
        return data


def format_stars(rating: float | None) -> str:
    """Convert numeric half-star rating (0.5..5.0) to Letterboxd star string."""
    if rating is None:
        return "Unrated"
    rounded = round(float(rating) * 2) / 2.0
    return STAR_LABELS.get(rounded, f"{rounded:.1f}★")


def normalize_username(raw: str) -> str:
    """Extract clean Letterboxd username from raw username or profile URL."""
    cleaned = raw.strip()
    if not cleaned:
        raise ValueError("Please enter a Letterboxd username.")

    if "letterboxd.com/" in cleaned.lower():
        parsed = urllib.parse.urlparse(
            cleaned if "://" in cleaned else f"https://{cleaned}"
        )
        parts = [p for p in parsed.path.split("/") if p]
        if not parts:
            raise ValueError("Could not extract username from Letterboxd URL.")
        cleaned = parts[0]

    cleaned = cleaned.lstrip("@").strip("/").strip()
    if not re.match(r"^[A-Za-z0-9_-]+$", cleaned):
        raise ValueError(
            f"Invalid Letterboxd username '{cleaned}'. Use letters, numbers, underscores, or hyphens."
        )
    return cleaned.lower()


def slugify_title(title: str) -> str:
    """Convert a movie title into a clean Letterboxd-style base slug."""
    normalized = unicodedata.normalize("NFKD", title)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii").lower()
    # Remove apostrophes and middle dots without inserting hyphens (e.g., WALL·E -> walle)
    compact = re.sub(r"['’`·•.]", "", ascii_text)
    return re.sub(r"[^a-z0-9]+", "-", compact).strip("-")


def _build_poster_url(
    film_id: str,
    slug: str,
    cache_key: str,
    has_default_poster: bool = True,
) -> str | None:
    """Construct direct Letterboxd CDN poster URL from film numeric ID and slug."""
    if not has_default_poster or not film_id or not film_id.isdigit() or not slug:
        return None
    digit_path = "/".join(list(film_id))
    url = f"https://a.ltrbxd.com/resized/film-poster/{digit_path}/{film_id}-{slug}-0-150-0-225-crop.jpg"
    if cache_key:
        url = f"{url}?v={cache_key}"
    return url


def resolve_canonical_film_slug(
    base_slug: str,
    year: int | str | None = None,
) -> tuple[str, str | None]:
    """Resolve whether Letterboxd uses '<slug>-<year>' or '<slug>' for a given title and year."""
    clean_slug = base_slug.strip("/").strip()
    if not clean_slug:
        return clean_slug, None

    candidates: list[str] = []
    if year and not re.search(r"-\d{4}(?:-\d+)?$", clean_slug):
        candidates.append(f"{clean_slug}-{year}")
    candidates.append(clean_slug)

    for cand in candidates:
        endpoint = f"https://letterboxd.com/film/{cand}/poster/std/70/"
        try:
            raw_json = _fetch_url_with_retry(
                endpoint,
                base_url="https://letterboxd.com/dave/films/",
                max_retries=2,
                timeout=6.0,
            )
            data = json.loads(raw_json)
            poster = data.get("url2x") or data.get("url")
            if poster and isinstance(poster, str) and poster.startswith("http"):
                return cand, poster
            return cand, None
        except Exception:
            continue

    return clean_slug, None


def resolve_fallback_poster_url(
    slug: str,
    film_id: str = "",
    year: int | str | None = None,
) -> str | None:
    """Resolve the true Letterboxd poster URL when the standard CDN path 403/404s.

    1. If slug ends with -YYYY and numeric film_id is known, checks stripped-year CDN path.
    2. Queries Letterboxd's official LazyPoster JSON endpoint (/film/<slug>/poster/std/70/),
       checking '<slug>-<year>' first if film_id is unknown and year is provided.
    """
    clean_slug = slug.strip("/").strip()
    if not clean_slug:
        return None

    # 1. Fast check: if slug has -YYYY disambiguation suffix and numeric film_id is known, check CDN
    if film_id and film_id.isdigit() and re.search(r"-\d{4}$", clean_slug):
        base_slug = re.sub(r"-\d{4}$", "", clean_slug)
        digit_path = "/".join(list(film_id))
        candidate = (
            f"https://a.ltrbxd.com/resized/film-poster/{digit_path}/"
            f"{film_id}-{base_slug}-0-150-0-225-crop.jpg"
        )
        try:
            req = urllib.request.Request(candidate, method="HEAD", headers=DEFAULT_HEADERS)
            with urllib.request.urlopen(req, timeout=4) as resp:
                if resp.status == 200:
                    return candidate
        except Exception:
            pass

    # 2. Official Letterboxd LazyPoster JSON endpoint
    # If numeric film_id is missing and year is known, try disambiguated '<slug>-<year>' first!
    slug_candidates: list[str] = []
    if year and (not film_id or not film_id.isdigit()) and not re.search(r"-\d{4}(?:-\d+)?$", clean_slug):
        slug_candidates.append(f"{clean_slug}-{year}")
    slug_candidates.append(clean_slug)

    for cand_slug in slug_candidates:
        endpoint = f"https://letterboxd.com/film/{cand_slug}/poster/std/70/"
        try:
            raw_json = _fetch_url_with_retry(
                endpoint,
                base_url="https://letterboxd.com/dave/films/",
                max_retries=3,
                timeout=8.0,
            )
            data = json.loads(raw_json)
            poster = data.get("url2x") or data.get("url")
            if poster and isinstance(poster, str) and poster.startswith("http"):
                return poster
        except Exception:
            continue

    return None


def generate_svg_poster(title: str, year: int | str | None = None) -> str:
    """Generate a styled SVG movie poster placeholder with deterministic color palette."""
    clean_title = (title or "Untitled Film").strip()
    palettes = [
        ("#1e293b", "#0f172a", "#38bdf8"),
        ("#14261c", "#0a140e", "#00e054"),
        ("#2a1b12", "#140c08", "#ff8000"),
        ("#231934", "#110b1a", "#c084fc"),
        ("#291522", "#140910", "#f43f5e"),
        ("#16262c", "#0b1316", "#2dd4bf"),
    ]
    palette_idx = sum(ord(c) for c in clean_title) % len(palettes)
    bg_top, bg_bot, accent = palettes[palette_idx]

    # Wrap title into up to 4 lines (~16 chars per line)
    words = clean_title.split()
    lines: list[str] = []
    current = ""
    for w in words:
        if not current:
            current = w
        elif len(current) + 1 + len(w) <= 16:
            current = f"{current} {w}"
        else:
            lines.append(current)
            current = w
            if len(lines) == 3:
                break
    if current and len(lines) < 4:
        if len(current) > 18:
            current = current[:16] + "…"
        lines.append(current)

    def _esc(s: str) -> str:
        return (
            s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    start_y = 145 - (len(lines) - 1) * 14
    text_Lockup = "\n".join(
        f'<text x="150" y="{start_y + i * 28}" text-anchor="middle" fill="#f1f5f9" '
        f'font-family="Inter, -apple-system, sans-serif" font-size="21" font-weight="700">{_esc(line)}</text>'
        for i, line in enumerate(lines)
    )
    year_str = _esc(str(year)) if year else ""
    year_el = (
        f'<text x="150" y="385" text-anchor="middle" fill="{accent}" '
        f'font-family="Inter, -apple-system, sans-serif" font-size="18" font-weight="700" letter-spacing="2">{year_str}</text>'
        if year_str
        else ""
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450" width="300" height="450">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{bg_top}" />
      <stop offset="100%" stop-color="{bg_bot}" />
    </linearGradient>
  </defs>
  <rect width="300" height="450" fill="url(#bg)" />
  <rect x="12" y="12" width="276" height="426" rx="8" fill="none" stroke="{accent}" stroke-opacity="0.35" stroke-width="2" />
  <circle cx="132" cy="68" r="7" fill="#ff8000" />
  <circle cx="150" cy="68" r="7" fill="#00e054" />
  <circle cx="168" cy="68" r="7" fill="#40bcf4" />
  {text_Lockup}
  {year_el}
</svg>"""


def _extract_title_and_year(full_display_name: str, fallback_name: str) -> tuple[str, int | None]:
    """Split 'Film Title (2024)' into ('Film Title', 2024)."""
    text = (full_display_name or fallback_name or "").strip()
    match = re.match(r"^(.*?)\s*\((\d{4})\)\s*$", text)
    if match:
        title = match.group(1).strip() or text
        return title, int(match.group(2))
    return text, None


def search_letterboxd_films(query: str, limit: int = 6) -> list[dict[str, Any]]:
    """Search Letterboxd for a film by title/year or URL and return matching film dicts."""
    raw = query.strip()
    if not raw:
        return []

    # Check if user pasted a direct Letterboxd film URL (e.g. https://letterboxd.com/film/anora/)
    if "letterboxd.com/film/" in raw.lower():
        slug = raw.lower().split("letterboxd.com/film/")[-1].strip("/").split("/")[0]
        raw = slug.replace("-", " ")

    results: list[dict[str, Any]] = []
    q_enc = urllib.parse.quote(raw)
    search_url = f"https://letterboxd.com/s/search/films/{q_enc}/"

    try:
        html = _fetch_url_with_retry(
            search_url,
            base_url="https://letterboxd.com/",
            max_retries=3,
            timeout=8.0,
        )
        doc = lxml.html.fromstring(html)
        rc_nodes = doc.xpath(
            "//li[contains(@class, 'search-result')]//div[@data-item-slug or @data-film-slug]"
        )
        for rc in rc_nodes[:limit]:
            slug = (rc.get("data-item-slug") or rc.get("data-film-slug") or "").strip()
            if not slug:
                continue
            full_name = (
                rc.get("data-item-full-display-name")
                or rc.get("data-item-name")
                or slug.replace("-", " ").title()
            ).strip()
            title, year = _extract_title_and_year(full_name, full_name)

            film_id = ""
            cache_key = ""
            has_default_poster = True
            resolvable_raw = rc.get("data-resolvable-poster-path")
            if resolvable_raw:
                try:
                    resolvable = json.loads(resolvable_raw)
                    uid = resolvable.get("postered", {}).get("uid", "")
                    if ":" in uid:
                        film_id = uid.split(":")[-1]
                    cache_key = resolvable.get("cacheBustingKey", "") or ""
                    has_default_poster = bool(resolvable.get("hasDefaultPoster", True))
                except (json.JSONDecodeError, TypeError):
                    pass

            poster_url = _build_poster_url(
                film_id=film_id,
                slug=slug,
                cache_key=cache_key,
                has_default_poster=has_default_poster,
            )
            item_link = rc.get("data-item-link") or f"/film/{slug}/"
            letterboxd_uri = (
                f"https://letterboxd.com{item_link}"
                if item_link.startswith("/")
                else item_link
            )
            entry = FilmEntry(
                id=film_id or slug,
                slug=slug,
                title=title,
                year=year,
                full_title=full_name,
                letterboxd_uri=letterboxd_uri,
                poster_url=poster_url,
                original_rating=None,
                liked=False,
                watched_order=0,
            ).to_dict()
            results.append(entry)
    except Exception:
        pass

    if not results:
        title, year = _extract_title_and_year(raw, raw)
        slug = slugify_title(title) or "new-film"
        resolved_slug, resolved_poster = resolve_canonical_film_slug(slug, year)
        full_title = f"{title} ({year})" if year else title
        results.append(
            FilmEntry(
                id=resolved_slug,
                slug=resolved_slug,
                title=title,
                year=year,
                full_title=full_title,
                letterboxd_uri=f"https://letterboxd.com/film/{resolved_slug}/",
                poster_url=resolved_poster,
                original_rating=None,
                liked=False,
                watched_order=0,
            ).to_dict()
        )

    return results


def parse_films_page_html(html: str, start_order: int = 1) -> tuple[list[FilmEntry], dict[str, Any]]:
    """Parse a Letterboxd /<user>/films/ HTML page into FilmEntry items and metadata."""
    doc = lxml.html.fromstring(html)

    # Extract page metadata (only needed on page 1, cheap everywhere)
    title_texts = doc.xpath("//title/text()")
    raw_page_title = title_texts[0].strip() if title_texts else ""
    display_name = raw_page_title.replace("\u200e", "").split("’s films")[0].split("'s films")[0].strip()

    avatars = doc.xpath(
        "//span[contains(@class, 'avatar')]//img/@src | //a[contains(@class, 'avatar')]//img/@src"
    )
    avatar_url = avatars[0] if avatars else None

    # Total films count from heading tooltip or sub-nav
    tooltip_titles = doc.xpath(
        "//h1[contains(@class, 'section-heading')]//span[contains(@class, 'tooltip')]/@title"
    )
    total_films_hint = None
    if tooltip_titles:
        nums = re.findall(r"[\d,]+", tooltip_titles[0])
        if nums:
            total_films_hint = int(nums[0].replace(",", ""))

    page_links = doc.xpath("//div[contains(@class, 'paginate-pages')]//li//a/text()")
    total_pages = 1
    for p_txt in page_links:
        p_clean = p_txt.strip().replace(",", "")
        if p_clean.isdigit():
            total_pages = max(total_pages, int(p_clean))

    items = doc.xpath("//li[contains(@class, 'griditem') or contains(@class, 'poster-container')]")
    films: list[FilmEntry] = []

    for idx, item in enumerate(items):
        rc_list = item.xpath(".//div[contains(@class, 'react-component') or @data-item-slug or @data-film-slug]")
        if not rc_list:
            continue
        rc = rc_list[0]

        slug = (rc.get("data-item-slug") or rc.get("data-film-slug") or "").strip()
        if not slug:
            continue

        full_name = (
            rc.get("data-item-full-display-name")
            or rc.get("data-item-name")
            or rc.get("data-film-name")
            or slug.replace("-", " ").title()
        ).strip()
        img_alts = item.xpath(".//img/@alt")
        fallback_title = img_alts[0].strip() if img_alts else full_name
        title, year = _extract_title_and_year(full_name, fallback_title)

        # Extract film numeric ID & poster key
        film_id = ""
        cache_key = ""
        has_default_poster = True

        resolvable_raw = rc.get("data-resolvable-poster-path")
        if resolvable_raw:
            try:
                resolvable = json.loads(resolvable_raw)
                uid = resolvable.get("postered", {}).get("uid", "")
                if ":" in uid:
                    film_id = uid.split(":")[-1]
                cache_key = resolvable.get("cacheBustingKey", "") or ""
                has_default_poster = bool(resolvable.get("hasDefaultPoster", True))
            except (json.JSONDecodeError, TypeError):
                pass

        if not film_id:
            ident_raw = rc.get("data-postered-identifier")
            if ident_raw:
                try:
                    ident = json.loads(ident_raw)
                    uid = ident.get("uid", "")
                    if ":" in uid:
                        film_id = uid.split(":")[-1]
                except (json.JSONDecodeError, TypeError):
                    pass

        if not film_id:
            uid_els = item.xpath(".//@data-item-uid")
            if uid_els and ":" in uid_els[0]:
                film_id = uid_els[0].split(":")[-1]

        poster_url = _build_poster_url(
            film_id=film_id,
            slug=slug,
            cache_key=cache_key,
            has_default_poster=has_default_poster,
        )

        # Extract rating (rated-1 .. rated-10 -> 0.5 .. 5.0)
        original_rating: float | None = None
        rating_spans = item.xpath(".//span[contains(@class, 'rated-')]")
        if rating_spans:
            cls_attr = rating_spans[0].get("class", "")
            m_rate = re.search(r"rated-(\d+)", cls_attr)
            if m_rate:
                val = int(m_rate.group(1))
                if 1 <= val <= 10:
                    original_rating = val / 2.0

        # Extract liked status
        liked = bool(item.xpath(".//span[contains(@class, 'like') and contains(@class, 'icon-liked')]"))

        item_link = rc.get("data-item-link") or rc.get("data-target-link") or f"/film/{slug}/"
        letterboxd_uri = f"https://letterboxd.com{item_link}" if item_link.startswith("/") else item_link

        films.append(
            FilmEntry(
                id=film_id or slug,
                slug=slug,
                title=title,
                year=year,
                full_title=full_name,
                letterboxd_uri=letterboxd_uri,
                poster_url=poster_url,
                original_rating=original_rating,
                liked=liked,
                watched_order=start_order + idx,
            )
        )

    meta = {
        "display_name": display_name,
        "avatar_url": avatar_url,
        "total_films_hint": total_films_hint,
        "total_pages": total_pages,
    }
    return films, meta


def _get_thread_opener() -> tuple[http.cookiejar.CookieJar, urllib.request.OpenerDirector]:
    """Return a reusable per-thread CookieJar and OpenerDirector."""
    if not hasattr(_THREAD_LOCAL, "cj") or not hasattr(_THREAD_LOCAL, "opener"):
        cj = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        _THREAD_LOCAL.cj = cj
        _THREAD_LOCAL.opener = opener
    return _THREAD_LOCAL.cj, _THREAD_LOCAL.opener


def _fetch_url_with_retry(
    url: str,
    base_url: str,
    max_retries: int = 5,
    timeout: float = 12.0,
) -> str:
    """Fetch a Letterboxd URL using AWS-whitelisted link-expanding User-Agents."""
    cj, opener = _get_thread_opener()
    last_err: Exception | None = None

    for attempt in range(max_retries):
        ua = USER_AGENTS[attempt % len(USER_AGENTS)]
        headers = {
            **DEFAULT_HEADERS,
            "User-Agent": ua,
            "Referer": base_url,
        }
        try:
            req = urllib.request.Request(url, headers=headers)
            with opener.open(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
                if "<title>Just a moment...</title>" not in text:
                    return text
                last_err = RuntimeError("Cloudflare challenge page returned")
                cj.clear()
                time.sleep(0.25 * (attempt + 1))
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code == 404:
                raise ValueError(
                    "Letterboxd user not found (404). Check the username and ensure the profile is public."
                ) from exc
            if exc.code in (403, 429, 500, 502, 503, 504):
                cj.clear()
                time.sleep(0.25 * (attempt + 1))
                continue
            raise
        except Exception as exc:
            last_err = exc
            cj.clear()
            time.sleep(0.25 * (attempt + 1))

    raise RuntimeError(f"Failed to fetch {url} after {max_retries} attempts: {last_err}")


def fetch_user_watched_films(
    username: str,
    max_pages: int | None = None,
    max_films: int = MAX_FILMS_LIMIT,
    on_progress: Callable[[int, int, int], None] | None = None,
) -> dict[str, Any]:
    """Fetch all watched films for any public Letterboxd username."""
    clean_user = normalize_username(username)
    base_url = f"https://letterboxd.com/{clean_user}/films/"

    page1_html = _fetch_url_with_retry(base_url, base_url=base_url)
    page1_films, meta = parse_films_page_html(page1_html, start_order=1)

    total_pages = min(meta["total_pages"], MAX_PAGES_LIMIT)
    if max_pages is not None and max_pages > 0:
        total_pages = min(total_pages, max_pages)

    if on_progress:
        on_progress(1, total_pages, len(page1_films))

    pages_films: dict[int, list[FilmEntry]] = {1: page1_films}

    if total_pages > 1:
        completed_pages = 1
        total_loaded = len(page1_films)

        def _fetch_single_page(page_num: int) -> tuple[int, list[FilmEntry]]:
            page_url = f"https://letterboxd.com/{clean_user}/films/page/{page_num}/"
            html = _fetch_url_with_retry(page_url, base_url=base_url)
            films, _ = parse_films_page_html(html, start_order=(page_num - 1) * 72 + 1)
            return page_num, films

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {
                pool.submit(_fetch_single_page, p): p
                for p in range(2, total_pages + 1)
            }
            for fut in as_completed(futures):
                p_num, p_films = fut.result()
                pages_films[p_num] = p_films
                completed_pages += 1
                total_loaded += len(p_films)
                if on_progress:
                    on_progress(completed_pages, total_pages, min(total_loaded, max_films))

    all_films: list[FilmEntry] = []
    seen_slugs: set[str] = set()
    for p_num in sorted(pages_films.keys()):
        for film in pages_films[p_num]:
            if film.slug not in seen_slugs:
                seen_slugs.add(film.slug)
                film.watched_order = len(all_films) + 1
                all_films.append(film)
                if len(all_films) >= max_films:
                    break
        if len(all_films) >= max_films:
            break

    rated_count = sum(1 for f in all_films if f.original_rating is not None)
    unrated_count = len(all_films) - rated_count

    return {
        "username": clean_user,
        "display_name": meta["display_name"] or clean_user,
        "avatar_url": meta["avatar_url"],
        "profile_url": f"https://letterboxd.com/{clean_user}/",
        "total_pages_fetched": total_pages,
        "total_pages_available": meta["total_pages"],
        "total_films": len(all_films),
        "rated_films_count": rated_count,
        "unrated_films_count": unrated_count,
        "films": [f.to_dict() for f in all_films],
    }


def sort_films_by_rating(
    films: list[dict[str, Any]],
    include_unrated: bool = True,
) -> list[dict[str, Any]]:
    """Sort films by original Letterboxd rating descending (then liked, then watched_order)."""
    filtered = [
        dict(f)
        for f in films
        if include_unrated or f.get("original_rating") is not None
    ]

    def _sort_key(item: dict[str, Any]) -> tuple[int, float, int, int]:
        rating = item.get("original_rating")
        has_rating = 1 if rating is not None else 0
        rating_val = float(rating) if rating is not None else -1.0
        liked_val = 1 if item.get("liked") else 0
        watched_order = int(item.get("watched_order") or 999999)
        return (-has_rating, -rating_val, -liked_val, watched_order)

    sorted_list = sorted(filtered, key=_sort_key)
    for idx, film in enumerate(sorted_list, start=1):
        film["initial_rating_rank"] = idx
    return sorted_list


# ---------------------------------------------------------------------------
# Preference-Weighted Normal Distribution & Rating Assignment Engine
# ---------------------------------------------------------------------------

def _norm_ppf(p: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation, accurate to ~1e-9)."""
    p = max(1e-6, min(1.0 - 1e-6, p))

    a = [
        -3.969683028665376e01,
        2.209460984245205e02,
        -2.759285104469687e02,
        1.383577518672690e02,
        -3.066479806614716e01,
        2.506628277459239e00,
    ]
    b = [
        -5.447609879822406e01,
        1.615858368580409e02,
        -1.556989798598866e02,
        6.680131188771972e01,
        -1.328068155288572e01,
    ]
    c = [
        -7.784894002430293e-03,
        -3.223964580411365e-01,
        -2.400758277161838e00,
        -2.549732539343734e00,
        4.374664141464968e00,
        2.938163982698783e00,
    ]
    d = [
        7.784695709041462e-03,
        3.224671290700398e-01,
        2.445134137142996e00,
        3.754408661907416e00,
    ]

    p_low = 0.02425
    p_high = 1.0 - p_low

    if p < p_low:
        q = math.sqrt(-2.0 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    if p <= p_high:
        q = p - 0.5
        r = q * q
        return (
            (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        ) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)

    q = math.sqrt(-2.0 * math.log(1.0 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
        (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
    )


def validate_curve_settings(mean: float, bias: float, std_dev: float) -> None:
    if not all(math.isfinite(value) for value in (mean, bias, std_dev)):
        raise ValueError("Center, good-movie bias and spread must be finite numbers.")
    if not (2.0 <= mean <= 3.5 and 0.0 <= bias <= 3.0 and 0.55 <= std_dev <= 1.6):
        raise ValueError("Center must be 2–3.5, bias 0–3 and spread 0.55–1.6.")


def _curve_weight(rating: float, mean: float, bias: float, std_dev: float) -> float:
    gaussian = math.exp(-0.5 * ((rating - mean) / std_dev) ** 2)
    if bias == 0:
        return gaussian
    return gaussian / (1 + math.exp(-bias * (rating - mean)))


def _weighted_quantile_grid(mean: float, bias: float, std_dev: float) -> tuple[float, float, list[float]]:
    start = mean - 8 * std_dev
    step = 16 * std_dev / 1024
    cdf = [0.0]
    previous = _curve_weight(start, mean, bias, std_dev)
    for i in range(1, 1025):
        current = _curve_weight(start + i * step, mean, bias, std_dev)
        cdf.append(cdf[-1] + (previous + current) * step / 2)
        previous = current
    return start, step, cdf


def _weighted_ppf(grid: tuple[float, float, list[float]], quantile: float) -> float:
    start, step, cdf = grid
    target = quantile * cdf[-1]
    index = max(0, min(bisect.bisect_left(cdf, target) - 1, len(cdf) - 2))
    fraction = (target - cdf[index]) / (cdf[index + 1] - cdf[index])
    return start + (index + fraction) * step


def compute_bucket_probabilities(
    mean: float = DEFAULT_MEAN,
    bias: float = DEFAULT_BIAS,
    std_dev: float = DEFAULT_STD_DEV,
) -> dict[float, float]:
    """Weight the ten star buckets by normal density and preference for higher ratings."""
    validate_curve_settings(mean, bias, std_dev)
    weights = {rating: _curve_weight(rating, mean, bias, std_dev) for rating in STAR_BUCKETS}
    total = sum(weights.values())
    return {rating: weight / total for rating, weight in weights.items()}


def allocate_bucket_counts(
    total_count: int,
    mean: float = DEFAULT_MEAN,
    bias: float = DEFAULT_BIAS,
    std_dev: float = DEFAULT_STD_DEV,
) -> dict[float, int]:
    """Allocate integer movie counts across 0.5..5.0 star buckets summing to total_count.

    At the unbiased default center, pairs are allocated symmetrically.
    """
    if total_count <= 0:
        return {b: 0 for b in STAR_BUCKETS}

    probs = compute_bucket_probabilities(mean=mean, bias=bias, std_dev=std_dev)

    if bias == 0 and abs(mean - DEFAULT_MEAN) < 1e-9:
        pairs = [(0.5, 5.0), (1.0, 4.5), (1.5, 4.0), (2.0, 3.5), (2.5, 3.0)]
        pair_quotas = [probs[lo] * total_count for lo, _ in pairs]
        pair_floors = [int(math.floor(q)) for q in pair_quotas]
        counts: dict[float, int] = {}
        for (lo, hi), fl in zip(pairs, pair_floors):
            counts[lo] = fl
            counts[hi] = fl

        remaining = total_count - sum(counts.values())
        # Rank pairs by fractional remainder, preferring inner pairs on exact ties
        remainders = sorted(
            range(len(pairs)),
            key=lambda i: (pair_quotas[i] - pair_floors[i], i),
            reverse=True,
        )
        for idx in remainders:
            if remaining >= 2:
                lo, hi = pairs[idx]
                counts[lo] += 1
                counts[hi] += 1
                remaining -= 2

        if remaining == 1:
            # Place single odd middle film in 3.0★
            counts[3.0] += 1
        return {b: counts[b] for b in STAR_BUCKETS}

    # General Largest Remainder (Hamilton) allocation
    quotas = {b: probs[b] * total_count for b in STAR_BUCKETS}
    floors = {b: int(math.floor(quotas[b])) for b in STAR_BUCKETS}
    remainder = total_count - sum(floors.values())

    ranked_buckets = sorted(
        STAR_BUCKETS,
        key=lambda b: (quotas[b] - floors[b], -abs(b - mean)),
        reverse=True,
    )
    for b in ranked_buckets[:remainder]:
        floors[b] += 1

    return floors


def compute_normal_curve_assignments(
    sorted_films: list[dict[str, Any]],
    mean: float = DEFAULT_MEAN,
    bias: float = DEFAULT_BIAS,
    std_dev: float = DEFAULT_STD_DEV,
) -> dict[str, Any]:
    """Assign each film in final user-sorted order to its 0.5..5.0★ target tier."""
    n = len(sorted_films)
    probs = compute_bucket_probabilities(mean=mean, bias=bias, std_dev=std_dev)
    bucket_counts = allocate_bucket_counts(n, mean=mean, bias=bias, std_dev=std_dev)
    grid = _weighted_quantile_grid(mean, bias, std_dev) if bias else None

    # Expand buckets from highest (5.0) down to lowest (0.5) to match rank 1..N (best to worst)
    tier_sequence: list[float] = []
    for b in sorted(STAR_BUCKETS, reverse=True):
        tier_sequence.extend([b] * bucket_counts[b])

    orig_dist: dict[str, int] = {f"{b:.1f}": 0 for b in STAR_BUCKETS}
    normal_dist: dict[str, int] = {f"{b:.1f}": bucket_counts[b] for b in STAR_BUCKETS}

    upgraded_count = 0
    downgraded_count = 0
    unchanged_count = 0
    unrated_count = 0

    orig_ratings_list: list[float] = []
    normal_ratings_list: list[float] = []

    enriched_films: list[dict[str, Any]] = []
    for idx, film in enumerate(sorted_films):
        rank = idx + 1
        normal_rating = tier_sequence[idx] if idx < len(tier_sequence) else 0.5
        normal_ratings_list.append(normal_rating)

        # Midpoint quantile from bottom (0) to top (1)
        quantile = (n - rank + 0.5) / n if n > 0 else 0.5
        z_score = _norm_ppf(quantile)
        raw_continuous = max(0.5, min(5.0, (
            _weighted_ppf(grid, quantile) if grid else mean + z_score * std_dev
        )))
        percentile = round(((n - rank) / max(n - 1, 1)) * 100.0, 1) if n > 1 else 100.0

        orig = film.get("original_rating")
        if orig is not None:
            orig_f = float(orig)
            orig_ratings_list.append(orig_f)
            key = f"{orig_f:.1f}"
            if key in orig_dist:
                orig_dist[key] += 1
            delta = round(normal_rating - orig_f, 1)
            if delta > 0:
                upgraded_count += 1
                delta_status = "upgraded"
            elif delta < 0:
                downgraded_count += 1
                delta_status = "downgraded"
            else:
                unchanged_count += 1
                delta_status = "unchanged"
        else:
            delta = None
            unrated_count += 1
            delta_status = "unrated"

        item = dict(film)
        item.update(
            {
                "final_rank": rank,
                "percentile": percentile,
                "z_score": round(z_score, 2),
                "continuous_normal_score": round(raw_continuous, 2),
                "normal_rating": normal_rating,
                "normal_stars": format_stars(normal_rating),
                "original_stars": format_stars(orig),
                "rating_delta": delta,
                "delta_status": delta_status,
            }
        )
        enriched_films.append(item)

    mean_orig = round(sum(orig_ratings_list) / len(orig_ratings_list), 2) if orig_ratings_list else None
    mean_normal = round(sum(normal_ratings_list) / len(normal_ratings_list), 2) if normal_ratings_list else None

    std_orig = (
        round(
            math.sqrt(sum((x - mean_orig) ** 2 for x in orig_ratings_list) / len(orig_ratings_list)),
            2,
        )
        if orig_ratings_list and mean_orig is not None
        else None
    )
    std_normal = (
        round(
            math.sqrt(sum((x - mean_normal) ** 2 for x in normal_ratings_list) / len(normal_ratings_list)),
            2,
        )
        if normal_ratings_list and mean_normal is not None
        else None
    )

    buckets_summary = []
    for b in STAR_BUCKETS:
        b_key = f"{b:.1f}"
        buckets_summary.append(
            {
                "rating": b,
                "label": STAR_LABELS[b],
                "probability_pct": round(probs[b] * 100.0, 2),
                "original_count": orig_dist[b_key],
                "normal_count": normal_dist[b_key],
            }
        )

    return {
        "total_films": n,
        "parameters": {"mean": mean, "bias": bias, "std_dev": std_dev},
        "stats": {
            "mean_original": mean_orig,
            "mean_normal": mean_normal,
            "std_original": std_orig,
            "std_normal": std_normal,
            "rating_inflation": round((mean_orig - mean_normal), 2)
            if (mean_orig is not None and mean_normal is not None)
            else None,
            "upgraded_count": upgraded_count,
            "downgraded_count": downgraded_count,
            "unchanged_count": unchanged_count,
            "unrated_count": unrated_count,
        },
        "buckets": buckets_summary,
        "films": enriched_films,
    }


def parse_letterboxd_csv(
    csv_content: str,
    username: str = "csv_import",
    resolve_remote: bool = False,
) -> dict[str, Any]:
    """Parse a Letterboxd ratings.csv, watched.csv, or exported rating-curve CSV."""
    reader = csv.DictReader(io.StringIO(csv_content))
    films: list[FilmEntry] = []

    for idx, row in enumerate(reader, start=1):
        name = (row.get("Name") or row.get("Title") or "").strip()
        if not name:
            continue
        year_raw = (row.get("Year") or "").strip()
        year = int(year_raw) if year_raw.isdigit() else None

        uri = (
            row.get("Letterboxd URI")
            or row.get("LetterboxdURI")
            or row.get("URI")
            or row.get("URL")
            or ""
        ).strip()
        explicit_slug = (row.get("Slug") or "").strip()
        film_id = (row.get("FilmID") or "").strip()
        poster_url = (row.get("PosterURL") or "").strip() or None

        if explicit_slug:
            slug = explicit_slug
        elif "/film/" in uri:
            slug = uri.split("/film/")[-1].strip("/").split("/")[0]
        else:
            slug = slugify_title(name)

        if not uri or "boxd.it/" in uri or "/film/" not in uri:
            uri = f"https://letterboxd.com/film/{slug}/"

        rating_raw = (
            row.get("OriginalRating")
            if row.get("OriginalRating") not in (None, "")
            else (row.get("Rating") or "")
        ).strip()
        rating: float | None = None
        if rating_raw:
            try:
                val = float(rating_raw)
                if 0.5 <= val <= 5.0:
                    rating = round(val * 2) / 2.0
            except ValueError:
                pass

        full_title = f"{name} ({year})" if year else name
        films.append(
            FilmEntry(
                id=film_id or slug,
                slug=slug,
                title=name,
                year=year,
                full_title=full_title,
                letterboxd_uri=uri,
                poster_url=poster_url,
                original_rating=rating,
                liked=str(row.get("Liked") or "").lower() in ("true", "1", "yes"),
                watched_order=idx,
            )
        )

    # Optionally enrich against the user's real Letterboxd profile if available
    if resolve_remote and films:
        live_by_title_year: dict[tuple[str, int | None], dict[str, Any]] = {}
        live_by_title: dict[str, dict[str, Any]] = {}
        if username and username != "csv_import":
            try:
                live_profile = fetch_user_watched_films(username)
                for lf in live_profile.get("films", []):
                    live_by_title_year[(lf["title"].lower(), lf.get("year"))] = lf
                    live_by_title[lf["title"].lower()] = lf
            except Exception:
                pass

        for f in films:
            matched = live_by_title_year.get((f.title.lower(), f.year)) or live_by_title.get(
                f.title.lower()
            )
            if matched:
                f.id = matched["id"]
                f.slug = matched["slug"]
                f.letterboxd_uri = matched["letterboxd_uri"]
                f.poster_url = matched.get("poster_url")
                f.liked = bool(matched.get("liked", f.liked))
            elif f.year and not f.id.isdigit():
                resolved_slug, resolved_poster = resolve_canonical_film_slug(f.slug, f.year)
                f.slug = resolved_slug
                f.id = resolved_slug
                f.letterboxd_uri = f"https://letterboxd.com/film/{resolved_slug}/"
                if resolved_poster:
                    f.poster_url = resolved_poster

    rated_count = sum(1 for f in films if f.original_rating is not None)
    return {
        "username": username,
        "display_name": username,
        "avatar_url": None,
        "profile_url": f"https://letterboxd.com/{username}/",
        "total_pages_fetched": 1,
        "total_pages_available": 1,
        "total_films": len(films),
        "rated_films_count": rated_count,
        "unrated_films_count": len(films) - rated_count,
        "films": [f.to_dict() for f in films],
    }


def export_normal_curve_csv(enriched_films: list[dict[str, Any]]) -> str:
    """Export target-curve ratings with the existing Letterboxd-compatible CSV columns."""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "Title",
            "Year",
            "Letterboxd URI",
            "Rating",
            "OriginalRating",
            "RatingDelta",
            "FinalRank",
            "Percentile",
            "ZScore",
            "ContinuousNormalScore",
            "Slug",
            "FilmID",
            "PosterURL",
        ]
    )
    for film in enriched_films:
        writer.writerow(
            [
                film.get("title", ""),
                film.get("year") or "",
                film.get("letterboxd_uri", ""),
                film.get("normal_rating", ""),
                film.get("original_rating") if film.get("original_rating") is not None else "",
                film.get("rating_delta") if film.get("rating_delta") is not None else "",
                film.get("final_rank", ""),
                film.get("percentile", ""),
                film.get("z_score", ""),
                film.get("continuous_normal_score", ""),
                film.get("slug", ""),
                film.get("id", ""),
                film.get("poster_url") or "",
            ]
        )
    return output.getvalue()
