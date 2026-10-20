"""Unit and integration tests for the Letterboxd Bell-Curve Ranker (eggs/ltrbx)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from letterboxd import (
    STAR_BUCKETS,
    allocate_bucket_counts,
    compute_bell_curve_assignments,
    compute_bucket_probabilities,
    export_bell_curve_csv,
    format_stars,
    normalize_username,
    parse_films_page_html,
    parse_letterboxd_csv,
    slugify_title,
    sort_films_by_rating,
)


def test_normalize_username() -> None:
    assert normalize_username("dave") == "dave"
    assert normalize_username("@Dave") == "dave"
    assert normalize_username("https://letterboxd.com/karsten/films/") == "karsten"
    assert normalize_username("letterboxd.com/test_user-1/") == "test_user-1"


def test_parse_films_page_html() -> None:
    sample_html = """
    <html>
      <head><title>Jane Doe’s films • Letterboxd</title></head>
      <body>
        <h1 class="section-heading"><span class="tooltip" title="142 films">Watched</span></h1>
        <div class="paginate-pages"><ul><li><a href="/jane/films/page/2/">2</a></li></ul></div>
        <ul>
          <li class="griditem">
            <div class="react-component"
                 data-item-name="Parasite (2019)"
                 data-item-full-display-name="Parasite (2019)"
                 data-item-slug="parasite-2019"
                 data-item-link="/film/parasite-2019/"
                 data-resolvable-poster-path='{"postered":{"uid":"film:426406"},"hasDefaultPoster":true,"cacheBustingKey":"abc12345"}'>
              <img alt="Parasite" />
            </div>
            <p class="poster-viewingdata">
              <span class="rating -micro -darker rated-10">★★★★★</span>
              <span class="like liked-micro has-icon icon-liked icon-16"></span>
            </p>
          </li>
          <li class="griditem">
            <div class="react-component"
                 data-item-name="Primer (2004)"
                 data-item-full-display-name="Primer (2004)"
                 data-item-slug="primer"
                 data-item-link="/film/primer/">
              <img alt="Primer" />
            </div>
            <p class="poster-viewingdata"></p>
          </li>
        </ul>
      </body>
    </html>
    """
    films, meta = parse_films_page_html(sample_html)
    assert meta["display_name"] == "Jane Doe"
    assert meta["total_films_hint"] == 142
    assert meta["total_pages"] == 2
    assert len(films) == 2

    assert films[0].title == "Parasite"
    assert films[0].year == 2019
    assert films[0].original_rating == 5.0
    assert films[0].liked is True
    assert films[0].poster_url == (
        "https://a.ltrbxd.com/resized/film-poster/4/2/6/4/0/6/426406-parasite-2019-0-150-0-225-crop.jpg?v=abc12345"
    )

    assert films[1].title == "Primer"
    assert films[1].year == 2004
    assert films[1].original_rating is None
    assert films[1].liked is False


def test_sort_films_by_rating_and_symmetric_bell_curve() -> None:
    raw_films = [
        {
            "id": str(i),
            "slug": f"film-{i}",
            "title": f"Film {i}",
            "year": 2020,
            "full_title": f"Film {i} (2020)",
            "letterboxd_uri": f"https://letterboxd.com/film/film-{i}/",
            "poster_url": None,
            "original_rating": 4.0 if i <= 50 else (5.0 if i <= 75 else 3.0),
            "liked": (i % 2 == 0),
            "watched_order": i,
        }
        for i in range(1, 101)
    ]

    sorted_by_rating = sort_films_by_rating(raw_films, include_unrated=True)
    # 5.0★ films must appear first, then 4.0★, then 3.0★
    assert sorted_by_rating[0]["original_rating"] == 5.0
    assert sorted_by_rating[24]["original_rating"] == 5.0
    assert sorted_by_rating[25]["original_rating"] == 4.0
    assert sorted_by_rating[-1]["original_rating"] == 3.0

    # Symmetric bell curve allocation for N=100 at mean=2.75, std_dev=1.0
    counts = allocate_bucket_counts(100, mean=2.75, std_dev=1.0)
    assert sum(counts.values()) == 100
    assert counts[0.5] == counts[5.0]
    assert counts[1.0] == counts[4.5]
    assert counts[1.5] == counts[4.0]
    assert counts[2.0] == counts[3.5]
    assert counts[2.5] == counts[3.0]
    # Peak is at 2.5★ and 3.0★, tails at 0.5★ and 5.0★
    assert counts[3.0] > counts[4.0] > counts[4.5] > counts[5.0] > 0

    bell = compute_bell_curve_assignments(sorted_by_rating, mean=2.75, std_dev=1.0)
    assert bell["total_films"] == 100
    assert bell["films"][0]["final_rank"] == 1
    assert bell["films"][0]["bell_rating"] == 5.0
    assert bell["films"][-1]["final_rank"] == 100
    assert bell["films"][-1]["bell_rating"] == 0.5
    assert bell["stats"]["mean_bell"] == 2.75


def test_csv_import_and_export() -> None:
    csv_input = """Date,Name,Year,Letterboxd URI,Rating
2025-01-01,Mulholland Drive,2001,https://boxd.it/297o,5
2025-01-02,In the Mood for Love,2000,https://boxd.it/29tE,4.5
2025-01-03,Mystery Film,2022,https://boxd.it/xxxx,
"""
    parsed = parse_letterboxd_csv(csv_input, username="cinephile")
    assert parsed["total_films"] == 3
    assert parsed["rated_films_count"] == 2
    assert parsed["unrated_films_count"] == 1

    sorted_films = sort_films_by_rating(parsed["films"], include_unrated=True)
    bell = compute_bell_curve_assignments(sorted_films)
    exported = export_bell_curve_csv(bell["films"])
    assert "Mulholland Drive" in exported
    assert "In the Mood for Love" in exported
    assert "ContinuousBellScore" in exported
    assert format_stars(4.5) == "★★★★½"
    assert len(compute_bucket_probabilities()) == len(STAR_BUCKETS)

    # Verify slugify_title and exported CSV round-trip preserve exact year-disambiguated slugs
    assert slugify_title("WALL·E") == "walle"
    assert slugify_title("Amélie") == "amelie"
    assert slugify_title("Shōgun") == "shogun"

    bell["films"][0]["slug"] = "parasite-2019"
    bell["films"][0]["id"] = "426406"
    bell["films"][0]["letterboxd_uri"] = "https://letterboxd.com/film/parasite-2019/"
    round_trip_csv = export_bell_curve_csv(bell["films"])
    reimported = parse_letterboxd_csv(round_trip_csv, username="cinephile")
    assert reimported["films"][0]["slug"] == "parasite-2019"
    assert reimported["films"][0]["id"] == "426406"
    assert reimported["films"][0]["letterboxd_uri"] == "https://letterboxd.com/film/parasite-2019/"


def test_bell_curve_10000_movies() -> None:
    films_10000 = [
        {
            "id": str(i),
            "slug": f"movie-{i}",
            "title": f"Movie {i}",
            "year": 2000 + (i % 26),
            "full_title": f"Movie {i}",
            "letterboxd_uri": f"https://letterboxd.com/film/movie-{i}/",
            "poster_url": None,
            "original_rating": ((i % 10) + 1) / 2.0,
            "liked": False,
            "watched_order": i,
        }
        for i in range(1, 10001)
    ]
    sorted_10000 = sort_films_by_rating(films_10000, include_unrated=True)
    bell_10000 = compute_bell_curve_assignments(sorted_10000, mean=2.75, std_dev=1.0)
    assert bell_10000["total_films"] == 10000
    assert bell_10000["films"][0]["final_rank"] == 1
    assert bell_10000["films"][-1]["final_rank"] == 10000
    assert sum(b["bell_count"] for b in bell_10000["buckets"]) == 10000
    assert bell_10000["stats"]["mean_bell"] == 2.75


