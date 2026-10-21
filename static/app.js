/* LTRBX // Letterboxd Bell-Curve Ranker Frontend */

const STAR_BUCKETS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
const STAR_LABELS = {
  "0.5": "½",
  "1.0": "★",
  "1.5": "★½",
  "2.0": "★★",
  "2.5": "★★½",
  "3.0": "★★★",
  "3.5": "★★★½",
  "4.0": "★★★★",
  "4.5": "★★★★½",
  "5.0": "★★★★★",
};

const state = {
  session: null,
  appMode: "add", // "add" (default) | "full"
  activeStep: "step2",
  sortMode: "list", // "list" | "battle" | "tournament"
  tournament: null,
  tournamentApplied: null,
  step2Tier: "all",
  step3Search: "",
  step3Bucket: "all",
  step3OnlyChanged: false,
  step2RenderLimit: 300,
  step3RenderLimit: 300,
  dragSlug: null,
  saveTimer: null,
  // Single-film binary search state (inside Full List Mode)
  battle: {
    leftSlug: null,
    rightSlug: null,
    binaryState: null, // { targetSlug, low, high, mid, step, maxSteps }
    history: [],
    lastPlacedMessage: null,
  },
  // Default Add Movie Mode state
  addMovie: {
    candidates: [],
    selectedCandidate: null,
    skipProfileSetup: false,
    binary: null, // { film, others, low, high, mid, step, maxSteps, history, preInsertBellBySlug }
    result: null, // { film, finalRank, totalAfter, bellRating, bellStars, boundaryAdjustments, preexistingAdjustments }
    showAllPreexisting: false,
  },
};

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatStars(rating) {
  if (rating === null || rating === undefined || rating === "") return "Unrated";
  const key = Number(rating).toFixed(1);
  return STAR_LABELS[key] || `${key}★`;
}

function formatDeltaBadge(delta, origRating) {
  if (origRating === null || origRating === undefined) {
    return `<span class="delta-pill delta-same">NEW</span>`;
  }
  const d = Number(delta || 0);
  if (d > 0.01) {
    return `<span class="delta-pill delta-up">+${d.toFixed(1)}★</span>`;
  }
  if (d < -0.01) {
    return `<span class="delta-pill delta-down">${d.toFixed(1)}★</span>`;
  }
  return `<span class="delta-pill delta-same">&mdash;</span>`;
}

// Acklam inverse standard normal CDF for client-side instant recalculation
function normPpf(p) {
  const clamped = Math.max(1e-6, Math.min(1 - 1e-6, p));
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687,
    138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (clamped < pLow) {
    const q = Math.sqrt(-2 * Math.log(clamped));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (clamped <= pHigh) {
    const q = clamped - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - clamped));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

function recomputeBellCurveClientSide() {
  if (!state.session || !state.session.bell_curve) return;
  const films = state.session.bell_curve.films || [];
  const n = films.length;
  const mean = Number(state.session.settings.mean || 2.75);
  const stdDev = Number(state.session.settings.std_dev || 1.0);

  // Compute Gaussian bucket weights
  const weights = {};
  let totalW = 0;
  for (const b of STAR_BUCKETS) {
    const w = Math.exp(-0.5 * Math.pow((b - mean) / stdDev, 2));
    weights[b.toFixed(1)] = w;
    totalW += w;
  }
  const probs = {};
  for (const b of STAR_BUCKETS) {
    probs[b.toFixed(1)] = totalW > 0 ? weights[b.toFixed(1)] / totalW : 0.1;
  }

  // Allocate integer counts across 10 buckets
  const counts = {};
  if (n === 0) {
    for (const b of STAR_BUCKETS) counts[b.toFixed(1)] = 0;
  } else if (Math.abs(mean - 2.75) < 1e-6) {
    const pairs = [
      [0.5, 5.0],
      [1.0, 4.5],
      [1.5, 4.0],
      [2.0, 3.5],
      [2.5, 3.0],
    ];
    const quotas = pairs.map(([lo]) => probs[lo.toFixed(1)] * n);
    const floors = quotas.map((q) => Math.floor(q));
    let used = 0;
    pairs.forEach(([lo, hi], i) => {
      counts[lo.toFixed(1)] = floors[i];
      counts[hi.toFixed(1)] = floors[i];
      used += floors[i] * 2;
    });
    let rem = n - used;
    const order = [0, 1, 2, 3, 4].sort((i, j) => {
      const diff = quotas[j] - floors[j] - (quotas[i] - floors[i]);
      return Math.abs(diff) > 1e-9 ? diff : j - i;
    });
    for (const idx of order) {
      if (rem >= 2) {
        const [lo, hi] = pairs[idx];
        counts[lo.toFixed(1)] += 1;
        counts[hi.toFixed(1)] += 1;
        rem -= 2;
      }
    }
    if (rem === 1) {
      counts["3.0"] += 1;
    }
  } else {
    let used = 0;
    const quotas = {};
    for (const b of STAR_BUCKETS) {
      const k = b.toFixed(1);
      quotas[k] = probs[k] * n;
      counts[k] = Math.floor(quotas[k]);
      used += counts[k];
    }
    const rem = n - used;
    const ranked = [...STAR_BUCKETS].sort((a, b) => {
      const ka = a.toFixed(1);
      const kb = b.toFixed(1);
      const da = quotas[ka] - counts[ka];
      const db = quotas[kb] - counts[kb];
      if (Math.abs(db - da) > 1e-9) return db - da;
      return Math.abs(a - mean) - Math.abs(b - mean);
    });
    for (let i = 0; i < rem; i++) {
      counts[ranked[i].toFixed(1)] += 1;
    }
  }

  // Build descending tier assignment sequence (5.0 down to 0.5)
  const tierSeq = [];
  for (let i = STAR_BUCKETS.length - 1; i >= 0; i--) {
    const b = STAR_BUCKETS[i];
    const c = counts[b.toFixed(1)] || 0;
    for (let k = 0; k < c; k++) tierSeq.push(b);
  }

  const origDist = {};
  for (const b of STAR_BUCKETS) origDist[b.toFixed(1)] = 0;

  let upgraded = 0;
  let downgraded = 0;
  let unchanged = 0;
  let unrated = 0;
  const origVals = [];
  const bellVals = [];

  films.forEach((film, idx) => {
    const rank = idx + 1;
    const bellRating = tierSeq[idx] !== undefined ? tierSeq[idx] : 0.5;
    bellVals.push(bellRating);

    const q = n > 0 ? (n - rank + 0.5) / n : 0.5;
    const z = normPpf(q);
    const cont = Math.max(0.5, Math.min(5.0, mean + z * stdDev));
    const pct = n > 1 ? Number((((n - rank) / (n - 1)) * 100).toFixed(1)) : 100.0;

    film.final_rank = rank;
    film.percentile = pct;
    film.z_score = Number(z.toFixed(2));
    film.continuous_bell_score = Number(cont.toFixed(2));
    film.bell_rating = bellRating;
    film.bell_stars = formatStars(bellRating);

    if (film.original_rating !== null && film.original_rating !== undefined) {
      const o = Number(film.original_rating);
      origVals.push(o);
      const ok = o.toFixed(1);
      if (origDist[ok] !== undefined) origDist[ok] += 1;
      const delta = Number((bellRating - o).toFixed(1));
      film.rating_delta = delta;
      if (delta > 0) {
        upgraded += 1;
        film.delta_status = "upgraded";
      } else if (delta < 0) {
        downgraded += 1;
        film.delta_status = "downgraded";
      } else {
        unchanged += 1;
        film.delta_status = "unchanged";
      }
    } else {
      film.rating_delta = null;
      film.delta_status = "unrated";
      unrated += 1;
    }
  });

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const meanOrig = avg(origVals);
  const meanBell = avg(bellVals);

  state.session.bell_curve.total_films = n;
  state.session.bell_curve.parameters = { mean, std_dev: stdDev };
  state.session.bell_curve.stats = {
    mean_original: meanOrig !== null ? Number(meanOrig.toFixed(2)) : null,
    mean_bell: meanBell !== null ? Number(meanBell.toFixed(2)) : null,
    rating_inflation:
      meanOrig !== null && meanBell !== null
        ? Number((meanOrig - meanBell).toFixed(2))
        : null,
    upgraded_count: upgraded,
    downgraded_count: downgraded,
    unchanged_count: unchanged,
    unrated_count: unrated,
  };
  state.session.bell_curve.buckets = STAR_BUCKETS.map((b) => {
    const k = b.toFixed(1);
    return {
      rating: b,
      label: STAR_LABELS[k],
      probability_pct: Number((probs[k] * 100).toFixed(2)),
      original_count: origDist[k] || 0,
      bell_count: counts[k] || 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Cloud Storage Persistence (Vercel Blob / Upstash KV / Server Storage)
// ---------------------------------------------------------------------------

function normalizeUsernameClient(raw) {
  let cleaned = String(raw || "").trim();
  if (cleaned.toLowerCase().includes("letterboxd.com/")) {
    try {
      const u = new URL(cleaned.includes("://") ? cleaned : `https://${cleaned}`);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length) cleaned = parts[0];
    } catch (_e) {
      // ignore
    }
  }
  return cleaned.replace(/^@+/, "").replace(/^\/+|\/+$/g, "").trim().toLowerCase();
}

const LOCAL_SAVED_PROFILES_KEY = "ltrbx_local_saved_profiles_v1";

function getLocalSavedProfiles() {
  try {
    const raw = window.localStorage.getItem(LOCAL_SAVED_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 2) : [];
  } catch (_e) {
    return [];
  }
}

function recordLocalSavedProfile(sessionData) {
  if (!sessionData || !sessionData.username) return;
  try {
    const clean = String(sessionData.username).toLowerCase();
    const existing = getLocalSavedProfiles().filter(
      (item) => String(item.username || "").toLowerCase() !== clean
    );
    existing.unshift({
      username: sessionData.username,
      total_films: sessionData.total_films || 0,
      updated_at: new Date().toISOString(),
    });
    window.localStorage.setItem(
      LOCAL_SAVED_PROFILES_KEY,
      JSON.stringify(existing.slice(0, 2))
    );
  } catch (_e) {
    // ignore storage errors in private browsing
  }
  loadSavedSessionsList();
}

function setSaveStatus(text) {
  const indicator = document.getElementById("saveStatusIndicator");
  const mobileStatus = document.getElementById("mobileSaveStatus");
  const redoButton = document.getElementById("redoAddMovieBtn");
  if (indicator) indicator.textContent = text;
  if (mobileStatus) {
    mobileStatus.textContent = text === "Saved Ordered List on Server" ? "" : text === "Saving..." ? "…" : text;
    mobileStatus.setAttribute("aria-label", text);
  }
  if (redoButton) redoButton.disabled = text === "Saving...";
}

function schedulePersistOrder(addedFilm = null) {
  if (!state.session) return;
  setSaveStatus("Saving...");

  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      const slugs = state.session.bell_curve.films.map((f) => f.slug);
      const payload = {
        username: state.session.username,
        ordered_slugs: slugs,
        include_unrated: state.session.settings.include_unrated,
        mean: state.session.settings.mean,
        std_dev: state.session.settings.std_dev,
        comparisons_done: state.session.settings.comparisons_done || 0,
      };
      if (addedFilm) {
        payload.added_film = addedFilm;
      }
      const res = await fetch("/api/save-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        if (addedFilm && data.session) {
          state.session = data.session;
        }
        setSaveStatus("Saved Ordered List on Server");
        recordLocalSavedProfile(state.session);
      } else {
        setSaveStatus("Save Error");
      }
    } catch (_err) {
      setSaveStatus("Save Error");
    }
  }, addedFilm ? 40 : 300);
}

function loadSavedSessionsList() {
  const sessions = getLocalSavedProfiles();
  const bar = document.getElementById("savedSessionsBar");
  const list = document.getElementById("savedSessionsList");
  if (!bar || !list) return;
  if (!sessions.length) {
    bar.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  list.innerHTML = sessions
    .map(
      (s) => `
      <button type="button" class="saved-chip" data-user="${escapeHtml(s.username)}" title="@${escapeHtml(s.username)}">
        <strong>@${escapeHtml(s.username)}</strong>
      </button>
    `
    )
    .join("");
  list.querySelectorAll(".saved-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("usernameInput").value = btn.dataset.user;
      startLookup(btn.dataset.user, false);
    });
  });
}

function showError(msg) {
  const banner = document.getElementById("errorBanner");
  if (!msg) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.textContent = msg;
  banner.classList.remove("hidden");
}

function setProgress(visible, text = "", pct = 0) {
  const area = document.getElementById("progressArea");
  if (!visible) {
    area.classList.add("hidden");
    return;
  }
  area.classList.remove("hidden");
  document.getElementById("progressText").textContent = text;
  document.getElementById("progressCount").textContent = `${Math.round(pct)}%`;
  document.getElementById("progressFill").style.width = `${Math.max(4, Math.min(100, pct))}%`;
}

function updateLookupButtonState() {
  const btn = document.getElementById("lookupBtn");
  const inp = document.getElementById("usernameInput");
  if (!btn || !inp) return;
  const typedUser = normalizeUsernameClient(inp.value);
  const loadedUser = normalizeUsernameClient(state.session?.username || "");
  if (loadedUser && typedUser === loadedUser) {
    btn.innerHTML = "&#x21bb; Re-sync (Keeps Order)";
    btn.dataset.mobileLabel = "↻ Resync";
    btn.title =
      "Re-sync new watched movies & ratings from Letterboxd without changing your existing manual sort order";
  } else {
    btn.textContent = "Load Profile";
    btn.dataset.mobileLabel = "Load";
    btn.title = "Load watched movies for this Letterboxd username";
  }
}

function askIncludeUnrated(count) {
  const dialog = document.getElementById("unratedDialog");
  document.getElementById("unratedDialogMessage").textContent =
    `${count} unrated ${count === 1 ? "film was" : "films were"} found. Include ${count === 1 ? "it" : "them"} in your bell curve?`;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });
}

async function completeLookupSession(sessionData) {
  let session = sessionData;
  if (session.unrated_films_count > 0) {
    setProgress(false);
    const choice = await askIncludeUnrated(session.unrated_films_count);
    if (!choice) return null;
    const includeUnrated = choice === "include";
    if (includeUnrated !== Boolean(session.settings.include_unrated)) {
      const res = await fetch("/api/save-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: session.username,
          include_unrated: includeUnrated,
          ordered_slugs: session.bell_curve.films.map((film) => film.slug),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error || !data.session) {
        throw new Error(data.error || "Failed to update unrated film preference.");
      }
      session = data.session;
    }
  }
  applySession(session);
  return session;
}

async function startLookup(usernameRaw, forceRefresh = false) {
  showError(null);
  const cleanUser = normalizeUsernameClient(usernameRaw);
  if (!cleanUser) {
    showError("Please enter a valid Letterboxd username.");
    return null;
  }

  const maxPagesNum = 139; // Default: up to 10,000 films
  const startBtn = document.getElementById("startAddMovieBtn");
  const lookupBtn = document.getElementById("lookupBtn");
  if (startBtn) startBtn.disabled = true;
  if (lookupBtn) lookupBtn.disabled = true;

  const currentSlugs =
    state.session &&
    normalizeUsernameClient(state.session.username) === cleanUser &&
    Array.isArray(state.session.bell_curve?.films)
      ? state.session.bell_curve.films.map((f) => f.slug)
      : undefined;

  setProgress(
    true,
    forceRefresh
      ? `Re-syncing "${cleanUser}" from Letterboxd (keeping your existing movie order)...`
      : `Looking up Letterboxd profile "${cleanUser}"...`,
    8
  );

  try {
    const res = await fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: cleanUser,
        force_refresh: forceRefresh,
        max_pages: maxPagesNum,
        include_unrated: forceRefresh && state.session
          ? Boolean(state.session.settings.include_unrated)
          : true,
        ordered_slugs: currentSlugs,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || "Failed to look up Letterboxd user.");
    }

    if (data.status === "completed" && data.session) {
      return await completeLookupSession(data.session);
    }

    // Poll job status (local server mode)
    const jobId = data.job_id;
    while (true) {
      await new Promise((r) => setTimeout(r, 450));
      const jr = await fetch(`/api/jobs/${jobId}`);
      const jdata = await jr.json();
      if (jdata.status === "error") {
        throw new Error(jdata.error || "Error scraping Letterboxd profile.");
      }
      if (jdata.status === "completed" && jdata.session) {
        return await completeLookupSession(jdata.session);
      }
      const curr = jdata.current_page || 0;
      const tot = Math.max(1, jdata.total_pages || 1);
      const pct = Math.min(96, Math.round((curr / tot) * 100));
      setProgress(
        true,
        `Fetching page ${curr} of ${tot} from Letterboxd (${jdata.films_loaded || 0} films loaded)...`,
        pct
      );
    }
  } catch (err) {
    showError(err.message || String(err));
    return null;
  } finally {
    setProgress(false);
    if (startBtn) startBtn.disabled = false;
    if (lookupBtn) lookupBtn.disabled = false;
  }
}

function switchAppMode(mode) {
  state.appMode = mode;
  document.querySelectorAll("[data-appmode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.appmode === mode);
  });
  document
    .getElementById("addMovieModeSection")
    .classList.toggle("hidden", mode !== "add");
  document
    .getElementById("emptyState")
    .classList.toggle("hidden", mode !== "full" || Boolean(state.session));
  document
    .getElementById("workspace")
    .classList.toggle("hidden", mode !== "full" || !state.session);
  renderAll();
}

function toggleMobileProfile() {
  const open = document.body.classList.toggle("mobile-profile-open");
  document.getElementById("mobileProfileBtn").setAttribute("aria-expanded", String(open));
  if (!open) document.getElementById("usernameInput").blur();
}

function applySession(sessionData) {
  state.session = sessionData;
  if (state.tournamentApplied && (
    state.tournamentApplied.username !== sessionData.username ||
    !Array.isArray(sessionData.bell_curve?.films) ||
    state.tournamentApplied.slugs.length !== sessionData.bell_curve.films.length ||
    state.tournamentApplied.slugs.some((slug, i) => slug !== sessionData.bell_curve.films[i].slug)
  )) {
    state.tournamentApplied = null;
  }
  state.addMovie.binary = null;
  state.addMovie.result = null;
  state.addMovie.skipProfileSetup = false;
  document.body.classList.add("has-profile");
  document.body.classList.remove("mobile-profile-open");
  const mobileProfileBtn = document.getElementById("mobileProfileBtn");
  mobileProfileBtn.classList.remove("hidden");
  mobileProfileBtn.setAttribute("aria-expanded", "false");
  mobileProfileBtn.setAttribute("aria-label", `Change Letterboxd profile: @${sessionData.username}`);
  document.getElementById("mobileProfileName").textContent = `@${sessionData.username}`;
  setSaveStatus("Saved Ordered List on Server");
  state.battle.binaryState = null;
  state.battle.history = [];
  state.battle.lastPlacedMessage = null;
  if (state.tournament && !TournamentSort.matches(
    state.tournament, sessionData.username, sessionData.bell_curve.films.map((film) => film.slug)
  )) {
    state.tournament = null;
  }
  recordLocalSavedProfile(sessionData);
  document.getElementById("usernameInput").value = sessionData.username || "";
  updateLookupButtonState();
  document.getElementById("globalOptionsBar").classList.remove("hidden");
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("addMovieEmptyState").classList.add("hidden");

  if (state.appMode === "full") {
    document.getElementById("workspace").classList.remove("hidden");
  }

  // Update top profile badge
  const badge = document.getElementById("activeProfileBadge");
  badge.classList.remove("hidden");
  const avatar = document.getElementById("profileAvatar");
  if (sessionData.avatar_url) {
    avatar.src = sessionData.avatar_url;
    avatar.classList.remove("hidden");
  } else {
    avatar.classList.add("hidden");
  }
  const nameLink = document.getElementById("profileNameLink");
  nameLink.textContent = `@${sessionData.username}`;
  nameLink.href = sessionData.profile_url || `https://letterboxd.com/${sessionData.username}/`;
  document.getElementById("profileFilmCounts").textContent =
    `${sessionData.total_films} films`;

  // Sync controls
  const mean = Number(sessionData.settings?.mean ?? 2.75);
  const stdDev = Number(sessionData.settings?.std_dev ?? 1.0);
  document.getElementById("meanSlider").value = mean.toFixed(2);
  document.getElementById("meanValueDisplay").textContent = `${mean.toFixed(2)}★`;
  document.getElementById("stdSlider").value = stdDev.toFixed(2);
  document.getElementById("stdValueDisplay").textContent = `${stdDev.toFixed(2)}★`;

  populateBinaryTargetSelect();
  renderAll();
}

// ---------------------------------------------------------------------------
// Rendering All Views
// ---------------------------------------------------------------------------

function renderAll() {
  if (!state.session) return;
  recomputeBellCurveClientSide();
  renderAddMovieMode();
  renderStep2();
  renderStep3();
}

async function resolveAndStartAddMovie(movieQuery) {
  if (!state.session) return;
  const cleanQuery = movieQuery.trim();
  if (!cleanQuery) {
    showError("Enter a movie title to rank and add to your bell curve.");
    return;
  }
  showError(null);

  const startBtn = document.getElementById("startAddMovieBtn");
  if (startBtn) startBtn.disabled = true;

  try {
    const res = await fetch(`/api/search-film?q=${encodeURIComponent(cleanQuery)}`);
    const data = await res.json();
    const candidates = data.results || [];
    state.addMovie.candidates = candidates;
    const chosen = candidates[0] || {
      id: cleanQuery.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      slug: cleanQuery.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title: cleanQuery,
      year: null,
      full_title: cleanQuery,
      letterboxd_uri: "https://letterboxd.com/",
      poster_url: null,
      original_rating: null,
      liked: false,
    };
    renderCandidateStrip(candidates, chosen.slug);
    beginAddMovieBinarySearch(chosen);
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

function renderCandidateStrip(candidates, activeSlug) {
  const strip = document.getElementById("filmSearchCandidates");
  if (!strip) return;
  if (!candidates || candidates.length <= 1) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    return;
  }
  strip.classList.remove("hidden");
  strip.innerHTML =
    `<span class="saved-label">Matches:</span>` +
    candidates
      .map(
        (c) => `
      <button type="button" class="saved-chip ${c.slug === activeSlug ? "chip-selected" : ""}" data-cand-slug="${escapeHtml(c.slug)}">
        ${escapeHtml(c.title)} ${c.year ? `(${c.year})` : ""}
      </button>
    `
      )
      .join("");

  strip.querySelectorAll("[data-cand-slug]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const found = state.addMovie.candidates.find((c) => c.slug === btn.dataset.candSlug);
      if (found) {
        renderCandidateStrip(state.addMovie.candidates, found.slug);
        beginAddMovieBinarySearch(found);
      }
    });
  });
}

function beginAddMovieBinarySearch(filmCandidate) {
  if (!state.session) return;
  recomputeBellCurveClientSide();
  const currentFilms = state.session.bell_curve?.films || [];

  // Snapshot pre-insertion bell-curve rating for each film in the user's profile
  const others = currentFilms.filter((f) => f.slug !== filmCandidate.slug);
  const preInsertBellBySlug = {};
  others.forEach((f, idx) => {
    preInsertBellBySlug[f.slug] = {
      bell_rating: Number(f.bell_rating),
      bell_stars: f.bell_stars,
      rank: idx + 1,
    };
  });

  if (others.length === 0) {
    finishAddMoviePlacement(filmCandidate, [], 0, preInsertBellBySlug);
    return;
  }

  const maxSteps = 1 + Math.ceil(Math.log2(others.length + 1));
  const low = 0;
  const high = others.length - 1;
  const mid = Math.floor(Math.random() * others.length);

  state.addMovie.selectedCandidate = filmCandidate;
  state.addMovie.result = null;
  state.addMovie.binary = {
    film: { ...filmCandidate },
    others: others.map((f) => ({ ...f })),
    low,
    high,
    mid,
    step: 1,
    maxSteps,
    history: [],
    preInsertBellBySlug,
  };

  renderAddMovieMode();
}

function handleAddMovieBinaryPick(newMovieWon) {
  const b = state.addMovie.binary;
  if (!b) return;

  b.history.push({ low: b.low, high: b.high, mid: b.mid, step: b.step });
  state.session.settings.comparisons_done = (state.session.settings.comparisons_done || 0) + 1;

  if (newMovieWon) {
    b.high = b.mid - 1;
  } else {
    b.low = b.mid + 1;
  }

  if (b.low > b.high) {
    finishAddMoviePlacement(b.film, b.others, b.low, b.preInsertBellBySlug);
    return;
  }

  b.mid = Math.floor((b.low + b.high) / 2);
  b.step += 1;
  renderAddMovieMode();
}

function undoAddMovieBinaryStep() {
  const b = state.addMovie.binary;
  if (!b || !b.history.length) return;
  const prev = b.history.pop();
  b.low = prev.low;
  b.high = prev.high;
  b.mid = prev.mid;
  b.step = prev.step;
  renderAddMovieMode();
}

function redoAddMovieRating() {
  const result = state.addMovie.result;
  if (!result) return;
  beginAddMovieBinarySearch(result.film);
}

function finishAddMoviePlacement(newFilm, othersList, insertIdx, preInsertBellBySlug) {
  const updatedList = [...othersList];
  const insertedFilm = {
    ...newFilm,
    is_added: true,
    initial_rating_rank: insertIdx + 1,
  };
  updatedList.splice(insertIdx, 0, insertedFilm);

  state.session.bell_curve.films = updatedList;
  recomputeBellCurveClientSide();

  const placed = state.session.bell_curve.films.find((f) => f.slug === insertedFilm.slug);
  if (placed) {
    // Assign the newly computed bell-curve rating as the movie's rating in the list
    placed.original_rating = placed.bell_rating;
    placed.original_stars = placed.bell_stars;
    recomputeBellCurveClientSide();
  }

  // Compare before vs after to see which existing movies need rating adjustments to keep the bell curve
  const boundaryAdjustments = [];
  const preexistingAdjustments = [];

  state.session.bell_curve.films.forEach((f) => {
    if (f.slug === insertedFilm.slug) return;
    const pre = preInsertBellBySlug[f.slug];
    const newBell = Number(f.bell_rating);
    const orig = f.original_rating !== null && f.original_rating !== undefined ? Number(f.original_rating) : null;

    const shiftedByInsertion = pre && Math.abs(newBell - pre.bell_rating) > 1e-4;
    const differsFromLetterboxd = orig === null || Math.abs(newBell - orig) > 1e-4;

    if (shiftedByInsertion) {
      boundaryAdjustments.push({
        film: f,
        fromRating: pre.bell_rating,
        fromStars: pre.bell_stars,
        toRating: newBell,
        toStars: f.bell_stars,
        origRating: orig,
        origStars: formatStars(orig),
        reason: "boundary",
      });
    } else if (differsFromLetterboxd) {
      preexistingAdjustments.push({
        film: f,
        fromRating: orig,
        fromStars: formatStars(orig),
        toRating: newBell,
        toStars: f.bell_stars,
        origRating: orig,
        origStars: formatStars(orig),
        reason: "preexisting",
      });
    }
  });

  state.addMovie.binary = null;
  state.addMovie.result = {
    film: placed || insertedFilm,
    finalRank: (placed && placed.final_rank) || insertIdx + 1,
    totalAfter: state.session.bell_curve.films.length,
    bellRating: placed ? placed.bell_rating : 3.0,
    bellStars: placed ? placed.bell_stars : "★★★",
    boundaryAdjustments,
    preexistingAdjustments,
  };

  populateBinaryTargetSelect();
  renderAll();
  schedulePersistOrder(placed || insertedFilm);
}

function renderAddMovieMode() {
  const battleCard = document.getElementById("addMovieBattleCard");
  const resultCard = document.getElementById("addMovieResultCard");
  if (!battleCard || !resultCard) return;

  const needsSetup = isProfileSetupRequired();
  document.getElementById("profileSetupPage").classList.toggle("hidden", !needsSetup);
  document.getElementById("addMovieEntryCard").classList.toggle("hidden", needsSetup);
  const addModeBtn = document.getElementById("addAppModeBtn");
  addModeBtn.textContent = needsSetup ? "Get Started" : "+ Add Movie";
  addModeBtn.dataset.mobileLabel = needsSetup ? "Get Started" : "Add Movie";
  if (needsSetup) {
    const buckets = state.session.bell_curve.buckets;
    const differing = buckets.filter((bucket) => bucket.original_count !== bucket.bell_count).length;
    document.getElementById("profileSetupSummary").textContent =
      `${differing} of ${buckets.length} rating levels differ from the bell-curve target for @${state.session.username}.`;
    document.getElementById("profileSetupChart").innerHTML = renderDistributionChart(buckets);
    battleCard.classList.add("hidden");
    resultCard.classList.add("hidden");
    return;
  }

  const b = state.addMovie.binary;
  const res = state.addMovie.result;

  if (b) {
    battleCard.classList.remove("hidden");
    resultCard.classList.add("hidden");

    const pct = Math.min(98, Math.round(((b.step - 1) / Math.max(1, b.maxSteps)) * 100));
    document.getElementById("addBinaryEstRemaining").textContent = `~${Math.max(1, b.maxSteps - b.step + 1)} left`;
    document.getElementById("addBinaryProgressFill").style.width = `${Math.max(6, pct)}%`;
    document.getElementById("addBinaryUndoBtn").disabled = b.history.length === 0;

    const newFilm = b.film;
    const benchFilm = b.others[b.mid];
    if (!benchFilm) return;

    document.getElementById("addBattleLeftSeed").textContent = "New Movie";
    document.getElementById("addBattleLeftPoster").innerHTML = renderPosterThumb(newFilm, true);
    document.getElementById("addBattleLeftRank").textContent = `Testing Rank #${b.mid + 1}`;
    document.getElementById("addBattleLeftTitle").textContent = `${newFilm.title}${newFilm.year ? ` (${newFilm.year})` : ""}`;

    document.getElementById("addBattleRightSeed").textContent = `Rank #${b.mid + 1}`;
    document.getElementById("addBattleRightPoster").innerHTML = renderPosterThumb(benchFilm, true);
    document.getElementById("addBattleRightTitle").textContent = `${benchFilm.title}${benchFilm.year ? ` (${benchFilm.year})` : ""}`;
    return;
  }

  battleCard.classList.add("hidden");

  if (!res) {
    resultCard.classList.add("hidden");
    return;
  }

  resultCard.classList.remove("hidden");
  const f = res.film;
  document.getElementById("addResultVerdict").innerHTML = `
    <div class="verdict-poster">${renderPosterThumb(f)}</div>
    <div class="verdict-body">
      <span class="verdict-kicker">New Movie Ranked #${res.finalRank} of ${res.totalAfter}</span>
      <h3 class="verdict-title">${escapeHtml(f.title)} ${f.year ? `<span class="muted-meta">(${f.year})</span>` : ""}</h3>
      <div class="verdict-rating-box">
        <span class="verdict-rate-label">Rate this movie on Letterboxd:</span>
        <span class="verdict-stars">${escapeHtml(res.bellStars)}</span>
      </div>
    </div>
  `;

  const preWrap = document.getElementById("showAllPreexistingWrap");
  if (preWrap) {
    preWrap.classList.toggle("hidden", res.preexistingAdjustments.length === 0);
  }

  const itemsToShow = state.addMovie.showAllPreexisting
    ? [...res.boundaryAdjustments, ...res.preexistingAdjustments]
    : res.boundaryAdjustments;

  const listEl = document.getElementById("addAdjustmentsList");
  if (itemsToShow.length === 0) {
    const extraNote =
      res.preexistingAdjustments.length > 0
        ? ` (${res.preexistingAdjustments.length} pre-existing profile differences hidden — toggle above to view)`
        : "";
    listEl.innerHTML = `
      <div class="no-adjustments-box">
        &#x2713; <strong>No other movies shifted tiers!</strong> Adding <em>${escapeHtml(f.title)}</em> at #${res.finalRank} keeps your bell curve balanced without changing any boundary movie.${escapeHtml(extraNote)}
      </div>
    `;
  } else {
    listEl.innerHTML = `
      <table class="comparison-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Movie</th>
            <th>Previous Rating</th>
            <th>New Bell-Curve Rating</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${itemsToShow
            .map(
              (item) => `
            <tr>
              <td><strong>#${item.film.final_rank}</strong></td>
              <td>
                <a href="${escapeHtml(item.film.letterboxd_uri)}" target="_blank" rel="noopener noreferrer" class="film-row-title">
                  ${escapeHtml(item.film.title)} ${item.film.year ? `<span class="muted-meta">(${item.film.year})</span>` : ""}
                </a>
              </td>
              <td><span class="stars-orange">${escapeHtml(item.fromStars)}</span></td>
              <td><strong class="stars-green">&rarr; ${escapeHtml(item.toStars)}</strong></td>
              <td>
                ${
                  item.reason === "boundary"
                    ? '<span class="delta-pill delta-down">Shifted by new movie</span>'
                    : '<span class="delta-pill delta-same">Pre-existing profile drift</span>'
                }
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }
}

function buildFallbackPosterUrl(film) {
  const slug = encodeURIComponent(film.slug || "film");
  const params = new URLSearchParams({
    id: String(film.id || ""),
    title: String(film.title || "Untitled"),
    year: String(film.year || ""),
  });
  return `/api/poster/${slug}?${params.toString()}`;
}

window.handlePosterError = function handlePosterError(imgEl) {
  const originalUrl = imgEl.getAttribute("data-original-url");
  if (originalUrl) {
    imgEl.removeAttribute("data-original-url");
    imgEl.src = originalUrl;
    return;
  }
  const fallbackUrl = imgEl.getAttribute("data-fallback-url");
  if (fallbackUrl && imgEl.getAttribute("data-tried-fallback") !== "1") {
    imgEl.setAttribute("data-tried-fallback", "1");
    imgEl.src = fallbackUrl;
    return;
  }
  const title = imgEl.getAttribute("data-title") || "Film";
  const year = imgEl.getAttribute("data-year") || "";
  const isRow = imgEl.classList.contains("row-poster");
  if (isRow) {
    const div = document.createElement("div");
    div.className = "row-poster row-poster-fallback";
    div.textContent = title.slice(0, 2).toUpperCase();
    imgEl.replaceWith(div);
  } else {
    const div = document.createElement("div");
    div.className = "poster-fallback";
    div.innerHTML = `<span class="fallback-dots">•••</span><strong>${escapeHtml(title)}</strong>${year ? `<small>${escapeHtml(year)}</small>` : ""}`;
    imgEl.replaceWith(div);
  }
};

function renderPosterThumb(film, highResolution = false) {
  const fallbackUrl = buildFallbackPosterUrl(film);
  const originalSrc = film.poster_url || fallbackUrl;
  const highResSrc = highResolution
    ? originalSrc.replace(
      /^(https:\/\/a\.ltrbxd\.com\/resized\/film-poster\/[^?#]+)-0-150-0-225-crop\.jpg(\?[^#]*)?$/,
      "$1-0-500-0-750-crop.jpg$2"
    )
    : originalSrc;
  const primarySrc = highResSrc;
  const triedAttr = film.poster_url ? "0" : "1";
  return `<img
    src="${escapeHtml(primarySrc)}"
    ${highResSrc !== originalSrc ? `data-original-url="${escapeHtml(originalSrc)}"` : ""}
    data-fallback-url="${escapeHtml(fallbackUrl)}"
    data-tried-fallback="${triedAttr}"
    data-title="${escapeHtml(film.title)}"
    data-year="${escapeHtml(film.year || "")}"
    alt="${escapeHtml(film.title)}"
    class="poster-thumb"
    draggable="false"
    loading="lazy"
    onerror="window.handlePosterError(this)"
  />`;
}

// --- VIEW 1: Manual Sort (Drag-and-Drop List + Single-Film Binary Search) ---
function renderStep2() {
  const s = state.session;
  const films = s.bell_curve?.films || [];

  const metaEl = document.getElementById("step2SummaryMeta");
  if (metaEl) {
    metaEl.textContent = `${films.length} films`;
  }

  renderStep2List();
  if (state.sortMode === "tournament") renderTournament();
  if (state.sortMode === "battle") {
    ensureBattlePair();
    renderBattleArena();
  }
}

function setSortMode(mode) {
  state.sortMode = mode;
  document.querySelectorAll("[data-sortmode]").forEach((button) =>
    button.classList.toggle("active", button.dataset.sortmode === mode)
  );
  document.getElementById("listSortSubpanel").classList.toggle("hidden", mode !== "list");
  document.getElementById("battleSortSubpanel").classList.toggle("hidden", mode !== "battle");
  document.getElementById("tournamentSortSubpanel").classList.toggle("hidden", mode !== "tournament");
  document.getElementById("step2WorkspaceActions").classList.toggle("hidden", mode !== "list");
}

const TOURNAMENT_DRAFT_PREFIX = "ltrbx_tournament_v1_";

function tournamentDraftKey(username) {
  return `${TOURNAMENT_DRAFT_PREFIX}${username.toLowerCase()}`;
}

function saveTournamentDraft() {
  try {
    window.localStorage.setItem(
      tournamentDraftKey(state.tournament.username),
      JSON.stringify(state.tournament)
    );
  } catch (err) {
    showError(`Could not save tournament progress: ${err.message}`);
  }
}

function loadTournamentDraft() {
  if (!state.session || state.tournament) return;
  try {
    const stored = window.localStorage.getItem(tournamentDraftKey(state.session.username));
    if (!stored) return;
    const draft = JSON.parse(stored);
    const slugs = state.session.bell_curve.films.map((film) => film.slug);
    if (draft.username !== state.session.username) {
      showError("This saved tournament belongs to a different Letterboxd user. Start a new tournament.");
      return;
    }
    if (!TournamentSort.matches(draft, state.session.username, slugs)) {
      showError("Your film list has changed since this tournament started. Start a new tournament.");
      return;
    }
    if (!Array.isArray(draft.lists) || !Array.isArray(draft.nextLists) ||
        !Array.isArray(draft.merged) || !Number.isInteger(draft.comparisons) ||
        !TournamentSort.pair(draft) && draft.lists.length !== 1) {
      throw new Error("Invalid saved tournament data.");
    }
    if (!draft.undoBase || !Array.isArray(draft.history)) {
      TournamentSort.enableUndo(draft);
      showError("This tournament predates Back. You can undo new picks, or restart to undo from the beginning.");
    }
    state.tournament = draft;
    saveTournamentDraft();
  } catch (err) {
    showError(`Could not resume tournament: ${err.message}`);
  }
}

function renderTournamentOrderPreview(slugs, applied) {
  const preview = document.getElementById("tournamentOrderPreview");
  preview.classList.remove("hidden");
  document.getElementById("tournamentOrderPreviewHeading").textContent =
    applied ? "Saved ranking" : "Proposed ranking";
  document.getElementById("tournamentOrderPreviewNote").textContent = applied
    ? "This order is saved. You can also edit it in List Sorter."
    : "Your current order will not change until you apply this result.";
  const films = new Map(state.session.bell_curve.films.map((film) => [film.slug, film]));
  document.getElementById("tournamentOrderPreviewList").innerHTML = slugs.map((slug, index) => {
    const film = films.get(slug);
    return `<li><span class="tournament-order-rank">#${index + 1}</span><span>${escapeHtml(
      film ? `${film.title}${film.year ? ` (${film.year})` : ""}` : slug
    )}</span></li>`;
  }).join("");
}

function renderTournament() {
  const draft = state.tournament;
  const startBtn = document.getElementById("tournamentStartBtn");
  const statusHeading = document.getElementById("tournamentStatusHeading");
  const statusText = document.getElementById("tournamentStatusText");
  const active = document.getElementById("tournamentActive");
  const applyBtn = document.getElementById("tournamentApplyBtn");
  const applied = !draft && state.tournamentApplied?.username === state.session.username
    ? state.tournamentApplied : null;
  startBtn.classList.toggle("hidden", Boolean(draft));
  startBtn.textContent = applied ? "Start New Tournament" : "Start Tournament";
  document.getElementById("tournamentCancelBtn").classList.toggle("hidden", !draft);
  const backBtn = document.getElementById("tournamentBackBtn");
  backBtn.classList.toggle("hidden", !draft);
  backBtn.disabled = !draft?.history?.length;
  active.classList.toggle("hidden", !draft || !TournamentSort.pair(draft));
  applyBtn.classList.toggle("hidden", !draft || draft.lists.length !== 1);
  document.getElementById("tournamentOrderPreview").classList.toggle(
    "hidden", !applied && (!draft || draft.lists.length !== 1)
  );
  if (!draft) {
    statusHeading.textContent = applied ? "Tournament saved" : "Full Tournament";
    statusText.textContent = applied
      ? `Completed after ${applied.comparisons} comparisons. Your new order has been saved.`
      : "Sort your entire list through head-to-head comparisons. Your current order stays unchanged until you apply the result.";
    if (applied) renderTournamentOrderPreview(applied.slugs, true);
    return;
  }
  const done = draft.lists.length === 1;
  statusHeading.textContent = done ? "Tournament complete" : "Remaining comparisons";
  const plan = done ? null : TournamentSort.remaining(draft);
  const countLabel = (min, max) =>
    `${min === max ? min : `${min}–${max}`} ${min === max && min === 1 ? "comparison" : "comparisons"}`;
  statusText.textContent = done
    ? `Completed after ${draft.comparisons} comparisons. Review and apply your new order.`
    : `${countLabel(plan.minimum, plan.maximum)} remain; exact matchups in later rounds depend on your picks.`;
  const maxComparisons = draft.sourceSlugs.length * Math.ceil(Math.log2(draft.sourceSlugs.length));
  document.getElementById("tournamentProgressFill").style.width =
    `${done ? 100 : Math.min(99, Math.round(draft.comparisons / maxComparisons * 100))}%`;
  if (done) {
    renderTournamentOrderPreview(draft.lists[0], false);
    return;
  }
  const films = state.session.bell_curve.films;
  const filmBySlug = new Map(films.map((film) => [film.slug, film]));
  const current = TournamentSort.pair(draft);
  for (const [side, slug] of [["Left", current[0]], ["Right", current[1]]]) {
    const film = filmBySlug.get(slug);
    document.getElementById(`tournament${side}Poster`).innerHTML = renderPosterThumb(film, true);
    document.getElementById(`tournament${side}Title`).textContent =
      `${film.title}${film.year ? ` (${film.year})` : ""}`;
  }
}

function chooseTournament(side) {
  const draft = state.tournament;
  if (!draft || !TournamentSort.pair(draft)) return;
  if (!TournamentSort.matches(
    draft, state.session.username, state.session.bell_curve.films.map((film) => film.slug)
  )) {
    showError("The movie list changed. Discard this tournament and start again.");
    return;
  }
  TournamentSort.choose(draft, TournamentSort.pair(draft)[side]);
  saveTournamentDraft();
  renderTournament();
}

function undoTournamentChoice() {
  if (!state.tournament || !TournamentSort.undo(state.tournament)) return;
  saveTournamentDraft();
  renderTournament();
}

async function applyTournament() {
  const draft = state.tournament;
  if (!draft || draft.lists.length !== 1) return;
  const slugs = state.session.bell_curve.films.map((film) => film.slug);
  if (!TournamentSort.matches(draft, state.session.username, slugs)) {
    showError("The movie list changed. Discard this tournament and start again.");
    return;
  }
  const btn = document.getElementById("tournamentApplyBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/save-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: draft.username,
        ordered_slugs: draft.lists[0],
        include_unrated: state.session.settings.include_unrated,
        mean: state.session.settings.mean,
        std_dev: state.session.settings.std_dev,
        comparisons_done: (state.session.settings.comparisons_done || 0) + draft.comparisons,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.session) {
      throw new Error(data.error || "Could not apply tournament order.");
    }
    let draftRemovalError = null;
    try {
      window.localStorage.removeItem(tournamentDraftKey(draft.username));
    } catch (err) {
      draftRemovalError = err;
    }
    state.tournament = null;
    applySession(data.session);
    state.tournamentApplied = {
      username: data.session.username,
      slugs: data.session.bell_curve.films.map((film) => film.slug),
      comparisons: draft.comparisons,
    };
    renderTournament();
    if (draftRemovalError) {
      showError(`Order applied, but could not remove the saved draft: ${draftRemovalError.message}`);
    }
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

function renderStep2List() {
  const films = state.session?.bell_curve?.films || [];

  const listEl = document.getElementById("manualSortList");
  if (!films.length) {
    listEl.innerHTML = `<p class="muted-meta" style="padding: 16px;">No films loaded.</p>`;
    return;
  }

  // Precompute master rank range and count for each Bell-Curve target rating tier
  const tierStats = {};
  const buckets = state.session?.bell_curve?.buckets || [];
  buckets.forEach((b) => {
    tierStats[b.rating.toFixed(1)] = {
      count: b.bell_count,
      pct: b.probability_pct,
      minRank: null,
      maxRank: null,
    };
  });
  films.forEach((f) => {
    const k = Number(f.bell_rating).toFixed(1);
    if (!tierStats[k]) {
      tierStats[k] = { count: 0, pct: 0, minRank: null, maxRank: null };
    }
    if (tierStats[k].minRank === null || f.final_rank < tierStats[k].minRank) {
      tierStats[k].minRank = f.final_rank;
    }
    if (tierStats[k].maxRank === null || f.final_rank > tierStats[k].maxRank) {
      tierStats[k].maxRank = f.final_rank;
    }
  });

  let lastTierKey = null;
  const rowsHtml = [];
  const limit = state.step2RenderLimit || 300;
  const slicedFilms = films.slice(0, limit);

  slicedFilms.forEach((f) => {
    const tierKey = Number(f.bell_rating).toFixed(1);
    if (tierKey !== lastTierKey) {
      const ts = tierStats[tierKey] || {};
      const rangeStr =
        ts.minRank !== null && ts.maxRank !== null
          ? ts.minRank === ts.maxRank
            ? `#${ts.minRank}`
            : `#${ts.minRank} – #${ts.maxRank}`
          : "";
      rowsHtml.push(`
        <div class="tier-separator" data-tier-rating="${tierKey}">
          <div class="tier-separator-left">
            <span class="tier-separator-badge">${escapeHtml(f.bell_stars)}</span>
          </div>
          <div class="tier-separator-right">
            <span>${rangeStr}</span>
            <span class="tier-sep-dot">&bull;</span>
            <span>${ts.count || 0} films (${ts.pct || 0}%)</span>
          </div>
        </div>
      `);
      lastTierKey = tierKey;
    }

    const fallbackUrl = buildFallbackPosterUrl(f);
    const posterSrc = f.poster_url || fallbackUrl;
    const triedAttr = f.poster_url ? "0" : "1";
    const posterImg = `<img
      src="${escapeHtml(posterSrc)}"
      data-fallback-url="${escapeHtml(fallbackUrl)}"
      data-tried-fallback="${triedAttr}"
      data-title="${escapeHtml(f.title)}"
      data-year="${escapeHtml(f.year || "")}"
      alt=""
      class="row-poster"
      draggable="false"
      loading="lazy"
      onerror="window.handlePosterError(this)"
    />`;

    rowsHtml.push(`
      <div class="sort-row" data-slug="${escapeHtml(f.slug)}" data-rank="${f.final_rank}" data-title="${escapeHtml(f.title)}">
        <div class="rank-cell">
          <span class="drag-handle" title="Drag to reorder">&#x2630;</span>
          <input
            type="number"
            class="rank-input"
            min="1"
            max="${films.length}"
            value="${f.final_rank}"
            data-slug="${escapeHtml(f.slug)}"
            title="Type rank (1–${films.length}) and press Enter"
          />
        </div>

        <div class="film-cell">
          ${posterImg}
          <div class="film-title-wrap">
            <a href="${escapeHtml(f.letterboxd_uri)}" target="_blank" rel="noopener noreferrer" draggable="false" class="film-row-title">
              ${escapeHtml(f.title)} ${f.is_added ? '<span class="delta-pill delta-up">NEW</span>' : ""}
            </a>
            <span class="film-row-year">${f.year || ""}${f.liked ? ' <span class="heart-icon">♥</span>' : ""}</span>
          </div>
        </div>

        <div class="orig-rating-cell" title="Original Rating">
          <span class="mobile-cell-label">Orig:</span>
          <span class="stars-orange">${escapeHtml(formatStars(f.original_rating))}</span>
        </div>

        <div class="bell-rating-cell" title="Bell-Curve Target">
          <span class="mobile-cell-label">Bell:</span>
          <span class="stars-green">${escapeHtml(f.bell_stars)}</span>
        </div>

        <div class="row-controls">
          <button type="button" class="icon-btn btn-rating-up" data-action="rating-up" data-slug="${escapeHtml(f.slug)}" title="Move UP 1 rating tier (places at bottom of higher ★ tier)">+&starf;<span class="btn-label-text"> Up</span></button>
          <button type="button" class="icon-btn btn-rating-down" data-action="rating-down" data-slug="${escapeHtml(f.slug)}" title="Move DOWN 1 rating tier (places at top of lower ★ tier)">&minus;&starf;<span class="btn-label-text"> Down</span></button>
          <button type="button" class="icon-btn" data-action="tier-top" data-slug="${escapeHtml(f.slug)}" title="Move to TOP of current rating tier">&#x2912;<span class="btn-label-text"> Top</span></button>
          <button type="button" class="icon-btn" data-action="tier-bottom" data-slug="${escapeHtml(f.slug)}" title="Move to BOTTOM of current rating tier">&#x2913;<span class="btn-label-text"> Bot</span></button>
          <button type="button" class="icon-btn" data-action="binary-rank" data-slug="${escapeHtml(f.slug)}" title="Binary-search rank this film (A vs B)">&#x1F3AF;</button>
        </div>
      </div>
    `);
  });

  if (films.length > limit) {
    const rem = films.length - limit;
    rowsHtml.push(`
      <div class="load-more-bar">
        <button type="button" class="btn btn-secondary btn-sm" id="step2LoadMoreBtn">
          Show Next ${Math.min(500, rem)} (${rem} remaining)
        </button>
        <button type="button" class="btn btn-ghost btn-sm" id="step2LoadAllBtn">
          Show All ${films.length}
        </button>
      </div>
    `);
  }

  listEl.innerHTML = rowsHtml.join("");

  const moreBtn = document.getElementById("step2LoadMoreBtn");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      state.step2RenderLimit = (state.step2RenderLimit || 300) + 500;
      renderStep2List();
    });
  }
  const allBtn = document.getElementById("step2LoadAllBtn");
  if (allBtn) {
    allBtn.addEventListener("click", () => {
      state.step2RenderLimit = films.length;
      renderStep2List();
    });
  }

  attachSortRowEvents(listEl, films);
}

function moveFilmInMasterList(slug, targetSlug, placeAfter = false) {
  const films = state.session.bell_curve.films;
  const fromIdx = films.findIndex((f) => f.slug === slug);
  const toIdx = films.findIndex((f) => f.slug === targetSlug);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

  const [moved] = films.splice(fromIdx, 1);
  const newTargetIdx = films.findIndex((f) => f.slug === targetSlug);
  const insertAt = placeAfter ? newTargetIdx + 1 : newTargetIdx;
  films.splice(insertAt, 0, moved);

  renderAll();
  schedulePersistOrder();
}

function jumpFilmToExactRank(slug, newRank1Based) {
  const films = state.session.bell_curve.films;
  const fromIdx = films.findIndex((f) => f.slug === slug);
  if (fromIdx === -1) return;
  const targetIdx = Math.max(0, Math.min(films.length - 1, Number(newRank1Based) - 1));
  if (fromIdx === targetIdx) return;

  const [moved] = films.splice(fromIdx, 1);
  films.splice(targetIdx, 0, moved);
  renderAll();
  schedulePersistOrder();
}

function moveFilmByRatingTier(slug, action) {
  const films = state.session?.bell_curve?.films || [];
  const film = films.find((f) => f.slug === slug);
  if (!film || films.length < 2) return;

  const currRating = Number(film.bell_rating);
  const sameTier = films.filter((f) => Math.abs(Number(f.bell_rating) - currRating) < 1e-4);
  const higherFilms = films.filter((f) => Number(f.bell_rating) > currRating + 1e-4);
  const lowerFilms = films.filter((f) => Number(f.bell_rating) < currRating - 1e-4);

  if (action === "rating-up") {
    // Move up 1 rating tier -> put at the BOTTOM of the next higher rating tier
    if (higherFilms.length > 0) {
      const bottomOfHigherTier = higherFilms[higherFilms.length - 1];
      jumpFilmToExactRank(slug, bottomOfHigherTier.final_rank);
    } else {
      // Already in highest tier -> move to Rank #1 (top of highest tier)
      jumpFilmToExactRank(slug, 1);
    }
  } else if (action === "rating-down") {
    // Move down 1 rating tier -> put at the TOP of the next lower rating tier
    if (lowerFilms.length > 0) {
      const topOfLowerTier = lowerFilms[0];
      jumpFilmToExactRank(slug, topOfLowerTier.final_rank);
    } else {
      // Already in lowest tier -> move to Rank #N (bottom of lowest tier)
      jumpFilmToExactRank(slug, films.length);
    }
  } else if (action === "tier-top") {
    // Move to the TOP of current rating tier (or top of next higher tier if already at top)
    const firstInTier = sameTier[0];
    if (firstInTier && firstInTier.slug !== slug) {
      jumpFilmToExactRank(slug, firstInTier.final_rank);
    } else if (higherFilms.length > 0) {
      const prevTierRating = Number(higherFilms[higherFilms.length - 1].bell_rating);
      const prevTierFilms = films.filter(
        (f) => Math.abs(Number(f.bell_rating) - prevTierRating) < 1e-4
      );
      if (prevTierFilms.length > 0) {
        jumpFilmToExactRank(slug, prevTierFilms[0].final_rank);
      }
    }
  } else if (action === "tier-bottom") {
    // Move to the BOTTOM of current rating tier (or bottom of next lower tier if already at bottom)
    const lastInTier = sameTier[sameTier.length - 1];
    if (lastInTier && lastInTier.slug !== slug) {
      jumpFilmToExactRank(slug, lastInTier.final_rank);
    } else if (lowerFilms.length > 0) {
      const nextTierRating = Number(lowerFilms[0].bell_rating);
      const nextTierFilms = films.filter(
        (f) => Math.abs(Number(f.bell_rating) - nextTierRating) < 1e-4
      );
      if (nextTierFilms.length > 0) {
        jumpFilmToExactRank(slug, nextTierFilms[nextTierFilms.length - 1].final_rank);
      }
    }
  }
}

function attachSortRowEvents(listEl) {
  if (listEl.dataset.delegated === "1") return;
  listEl.dataset.delegated = "1";

  // Delegated rank number direct jump (change & Enter key)
  listEl.addEventListener("change", (e) => {
    const inp = e.target.closest(".rank-input");
    if (!inp) return;
    const val = parseInt(inp.value, 10);
    if (!isNaN(val)) {
      jumpFilmToExactRank(inp.dataset.slug, val);
    }
  });

  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const inp = e.target.closest(".rank-input");
    if (!inp) return;
    e.preventDefault();
    const val = parseInt(inp.value, 10);
    if (!isNaN(val)) {
      jumpFilmToExactRank(inp.dataset.slug, val);
    }
  });

  // Delegated Rating / Tier movement buttons + Quick Binary Search button
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".icon-btn");
    if (!btn) return;
    e.stopPropagation();
    const slug = btn.dataset.slug;
    const action = btn.dataset.action;
    if (action === "binary-rank") {
      setSortMode("battle");
      const sel = document.getElementById("binaryTargetFilmSelect");
      if (sel) sel.value = slug;
      startBinarySearchForFilm(slug);
      renderBattleArena();
      return;
    }
    moveFilmByRatingTier(slug, action);
  });

  // Delegated Pointer-based Drag and Drop with Wheel Scroll + 60fps Edge Auto-Scroll
  setupPointerDragAndScroll(listEl);
}

const dragController = {
  active: false,
  pending: false,
  slug: null,
  title: "",
  startX: 0,
  startY: 0,
  clientX: 0,
  clientY: 0,
  targetSlug: null,
  placeAfter: false,
  rafId: null,
  ghostEl: null,
  listenersAttached: false,
};

function ensureDragGhost() {
  if (!dragController.ghostEl) {
    const el = document.createElement("div");
    el.className = "drag-floating-ghost hidden";
    document.body.appendChild(el);
    dragController.ghostEl = el;
  }
  return dragController.ghostEl;
}

function clearDragHighlights() {
  document.querySelectorAll(".sort-row").forEach((r) => {
    r.classList.remove("dragging", "drag-over-top", "drag-over-bottom");
  });
}

function updateDragTargetAtPoint(clientX, clientY) {
  if (!dragController.active) return;
  const listEl = document.getElementById("manualSortList");
  if (!listEl) return;

  const rows = Array.from(listEl.querySelectorAll(".sort-row"));
  if (!rows.length) return;

  rows.forEach((r) => r.classList.remove("drag-over-top", "drag-over-bottom"));

  // Find the row closest vertically to the pointer
  let hoveredRow = null;
  const elUnder = document.elementFromPoint(clientX, clientY);
  if (elUnder) {
    hoveredRow = elUnder.closest(".sort-row");
  }

  if (!hoveredRow) {
    // If pointer is above first visible row or below last visible row in viewport
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (clientY <= rect.bottom) {
        hoveredRow = r;
        break;
      }
    }
    if (!hoveredRow) {
      hoveredRow = rows[rows.length - 1];
    }
  }

  const targetSlug = hoveredRow.dataset.slug;
  if (!targetSlug || targetSlug === dragController.slug) {
    dragController.targetSlug = null;
    return;
  }

  const rect = hoveredRow.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const placeAfter = clientY >= midY;

  hoveredRow.classList.toggle("drag-over-top", !placeAfter);
  hoveredRow.classList.toggle("drag-over-bottom", placeAfter);

  dragController.targetSlug = targetSlug;
  dragController.placeAfter = placeAfter;

  const ghost = ensureDragGhost();
  const targetRank = hoveredRow.dataset.rank || "";
  ghost.innerHTML = `<span class="ghost-tag">Move</span> <strong>${escapeHtml(dragController.title)}</strong> <span class="ghost-target">&rarr; ${placeAfter ? "after" : "before"} #${escapeHtml(targetRank)}</span>`;
  const maxX = Math.max(8, window.innerWidth - 230);
  const clampedX = Math.min(maxX, Math.max(8, Math.round(clientX + 12)));
  const clampedY = Math.max(8, Math.round(clientY - 28));
  ghost.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
}

function runAutoScrollLoop() {
  if (!dragController.active) {
    dragController.rafId = null;
    return;
  }

  const topbar = document.querySelector(".topbar");
  const topBound = (topbar ? topbar.getBoundingClientRect().bottom : 0) + 120;
  const bottomBound = window.innerHeight - 120;
  const y = dragController.clientY;

  let scrollDelta = 0;
  if (y < topBound) {
    const intensity = Math.min(1, (topBound - y) / 120);
    scrollDelta = -Math.ceil(2 + intensity * intensity * 24);
  } else if (y > bottomBound) {
    const intensity = Math.min(1, (y - bottomBound) / 120);
    scrollDelta = Math.ceil(2 + intensity * intensity * 24);
  }

  if (scrollDelta !== 0) {
    window.scrollBy(0, scrollDelta);
    updateDragTargetAtPoint(dragController.clientX, dragController.clientY);
  }

  dragController.rafId = requestAnimationFrame(runAutoScrollLoop);
}

function stopPointerDrag(commitDrop = false) {
  const wasActive = dragController.active;
  const slug = dragController.slug;
  const targetSlug = dragController.targetSlug;
  const placeAfter = dragController.placeAfter;

  dragController.active = false;
  dragController.pending = false;
  dragController.slug = null;
  dragController.targetSlug = null;

  if (dragController.rafId) {
    cancelAnimationFrame(dragController.rafId);
    dragController.rafId = null;
  }

  document.body.classList.remove("is-sorting-drag");
  const ghost = ensureDragGhost();
  ghost.classList.add("hidden");
  clearDragHighlights();

  if (commitDrop && wasActive && slug && targetSlug && slug !== targetSlug) {
    moveFilmInMasterList(slug, targetSlug, placeAfter);
  }
}

function setupPointerDragAndScroll(listEl) {
  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("input, button, a, select")) return;
    if (e.pointerType === "touch" && !e.target.closest(".drag-handle")) return;
    const row = e.target.closest(".sort-row");
    if (!row) return;

    dragController.pending = true;
    dragController.active = false;
    dragController.slug = row.dataset.slug;
    dragController.title = row.dataset.title || row.dataset.slug;
    dragController.startX = e.clientX;
    dragController.startY = e.clientY;
    dragController.clientX = e.clientX;
    dragController.clientY = e.clientY;
    dragController.targetSlug = null;
  });

  if (dragController.listenersAttached) return;
  dragController.listenersAttached = true;

  window.addEventListener(
    "pointermove",
    (e) => {
      if (!dragController.pending && !dragController.active) return;
      dragController.clientX = e.clientX;
      dragController.clientY = e.clientY;

      if (dragController.pending && !dragController.active) {
        const dist = Math.hypot(
          e.clientX - dragController.startX,
          e.clientY - dragController.startY
        );
        if (dist < 5) return;

        dragController.pending = false;
        dragController.active = true;
        document.body.classList.add("is-sorting-drag");

        const sourceRow = document.querySelector(
          `.sort-row[data-slug="${CSS.escape(dragController.slug)}"]`
        );
        if (sourceRow) sourceRow.classList.add("dragging");

        const ghost = ensureDragGhost();
        ghost.classList.remove("hidden");
        if (!dragController.rafId) {
          dragController.rafId = requestAnimationFrame(runAutoScrollLoop);
        }
      }

      if (dragController.active) {
        e.preventDefault();
        updateDragTargetAtPoint(e.clientX, e.clientY);
      }
    },
    { passive: false }
  );

  // Allow mouse-wheel / trackpad scrolling while holding a movie row
  window.addEventListener(
    "scroll",
    () => {
      if (dragController.active) {
        updateDragTargetAtPoint(dragController.clientX, dragController.clientY);
      }
    },
    { passive: true }
  );

  window.addEventListener("pointerup", () => {
    if (dragController.pending || dragController.active) {
      stopPointerDrag(true);
    }
  });

  window.addEventListener("pointercancel", () => {
    if (dragController.pending || dragController.active) {
      stopPointerDrag(false);
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (dragController.pending || dragController.active)) {
      stopPointerDrag(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Step 2B: Single-Film Binary Search (A vs B)
// ---------------------------------------------------------------------------

function populateBinaryTargetSelect() {
  const sel = document.getElementById("binaryTargetFilmSelect");
  if (!sel) return;
  const currentVal = sel.value;
  const films = [...(state.session?.bell_curve?.films || [])].sort((a, b) => {
    const cmp = String(a.title || "").localeCompare(String(b.title || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (cmp !== 0) return cmp;
    return (Number(a.year) || 0) - (Number(b.year) || 0);
  });
  sel.innerHTML = films
    .map(
      (f) =>
        `<option value="${escapeHtml(f.slug)}">${escapeHtml(f.title)}${f.year ? ` (${f.year})` : ""}</option>`
    )
    .join("");
  if (currentVal && films.some((f) => f.slug === currentVal)) {
    sel.value = currentVal;
  }
}

function startBinarySearchForFilm(targetSlug, clearBanner = true) {
  const films = state.session?.bell_curve?.films || [];
  if (films.length < 2) return;
  const idx = films.findIndex((f) => f.slug === targetSlug);
  const useSlug = idx !== -1 ? targetSlug : films[0].slug;

  const sel = document.getElementById("binaryTargetFilmSelect");
  if (sel) sel.value = useSlug;

  if (clearBanner) {
    state.battle.lastPlacedMessage = null;
  }

  const others = films.filter((f) => f.slug !== useSlug);
  const maxSteps = 1 + Math.ceil(Math.log2(others.length + 1));
  const low = 0;
  const high = others.length - 1;
  const mid = Math.floor(Math.random() * others.length);

  state.battle.binaryState = {
    targetSlug: useSlug,
    low,
    high,
    mid,
    step: 1,
    maxSteps,
  };
  state.battle.history = [];
  state.battle.leftSlug = useSlug;
  state.battle.rightSlug = others[mid].slug;
}

function ensureBattlePair() {
  const films = state.session?.bell_curve?.films || [];
  if (films.length < 2) return;

  if (
    !state.battle.binaryState ||
    !films.some((f) => f.slug === state.battle.binaryState.targetSlug)
  ) {
    const sel = document.getElementById("binaryTargetFilmSelect");
    startBinarySearchForFilm((sel && sel.value) || films[0].slug, false);
  }
}

function renderBattleArena() {
  const films = state.session?.bell_curve?.films || [];
  if (films.length < 2) return;

  ensureBattlePair();
  const bs = state.battle.binaryState;
  if (!bs) return;

  const bannerEl = document.getElementById("binaryPlacedBanner");
  if (bannerEl) {
    if (state.battle.lastPlacedMessage) {
      bannerEl.textContent = state.battle.lastPlacedMessage;
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.classList.add("hidden");
    }
  }

  const pct = Math.min(98, Math.round(((bs.step - 1) / Math.max(1, bs.maxSteps)) * 100));
  document.getElementById("binaryProgressFill").style.width = `${Math.max(5, pct)}%`;
  document.getElementById("binaryEstRemaining").textContent = `~${Math.max(1, bs.maxSteps - bs.step + 1)} left`;
  document.getElementById("binaryBackBtn").disabled = !state.battle.history.length;

  const left = films.find((f) => f.slug === state.battle.leftSlug);
  const right = films.find((f) => f.slug === state.battle.rightSlug);
  if (!left || !right) return;

  document.getElementById("battlePromptTitle").textContent =
    `Which movie do you rank higher?`;

  const fillCard = (prefix, film, roleLabel) => {
    const seedEl = document.getElementById(`${prefix}Seed`);
    if (seedEl) {
      seedEl.textContent = `${roleLabel} • #${film.final_rank}`;
    }
    document.getElementById(`${prefix}Poster`).innerHTML = renderPosterThumb(film, true);
    document.getElementById(`${prefix}Title`).textContent = `${film.title}${film.year ? ` (${film.year})` : ""}`;
  };

  fillCard("battleLeft", left, "Target");
  fillCard("battleRight", right, "Benchmark");
}

function handleBattleChoice(winnerSlug) {
  const films = state.session?.bell_curve?.films || [];
  const bs = state.battle.binaryState;
  if (!bs || films.length < 2) return;

  state.session.settings.comparisons_done = (state.session.settings.comparisons_done || 0) + 1;
  const others = films.filter((f) => f.slug !== bs.targetSlug);
  const targetWon = winnerSlug === bs.targetSlug;
  state.battle.history.push({ low: bs.low, high: bs.high, mid: bs.mid, step: bs.step });

  if (targetWon) {
    bs.high = bs.mid - 1;
  } else {
    bs.low = bs.mid + 1;
  }

  if (bs.low > bs.high) {
    const targetFilm = films.find((f) => f.slug === bs.targetSlug);
    const newRank = bs.low + 1;
    others.splice(bs.low, 0, targetFilm);
    state.session.bell_curve.films = others;
    recomputeBellCurveClientSide();

    const placedFilm = state.session.bell_curve.films.find((f) => f.slug === bs.targetSlug);
    const bellStarText = placedFilm ? placedFilm.bell_stars : "";
    state.battle.lastPlacedMessage =
      `✓ Placed "${targetFilm.title}" at #${newRank} (${bellStarText})`;

    populateBinaryTargetSelect();
    startBinarySearchForFilm(bs.targetSlug, false);
    renderAll();
    schedulePersistOrder();
    return;
  }

  bs.mid = Math.floor((bs.low + bs.high) / 2);
  bs.step += 1;
  state.battle.rightSlug = others[bs.mid].slug;
  renderBattleArena();
}

function undoBattleChoice() {
  const bs = state.battle.binaryState;
  const prev = state.battle.history.pop();
  if (!bs || !prev) return;
  Object.assign(bs, prev);
  const others = state.session.bell_curve.films.filter((film) => film.slug !== bs.targetSlug);
  state.battle.rightSlug = others[bs.mid].slug;
  state.battle.lastPlacedMessage = null;
  renderBattleArena();
}

// ---------------------------------------------------------------------------
// VIEW 2: Bell Curve Chart & Full Ranked Comparison Table
// ---------------------------------------------------------------------------

function formatRankChangeBadge(film) {
  const initRank = Number(film.initial_rating_rank || film.final_rank);
  const finalRank = Number(film.final_rank);
  const diff = initRank - finalRank;
  if (diff > 0) {
    return `<span class="delta-pill delta-up">&uarr; +${diff}</span>`;
  }
  if (diff < 0) {
    return `<span class="delta-pill delta-down">&darr; ${diff}</span>`;
  }
  return `<span class="delta-pill delta-same">&mdash;</span>`;
}

function isFilmRatingChanged(film) {
  if (film.original_rating === null || film.original_rating === undefined) {
    return true;
  }
  return Math.abs(Number(film.bell_rating) - Number(film.original_rating)) > 1e-4;
}

function hasMatchingDistribution() {
  const buckets = state.session?.bell_curve?.buckets;
  return buckets?.length === STAR_BUCKETS.length &&
    buckets.every((bucket) => bucket.original_count === bucket.bell_count);
}

function isProfileSetupRequired() {
  return !state.addMovie.skipProfileSetup &&
    !hasMatchingDistribution() && !state.addMovie.binary && !state.addMovie.result;
}

function skipProfileSetupForCurrentSession() {
  state.addMovie.skipProfileSetup = true;
  renderAddMovieMode();
  document.getElementById("newMovieInput").focus();
}

async function resyncProfileSetup() {
  const button = document.getElementById("profileSetupResyncBtn");
  button.disabled = true;
  try {
    await startLookup(state.session.username, true);
  } finally {
    button.disabled = false;
  }
}

function renderDistributionChart(buckets) {
  const maxBar = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.original_count, b.bell_count))
  );
  return buckets.map((b) => {
    const hOrig = Math.max(2, Math.round((b.original_count / maxBar) * 140));
    const hBell = Math.max(2, Math.round((b.bell_count / maxBar) * 140));
    return `
      <div class="bell-col">
        <div class="bell-bars-pair">
          <div class="bar-wrap" title="Original ${b.label}: ${b.original_count} films">
            <span class="bar-count">${b.original_count}</span>
            <div class="bar-orig" style="height: ${hOrig}px"></div>
          </div>
          <div class="bar-wrap" title="Bell Curve ${b.label}: ${b.bell_count} films (${b.probability_pct}%)">
            <span class="bar-count" style="color: var(--lb-green)">${b.bell_count}</span>
            <div class="bar-bell" style="height: ${hBell}px"></div>
          </div>
        </div>
        <span class="bell-col-label">${b.label}</span>
        <span class="bell-col-sub">${b.probability_pct}%</span>
      </div>
    `;
  }).join("");
}

function renderStep3() {
  const bc = state.session?.bell_curve;
  if (!bc) return;

  const stats = bc.stats || {};

  // Compact inline stats summary
  document.getElementById("bellKpiGrid").innerHTML = `
    <span class="kpi-pill"><strong>${bc.total_films}</strong> Films</span>
    <span class="kpi-pill">Mean: <strong>${stats.mean_original !== null ? stats.mean_original.toFixed(2) + "★" : "—"}</strong> &rarr; <strong class="stars-green">${stats.mean_bell !== null ? stats.mean_bell.toFixed(2) + "★" : "—"}</strong></span>
    <span class="kpi-pill"><strong class="stars-green">+${stats.upgraded_count}</strong> Upgraded</span>
    <span class="kpi-pill"><strong class="stars-orange">&minus;${stats.downgraded_count}</strong> Downgraded</span>
    <span class="kpi-pill"><strong>=${stats.unchanged_count}</strong> Unchanged</span>
  `;

  // Render Dual Bar Chart (0.5 to 5.0)
  const buckets = bc.buckets || [];
  document.getElementById("bellCurveChart").innerHTML = renderDistributionChart(buckets);

  // Render Bucket Allocation Mini Table
  const tbody = document.querySelector("#bucketAllocationTable tbody");
  tbody.innerHTML = [...buckets]
    .reverse()
    .map(
      (b) => `
      <tr>
        <td><strong class="stars-green">${b.label}</strong></td>
        <td>${b.probability_pct}%</td>
        <td>${b.original_count}</td>
        <td><strong class="stars-green">${b.bell_count}</strong></td>
      </tr>
    `
    )
    .join("");

  // Filter films for Comparison Table
  const q = state.step3Search.trim().toLowerCase();
  const filteredFilms = (bc.films || []).filter((f) => {
    if (state.step3OnlyChanged && !isFilmRatingChanged(f)) {
      return false;
    }
    if (q) {
      const hay = `${f.title} ${f.year || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  renderBellComparisonTable(filteredFilms);
}

function renderBellComparisonTable(filteredFilms) {
  const tbody = document.getElementById("bellTableBody");
  if (!filteredFilms.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted-meta">No matching films found.</td></tr>`;
    return;
  }

  const limit = state.step3RenderLimit || 300;
  const sliced = filteredFilms.slice(0, limit);

  let html = sliced
    .map(
      (f) => `
      <tr>
        <td><strong>#${f.final_rank}</strong></td>
        <td>${formatRankChangeBadge(f)}</td>
        <td>Top ${(100 - f.percentile).toFixed(1)}%</td>
        <td>
          <a href="${escapeHtml(f.letterboxd_uri)}" target="_blank" rel="noopener noreferrer" class="film-row-title">
            ${escapeHtml(f.title)} ${f.year ? `<span class="muted-meta">(${f.year})</span>` : ""} ${f.is_added ? '<span class="delta-pill delta-up">NEW</span>' : ""}
          </a>
        </td>
        <td><span class="stars-orange">${escapeHtml(formatStars(f.original_rating))}</span></td>
        <td><strong class="stars-green">${escapeHtml(f.bell_stars)}</strong></td>
        <td>${formatDeltaBadge(f.rating_delta, f.original_rating)}</td>
        <td>${f.continuous_bell_score.toFixed(2)}★</td>
        <td>${f.z_score >= 0 ? "+" : ""}${f.z_score.toFixed(2)}&sigma;</td>
      </tr>
    `
    )
    .join("");

  if (filteredFilms.length > limit) {
    const rem = filteredFilms.length - limit;
    html += `
      <tr>
        <td colspan="9" style="text-align: center; padding: 12px;">
          <button type="button" class="btn btn-secondary btn-sm" id="step3LoadMoreBtn">
            Show Next ${Math.min(500, rem)} (${rem} remaining)
          </button>
          <button type="button" class="btn btn-ghost btn-sm" id="step3LoadAllBtn" style="margin-left: 8px;">
            Show All ${filteredFilms.length}
          </button>
        </td>
      </tr>
    `;
  }

  tbody.innerHTML = html;

  const moreBtn = document.getElementById("step3LoadMoreBtn");
  if (moreBtn) {
    moreBtn.addEventListener("click", () => {
      state.step3RenderLimit = (state.step3RenderLimit || 300) + 500;
      renderBellComparisonTable(filteredFilms);
    });
  }
  const allBtn = document.getElementById("step3LoadAllBtn");
  if (allBtn) {
    allBtn.addEventListener("click", () => {
      state.step3RenderLimit = filteredFilms.length;
      renderBellComparisonTable(filteredFilms);
    });
  }
}

// ---------------------------------------------------------------------------
// Event Wiring on DOMContentLoaded
// ---------------------------------------------------------------------------

function switchStep(stepId) {
  state.activeStep = stepId;
  document.querySelectorAll("[data-step]").forEach((t) => {
    t.classList.toggle("active", t.dataset.step === stepId);
  });
  document.getElementById("step2Panel").classList.toggle("hidden", stepId !== "step2");
  document.getElementById("step3Panel").classList.toggle("hidden", stepId !== "step3");
  renderAll();
}

document.addEventListener("DOMContentLoaded", () => {
  loadSavedSessionsList();

  // Top-level App Mode Switcher (+ Add Movie vs Full List Mode)
  document.querySelectorAll("[data-appmode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchAppMode(btn.dataset.appmode);
    });
  });

  // Persistent Top-Bar Username Lookup / Re-sync Form (single button, works in both modes)
  document.getElementById("usernameInput").addEventListener("input", () => {
    updateLookupButtonState();
  });

  document.getElementById("mobileProfileBtn").addEventListener("click", toggleMobileProfile);

  document.getElementById("lookupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = document.getElementById("usernameInput").value.trim();
    if (!u) return;
    const typedUser = normalizeUsernameClient(u);
    const loadedUser = normalizeUsernameClient(state.session?.username || "");
    const shouldForceRefresh = Boolean(loadedUser && typedUser === loadedUser);
    await startLookup(u, shouldForceRefresh);
  });

  document.getElementById("profileSetupOpenFullBtn").addEventListener("click", () => {
    switchAppMode("full");
    switchStep("step2");
  });

  document.getElementById("profileSetupContinueBtn").addEventListener(
    "click", skipProfileSetupForCurrentSession
  );
  document.getElementById("profileSetupResyncBtn").addEventListener("click", resyncProfileSetup);

  // Add Movie Form
  document.getElementById("addMovieForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = document.getElementById("usernameInput").value.trim();
    const movieQuery = document.getElementById("newMovieInput").value.trim();
    if (!u) {
      showError("Please enter your Letterboxd username in the top bar first.");
      document.getElementById("usernameInput").focus();
      return;
    }

    const currentUsername = state.session?.username || "";
    if (!state.session || currentUsername.toLowerCase() !== u.toLowerCase().replace(/^@/, "")) {
      const loaded = await startLookup(u, false);
      if (!loaded) return;
    }

    if (isProfileSetupRequired()) {
      showError("Your rating distribution does not match the bell curve yet. Open Full List Mode to sort and update your ratings, or choose Ignore to continue.");
      return;
    }

    if (movieQuery) {
      await resolveAndStartAddMovie(movieQuery);
    }
  });

  // Add Movie Binary Search buttons
  document.getElementById("addBattleLeftBtn").addEventListener("click", () => {
    handleAddMovieBinaryPick(true);
  });

  document.getElementById("addBattleRightBtn").addEventListener("click", () => {
    handleAddMovieBinaryPick(false);
  });

  document.getElementById("addBinaryUndoBtn").addEventListener("click", () => {
    undoAddMovieBinaryStep();
  });

  document.getElementById("addBinaryRestartBtn").addEventListener("click", () => {
    if (state.addMovie.selectedCandidate) {
      beginAddMovieBinarySearch(state.addMovie.selectedCandidate);
    }
  });

  document.getElementById("showAllPreexistingToggle").addEventListener("change", (e) => {
    state.addMovie.showAllPreexisting = e.target.checked;
    renderAddMovieMode();
  });

  document.getElementById("redoAddMovieBtn").addEventListener("click", redoAddMovieRating);

  document.getElementById("rateAnotherMovieBtn").addEventListener("click", () => {
    state.addMovie.binary = null;
    state.addMovie.result = null;
    state.addMovie.candidates = [];
    renderCandidateStrip([], null);
    renderAll();
    const inp = document.getElementById("newMovieInput");
    if (inp) {
      inp.value = "";
      if (!isProfileSetupRequired()) inp.focus();
    }
  });

  document.getElementById("switchToFullListFromResultBtn").addEventListener("click", () => {
    switchAppMode("full");
  });

  // Step navigation
  document.querySelectorAll("[data-step]").forEach((tab) => {
    tab.addEventListener("click", () => switchStep(tab.dataset.step));
  });

  // Step 2 reset
  document.getElementById("resetOrderBtn").addEventListener("click", async () => {
    if (!state.session) return;
    const confirmed = window.confirm(
      "Are you sure you want to reset your manual movie order back to your original Letterboxd rating sort?"
    );
    if (!confirmed) return;

    const res = await fetch("/api/save-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: state.session.username,
        reset_to_rating_sort: true,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      state.battle.binaryState = null;
      state.battle.lastPlacedMessage = null;
      applySession(data.session);
    }
  });

  // Step 2 submode toggle (List vs Single-Film Binary Search)
  document.querySelectorAll("[data-sortmode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSortMode(btn.dataset.sortmode);
      if (state.sortMode === "tournament") loadTournamentDraft();
      if (state.sortMode === "battle") {
        ensureBattlePair();
        renderBattleArena();
      } else if (state.sortMode === "tournament") {
        renderTournament();
      }
    });
  });

  document.getElementById("tournamentStartBtn").addEventListener("click", () => {
    if (!state.session || state.session.bell_curve.films.length < 2) {
      showError("Load at least two movies to start a tournament.");
      return;
    }
    showError(null);
    state.tournamentApplied = null;
    state.tournament = TournamentSort.start(
      state.session.username, state.session.bell_curve.films.map((film) => film.slug)
    );
    saveTournamentDraft();
    renderTournament();
  });

  document.getElementById("tournamentCancelBtn").addEventListener("click", () => {
    if (!state.tournament || !window.confirm("Discard your unfinished tournament?")) return;
    try {
      window.localStorage.removeItem(tournamentDraftKey(state.tournament.username));
    } catch (err) {
      showError(`Could not discard saved tournament: ${err.message}`);
      return;
    }
    state.tournament = null;
    renderTournament();
  });

  document.getElementById("tournamentLeftBtn").addEventListener("click", () => chooseTournament(0));
  document.getElementById("tournamentRightBtn").addEventListener("click", () => chooseTournament(1));
  document.getElementById("tournamentBackBtn").addEventListener("click", undoTournamentChoice);
  document.getElementById("tournamentApplyBtn").addEventListener("click", applyTournament);

  // Single-Film Binary Search controls
  document.getElementById("binaryTargetFilmSelect").addEventListener("change", (e) => {
    startBinarySearchForFilm(e.target.value, true);
    renderBattleArena();
  });

  document.getElementById("binaryRandomFilmBtn").addEventListener("click", () => {
    const films = state.session?.bell_curve?.films || [];
    if (!films.length) return;
    const randomFilm = films[Math.floor(Math.random() * films.length)];
    startBinarySearchForFilm(randomFilm.slug, true);
    renderBattleArena();
  });

  document.getElementById("binaryRestartBtn").addEventListener("click", () => {
    const sel = document.getElementById("binaryTargetFilmSelect");
    if (sel && sel.value) {
      startBinarySearchForFilm(sel.value, true);
      renderBattleArena();
    }
  });
  document.getElementById("binaryBackBtn").addEventListener("click", undoBattleChoice);

  document.getElementById("battleLeftBtn").addEventListener("click", () => {
    if (state.battle.leftSlug) handleBattleChoice(state.battle.leftSlug);
  });

  document.getElementById("battleRightBtn").addEventListener("click", () => {
    if (state.battle.rightSlug) handleBattleChoice(state.battle.rightSlug);
  });

  // Keyboard shortcuts for Binary Search (both Add Movie mode & Full List mode)
  window.addEventListener("keydown", (e) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;

    if (state.appMode === "add" && state.addMovie.binary) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleAddMovieBinaryPick(true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleAddMovieBinaryPick(false);
      } else if (e.key === "z" || e.key === "Z" || e.key === "Backspace") {
        e.preventDefault();
        undoAddMovieBinaryStep();
      }
      return;
    }

    if (state.appMode === "full" && state.activeStep === "step2" && state.sortMode === "battle") {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (state.battle.leftSlug) handleBattleChoice(state.battle.leftSlug);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (state.battle.rightSlug) handleBattleChoice(state.battle.rightSlug);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        undoBattleChoice();
      }
    } else if (state.appMode === "full" && state.activeStep === "step2" &&
               state.sortMode === "tournament") {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        chooseTournament(e.key === "ArrowLeft" ? 0 : 1);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        undoTournamentChoice();
      }
    }
  });

  // Step 3 Bell Curve Sliders
  document.getElementById("meanSlider").addEventListener("input", (e) => {
    if (!state.session) return;
    const val = parseFloat(e.target.value);
    state.session.settings.mean = val;
    document.getElementById("meanValueDisplay").textContent = `${val.toFixed(2)}★`;
    renderAll();
    schedulePersistOrder();
  });

  document.getElementById("stdSlider").addEventListener("input", (e) => {
    if (!state.session) return;
    const val = parseFloat(e.target.value);
    state.session.settings.std_dev = val;
    document.getElementById("stdValueDisplay").textContent = `${val.toFixed(2)}★`;
    renderAll();
    schedulePersistOrder();
  });

  document.getElementById("resetCurveParamsBtn").addEventListener("click", () => {
    if (!state.session) return;
    state.session.settings.mean = 2.75;
    state.session.settings.std_dev = 1.0;
    document.getElementById("meanSlider").value = "2.75";
    document.getElementById("meanValueDisplay").textContent = "2.75★";
    document.getElementById("stdSlider").value = "1.00";
    document.getElementById("stdValueDisplay").textContent = "1.00★";
    renderAll();
    schedulePersistOrder();
  });

  document.getElementById("step3OnlyChangedToggle").addEventListener("change", (e) => {
    state.step3OnlyChanged = e.target.checked;
    renderStep3();
  });

  document.getElementById("step3SearchInput").addEventListener("input", (e) => {
    state.step3Search = e.target.value;
    renderStep3();
  });

});
