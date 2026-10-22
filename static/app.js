/* LTRBX // Preference-Weighted Rating Curve Frontend */

const STAR_BUCKETS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
const DEFAULT_CENTER = 2.75;
const DEFAULT_BIAS = 0;
const DEFAULT_SPREAD = 1.0;
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
    binary: null, // { film, others, low, high, mid, step, maxSteps, history, preInsertNormalBySlug }
    result: null, // { film, finalRank, totalAfter, normalRating, normalStars, boundaryAdjustments, preexistingAdjustments }
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

function resetToStandardCurve() {
  if (!state.session) return;
  state.session.settings.mean = DEFAULT_CENTER;
  state.session.settings.bias = DEFAULT_BIAS;
  state.session.settings.std_dev = DEFAULT_SPREAD;
  document.getElementById("meanSlider").value = DEFAULT_CENTER.toFixed(2);
  document.getElementById("meanValueDisplay").textContent = `${DEFAULT_CENTER.toFixed(2)}★`;
  document.getElementById("biasSlider").value = DEFAULT_BIAS.toFixed(1);
  document.getElementById("biasValueDisplay").textContent = DEFAULT_BIAS.toFixed(1);
  document.getElementById("stdSlider").value = DEFAULT_SPREAD.toFixed(2);
  document.getElementById("stdValueDisplay").textContent = `${DEFAULT_SPREAD.toFixed(2)}★`;
  renderAll();
  schedulePersistOrder();
}

function validateCurveSettings(mean, bias, spread) {
  if (![mean, bias, spread].every(Number.isFinite) ||
      mean < 2 || mean > 3.5 || bias < 0 || bias > 3 ||
      spread < 0.55 || spread > 1.6) {
    throw new Error("Center must be 2–3.5, bias 0–3 and spread 0.55–1.6.");
  }
}

function curveWeight(rating, mean, bias, spread) {
  const gaussian = Math.exp(-0.5 * ((rating - mean) / spread) ** 2);
  return bias === 0 ? gaussian : gaussian / (1 + Math.exp(-bias * (rating - mean)));
}

function curveProbabilities(mean, bias, spread) {
  validateCurveSettings(mean, bias, spread);
  const weights = STAR_BUCKETS.map((rating) => curveWeight(rating, mean, bias, spread));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function weightedQuantileGrid(mean, bias, spread) {
  const start = mean - 8 * spread;
  const step = 16 * spread / 1024;
  const cdf = [0];
  let previous = curveWeight(start, mean, bias, spread);
  for (let i = 1; i <= 1024; i++) {
    const current = curveWeight(start + i * step, mean, bias, spread);
    cdf.push(cdf.at(-1) + (previous + current) * step / 2);
    previous = current;
  }
  return { start, step, cdf };
}

function weightedPpf({ start, step, cdf }, quantile) {
  const target = quantile * cdf.at(-1);
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (cdf[mid] < target) low = mid + 1;
    else high = mid;
  }
  const index = Math.max(0, Math.min(low - 1, cdf.length - 2));
  const fraction = (target - cdf[index]) / (cdf[index + 1] - cdf[index]);
  return start + (index + fraction) * step;
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

function recomputeNormalCurveClientSide() {
  if (!state.session || !state.session.normal_curve) return;
  const films = state.session.normal_curve.films || [];
  const n = films.length;
  const mean = Number(state.session.settings.mean ?? DEFAULT_CENTER);
  const bias = Number(state.session.settings.bias ?? DEFAULT_BIAS);
  const stdDev = Number(state.session.settings.std_dev ?? DEFAULT_SPREAD);
  const chances = curveProbabilities(mean, bias, stdDev);
  const grid = bias ? weightedQuantileGrid(mean, bias, stdDev) : null;

  const probs = {};
  STAR_BUCKETS.forEach((b, i) => { probs[b.toFixed(1)] = chances[i]; });

  // Allocate integer counts across 10 buckets
  const counts = {};
  if (n === 0) {
    for (const b of STAR_BUCKETS) counts[b.toFixed(1)] = 0;
  } else if (bias === 0 && Math.abs(mean - DEFAULT_CENTER) < 1e-9) {
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
  const normalVals = [];

  films.forEach((film, idx) => {
    const rank = idx + 1;
    const normalRating = tierSeq[idx] !== undefined ? tierSeq[idx] : 0.5;
    normalVals.push(normalRating);

    const q = n > 0 ? (n - rank + 0.5) / n : 0.5;
    const z = normPpf(q);
    const cont = Math.max(0.5, Math.min(5, grid ? weightedPpf(grid, q) : mean + z * stdDev));
    const pct = n > 1 ? Number((((n - rank) / (n - 1)) * 100).toFixed(1)) : 100.0;

    film.final_rank = rank;
    film.percentile = pct;
    film.z_score = Number(z.toFixed(2));
    film.continuous_normal_score = Number(cont.toFixed(2));
    film.normal_rating = normalRating;
    film.normal_stars = formatStars(normalRating);

    if (film.original_rating !== null && film.original_rating !== undefined) {
      const o = Number(film.original_rating);
      origVals.push(o);
      const ok = o.toFixed(1);
      if (origDist[ok] !== undefined) origDist[ok] += 1;
      const delta = Number((normalRating - o).toFixed(1));
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
  const meanNormal = avg(normalVals);

  state.session.normal_curve.total_films = n;
  state.session.normal_curve.parameters = { mean, bias, std_dev: stdDev };
  state.session.normal_curve.stats = {
    mean_original: meanOrig !== null ? Number(meanOrig.toFixed(2)) : null,
    mean_normal: meanNormal !== null ? Number(meanNormal.toFixed(2)) : null,
    rating_inflation:
      meanOrig !== null && meanNormal !== null
        ? Number((meanOrig - meanNormal).toFixed(2))
        : null,
    upgraded_count: upgraded,
    downgraded_count: downgraded,
    unchanged_count: unchanged,
    unrated_count: unrated,
  };
  state.session.normal_curve.buckets = STAR_BUCKETS.map((b) => {
    const k = b.toFixed(1);
    return {
      rating: b,
      label: STAR_LABELS[k],
      probability_pct: Number((probs[k] * 100).toFixed(2)),
      original_count: origDist[k] || 0,
      normal_count: counts[k] || 0,
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
    state.saveTimer = null;
    try {
      const slugs = state.session.normal_curve.films.map((f) => f.slug);
      const payload = {
        username: state.session.username,
        ordered_slugs: slugs,
        include_unrated: state.session.settings.include_unrated,
        mean: state.session.settings.mean,
        bias: state.session.settings.bias,
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

let tournamentNoticeTimer;

function showTournamentError(message) {
  const notice = document.getElementById("tournamentNotice");
  clearTimeout(tournamentNoticeTimer);
  notice.textContent = message || "";
  notice.classList.toggle("hidden", !message);
  if (message) {
    tournamentNoticeTimer = setTimeout(() => showTournamentError(null), 4500);
  }
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
    btn.innerHTML = '<span class="lookup-desktop-label">&#x21bb; Re-sync (Keeps Order)</span>';
    btn.dataset.mobileLabel = "Resync";
    btn.title =
      "Re-sync new watched movies & ratings from Letterboxd without changing your existing manual sort order";
  } else {
    btn.innerHTML = '<span class="lookup-desktop-label">Load Profile</span>';
    btn.dataset.mobileLabel = "Load";
    btn.title = "Load watched movies for this Letterboxd username";
  }
}

function confirmAction(title, message, actionLabel) {
  const dialog = document.getElementById("confirmDialog");
  document.getElementById("confirmDialogTitle").textContent = title;
  document.getElementById("confirmDialogMessage").textContent = message;
  document.getElementById("confirmDialogAction").textContent = actionLabel;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function updateUnratedOptions(sessionData) {
  const hasUnrated = sessionData.unrated_films_count > 0;
  for (const [optionId, checkboxId] of [
    ["desktopUnratedOption", "desktopIncludeUnrated"],
    ["mobileUnratedOption", "mobileIncludeUnrated"],
  ]) {
    document.getElementById(optionId).classList.toggle("hidden", !hasUnrated);
    document.getElementById(checkboxId).checked = Boolean(sessionData.settings.include_unrated);
  }
}

async function changeIncludeUnrated(includeUnrated) {
  if (!state.session || includeUnrated === Boolean(state.session.settings.include_unrated)) return;
  const session = state.session;
  const hadPendingSave = state.saveTimer !== null;
  if (hadPendingSave) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }
  const checkboxes = ["desktopIncludeUnrated", "mobileIncludeUnrated"]
    .map((id) => document.getElementById(id));
  checkboxes.forEach((checkbox) => { checkbox.disabled = true; });
  setSaveStatus("Saving...");
  showError(null);
  try {
    const res = await fetch("/api/save-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: session.username,
        include_unrated: includeUnrated,
        ordered_slugs: session.normal_curve.films.map((film) => film.slug),
        mean: session.settings.mean,
        bias: session.settings.bias,
        std_dev: session.settings.std_dev,
        comparisons_done: session.settings.comparisons_done || 0,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.session) {
      throw new Error(data.error || "Could not update unrated films.");
    }
    if (state.session === session) applySession(data.session);
  } catch (err) {
    if (state.session === session) {
      updateUnratedOptions(session);
      setSaveStatus("Save Error");
      showError(err.message || String(err));
      if (hadPendingSave) schedulePersistOrder();
    }
  } finally {
    checkboxes.forEach((checkbox) => { checkbox.disabled = false; });
  }
}

function completeLookupSession(sessionData) {
  requireCurrentSession(sessionData);
  applySession(sessionData);
  return sessionData;
}

function requireCurrentSession(sessionData) {
  if (!Array.isArray(sessionData?.normal_curve?.films) ||
      !Array.isArray(sessionData.normal_curve.buckets)) {
    throw new Error("This profile uses an outdated format. Refresh the app and re-sync your profile.");
  }
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
    Array.isArray(state.session.normal_curve?.films)
      ? state.session.normal_curve.films.map((f) => f.slug)
      : undefined;
  const currentSettings = forceRefresh && currentSlugs
    ? {
        mean: state.session.settings.mean,
        bias: state.session.settings.bias,
        std_dev: state.session.settings.std_dev,
      }
    : {};

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
        ...currentSettings,
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
  if (mode !== "full") clearSortFollowSpace();
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
  requireCurrentSession(sessionData);
  clearSortFollowSpace();
  state.session = sessionData;
  updateUnratedOptions(sessionData);
  if (state.tournamentApplied && (
    state.tournamentApplied.username !== sessionData.username ||
    !Array.isArray(sessionData.normal_curve?.films) ||
    state.tournamentApplied.slugs.length !== sessionData.normal_curve.films.length ||
    state.tournamentApplied.slugs.some((slug, i) => slug !== sessionData.normal_curve.films[i].slug)
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
    state.tournament, sessionData.username, sessionData.normal_curve.films.map((film) => film.slug)
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
  const mean = Number(sessionData.settings?.mean ?? DEFAULT_CENTER);
  const bias = Number(sessionData.settings?.bias ?? DEFAULT_BIAS);
  const stdDev = Number(sessionData.settings?.std_dev ?? DEFAULT_SPREAD);
  document.getElementById("meanSlider").value = mean.toFixed(2);
  document.getElementById("meanValueDisplay").textContent = `${mean.toFixed(2)}★`;
  document.getElementById("biasSlider").value = bias.toFixed(1);
  document.getElementById("biasValueDisplay").textContent = bias.toFixed(1);
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
  recomputeNormalCurveClientSide();
  renderAddMovieMode();
  renderStep2();
  renderStep3();
}

async function resolveAndStartAddMovie(movieQuery) {
  if (!state.session) return;
  const cleanQuery = movieQuery.trim();
  if (!cleanQuery) {
    showError("Enter a movie title to rank and add to your rating curve.");
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
  recomputeNormalCurveClientSide();
  const currentFilms = state.session.normal_curve?.films || [];

  // Snapshot pre-insertion normal-curve rating for each film in the user's profile
  const others = currentFilms.filter((f) => f.slug !== filmCandidate.slug);
  const preInsertNormalBySlug = {};
  others.forEach((f, idx) => {
    preInsertNormalBySlug[f.slug] = {
      normal_rating: Number(f.normal_rating),
      normal_stars: f.normal_stars,
      rank: idx + 1,
    };
  });

  if (others.length === 0) {
    finishAddMoviePlacement(filmCandidate, [], 0, preInsertNormalBySlug);
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
    preInsertNormalBySlug,
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
    finishAddMoviePlacement(b.film, b.others, b.low, b.preInsertNormalBySlug);
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

function finishAddMoviePlacement(newFilm, othersList, insertIdx, preInsertNormalBySlug) {
  const updatedList = [...othersList];
  const insertedFilm = {
    ...newFilm,
    is_added: true,
    initial_rating_rank: insertIdx + 1,
  };
  updatedList.splice(insertIdx, 0, insertedFilm);

  state.session.normal_curve.films = updatedList;
  recomputeNormalCurveClientSide();

  const placed = state.session.normal_curve.films.find((f) => f.slug === insertedFilm.slug);
  if (placed) {
    // Assign the newly computed normal-curve rating as the movie's rating in the list
    placed.original_rating = placed.normal_rating;
    placed.original_stars = placed.normal_stars;
    recomputeNormalCurveClientSide();
  }

  // Compare before vs after to see which existing movies need rating adjustments to keep the target curve
  const boundaryAdjustments = [];
  const preexistingAdjustments = [];

  state.session.normal_curve.films.forEach((f) => {
    if (f.slug === insertedFilm.slug) return;
    const pre = preInsertNormalBySlug[f.slug];
    const newNormal = Number(f.normal_rating);
    const orig = f.original_rating !== null && f.original_rating !== undefined ? Number(f.original_rating) : null;

    const shiftedByInsertion = pre && Math.abs(newNormal - pre.normal_rating) > 1e-4;
    const differsFromLetterboxd = orig === null || Math.abs(newNormal - orig) > 1e-4;

    if (shiftedByInsertion) {
      boundaryAdjustments.push({
        film: f,
        fromRating: pre.normal_rating,
        fromStars: pre.normal_stars,
        toRating: newNormal,
        toStars: f.normal_stars,
        origRating: orig,
        origStars: formatStars(orig),
        reason: "boundary",
      });
    } else if (differsFromLetterboxd) {
      preexistingAdjustments.push({
        film: f,
        fromRating: orig,
        fromStars: formatStars(orig),
        toRating: newNormal,
        toStars: f.normal_stars,
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
    totalAfter: state.session.normal_curve.films.length,
    normalRating: placed ? placed.normal_rating : 3.0,
    normalStars: placed ? placed.normal_stars : "★★★",
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
    const buckets = state.session.normal_curve.buckets;
    const filmCount = state.session.normal_curve.films.length;
    document.getElementById("profileSetupSummary").textContent =
      `This AI slop website shapes your star ratings into a math curve. Rank the ${filmCount} movies you've seen from #1 to #${filmCount}, and this site will redistribute them into star-rating buckets.`;
    document.getElementById("profileSetupChart").innerHTML =
      renderDistributionChart(buckets, state.session.normal_curve.parameters);
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
        <span class="verdict-stars">${escapeHtml(res.normalStars)}</span>
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
        &#x2713; <strong>No other movies shifted tiers!</strong> Adding <em>${escapeHtml(f.title)}</em> at #${res.finalRank} keeps your rating curve balanced without changing any boundary movie.${escapeHtml(extraNote)}
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
            <th>New Normal-Curve Rating</th>
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
  const films = s.normal_curve?.films || [];

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
  if (mode !== "list") clearSortFollowSpace();
  if (mode !== "tournament") showTournamentError(null);
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
    showTournamentError(`Could not save tournament progress: ${err.message}`);
  }
}

function loadTournamentDraft() {
  if (!state.session || state.tournament) return;
  try {
    const stored = window.localStorage.getItem(tournamentDraftKey(state.session.username));
    if (!stored) return;
    const draft = JSON.parse(stored);
    const slugs = state.session.normal_curve.films.map((film) => film.slug);
    if (draft.username !== state.session.username) {
      showTournamentError("This saved tournament belongs to a different Letterboxd user. Start a new tournament.");
      return;
    }
    if (!TournamentSort.matches(draft, state.session.username, slugs)) {
      showTournamentError("Your film list has changed since this tournament started. Start a new tournament.");
      return;
    }
    if (!Array.isArray(draft.lists) || !Array.isArray(draft.nextLists) ||
        !Array.isArray(draft.merged) || !Number.isInteger(draft.comparisons) ||
        !TournamentSort.pair(draft) && draft.lists.length !== 1) {
      throw new Error("Invalid saved tournament data.");
    }
    if (!draft.undoBase || !Array.isArray(draft.history)) {
      TournamentSort.enableUndo(draft);
      showTournamentError("This tournament predates Back. You can undo new picks, or restart to undo from the beginning.");
    }
    state.tournament = draft;
    saveTournamentDraft();
  } catch (err) {
    showTournamentError(`Could not resume tournament: ${err.message}`);
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
  const films = new Map(state.session.normal_curve.films.map((film) => [film.slug, film]));
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
  const films = state.session.normal_curve.films;
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
    draft, state.session.username, state.session.normal_curve.films.map((film) => film.slug)
  )) {
    showTournamentError("The movie list changed. Discard this tournament and start again.");
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
  const slugs = state.session.normal_curve.films.map((film) => film.slug);
  if (!TournamentSort.matches(draft, state.session.username, slugs)) {
    showTournamentError("The movie list changed. Discard this tournament and start again.");
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
        bias: state.session.settings.bias,
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
    showTournamentError(null);
    applySession(data.session);
    state.tournamentApplied = {
      username: data.session.username,
      slugs: data.session.normal_curve.films.map((film) => film.slug),
      comparisons: draft.comparisons,
    };
    renderTournament();
    if (draftRemovalError) {
      showTournamentError(`Order applied, but could not remove the saved draft: ${draftRemovalError.message}`);
    }
  } catch (err) {
    showTournamentError(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

function renderStep2List() {
  const films = state.session?.normal_curve?.films || [];

  const listEl = document.getElementById("manualSortList");
  if (!films.length) {
    listEl.innerHTML = `<p class="muted-meta" style="padding: 16px;">No films loaded.</p>`;
    return;
  }

  // Precompute master rank range and count for each Normal-Curve target rating tier
  const tierStats = {};
  const buckets = state.session?.normal_curve?.buckets || [];
  buckets.forEach((b) => {
    tierStats[b.rating.toFixed(1)] = {
      count: b.normal_count,
      pct: b.probability_pct,
      minRank: null,
      maxRank: null,
    };
  });
  films.forEach((f) => {
    const k = Number(f.normal_rating).toFixed(1);
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
    const tierKey = Number(f.normal_rating).toFixed(1);
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
            <span class="tier-separator-badge">${escapeHtml(f.normal_stars)}</span>
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

        <div class="sort-row-ratings">
          <div class="orig-rating-cell" title="Original Rating">
            <span class="mobile-cell-label">Orig:</span>
            <span class="stars-orange">${escapeHtml(formatStars(f.original_rating))}</span>
          </div>

          <div class="normal-rating-cell" title="Normal-Curve Target">
            <span class="mobile-cell-label">Normal:</span>
            <span class="stars-green">${escapeHtml(f.normal_stars)}</span>
          </div>
        </div>

        <div class="row-controls">
          <button type="button" class="icon-btn btn-rating-up" data-action="rating-up" data-slug="${escapeHtml(f.slug)}" title="Move UP 1 rating tier (places at bottom of higher ★ tier)">+&starf;<span class="btn-label-text"> Up</span></button>
          <button type="button" class="icon-btn btn-rating-down" data-action="rating-down" data-slug="${escapeHtml(f.slug)}" title="Move DOWN 1 rating tier (places at top of lower ★ tier)">&minus;&starf;<span class="btn-label-text"> Down</span></button>
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

function hideGoToMovieSuggestions() {
  const suggestions = document.getElementById("goToMovieSuggestions");
  suggestions.classList.add("hidden");
  document.getElementById("goToMovieInput").setAttribute("aria-expanded", "false");
}

function showGoToMovieSuggestions() {
  const input = document.getElementById("goToMovieInput");
  const query = input.value.trim().toLowerCase();
  if (!query || !state.session) {
    hideGoToMovieSuggestions();
    return;
  }
  const films = state.session.normal_curve.films
    .filter((film) => film.title.toLowerCase().includes(query))
    .slice(0, 8);
  const suggestions = document.getElementById("goToMovieSuggestions");
  suggestions.innerHTML = films.map((film) => `
    <button type="button" data-slug="${escapeHtml(film.slug)}">
      ${escapeHtml(film.title)}${film.year ? ` (${escapeHtml(film.year)})` : ""}
    </button>
  `).join("");
  suggestions.classList.toggle("hidden", films.length === 0);
  input.setAttribute("aria-expanded", String(films.length > 0));
}

function scrollToMovie(film) {
  const input = document.getElementById("goToMovieInput");
  const films = state.session.normal_curve.films;
  input.value = `${film.title}${film.year ? ` (${film.year})` : ""}`;
  hideGoToMovieSuggestions();
  input.setCustomValidity("");
  const index = films.indexOf(film);
  if (index >= (state.step2RenderLimit || 300)) {
    state.step2RenderLimit = index + 1;
    renderStep2List();
  }
  const row = Array.from(document.getElementById("manualSortList").querySelectorAll(".sort-row"))
    .find((item) => item.dataset.slug === film.slug);
  if (!row) throw new Error(`Movie row not rendered for ${film.slug}`);
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ behavior: "smooth", block: "center" });
}

function goToMovie() {
  const input = document.getElementById("goToMovieInput");
  const query = input.value.trim().toLowerCase();
  if (!query || !state.session) return;
  const films = state.session.normal_curve.films;
  const film = films.find((item) => `${item.title} (${item.year || ""})`.toLowerCase() === query)
    || films.find((item) => item.title.toLowerCase() === query)
    || films.find((item) => item.title.toLowerCase().startsWith(query))
    || films.find((item) => item.title.toLowerCase().includes(query));
  if (!film) {
    input.setCustomValidity("No movie found with that title.");
    input.reportValidity();
    return;
  }
  scrollToMovie(film);
}

function moveFilmInMasterList(slug, targetSlug, placeAfter = false) {
  const films = state.session.normal_curve.films;
  const preview = previewFilmMove(films, slug, targetSlug, placeAfter);
  if (!preview || preview.fromIdx === preview.insertAt) return;

  const previousScrollY = window.scrollY;
  if (followMoveFrame !== null) {
    cancelAnimationFrame(followMoveFrame);
    followMoveFrame = null;
  }
  const [moved] = films.splice(preview.fromIdx, 1);
  films.splice(preview.insertAt, 0, moved);

  renderAll();
  keepDropViewport(previousScrollY);
  schedulePersistOrder();
}

let dropViewportFrame = null;

function keepDropViewport(scrollY) {
  if (dropViewportFrame !== null) cancelAnimationFrame(dropViewportFrame);
  const restore = () => {
    const listEl = document.getElementById("manualSortList");
    if (listEl) {
      const shortfall = Math.ceil(scrollY + window.innerHeight - document.documentElement.scrollHeight);
      if (shortfall > 0) {
        listEl.style.paddingBottom = `${(parseFloat(listEl.style.paddingBottom) || 0) + shortfall}px`;
      }
    }
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
  };
  restore();
  let framesRemaining = 2;
  const settle = () => {
    restore();
    if (--framesRemaining > 0) {
      dropViewportFrame = requestAnimationFrame(settle);
    } else {
      dropViewportFrame = null;
    }
  };
  dropViewportFrame = requestAnimationFrame(settle);
}

function previewFilmMove(films, slug, targetSlug, placeAfter) {
  const fromIdx = films.findIndex((f) => f.slug === slug);
  const toIdx = films.findIndex((f) => f.slug === targetSlug);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return null;

  const insertAt = toIdx + (placeAfter ? (fromIdx < toIdx ? 0 : 1) : (fromIdx < toIdx ? -1 : 0));
  const shifts = [];
  for (let i = Math.min(fromIdx, insertAt); i <= Math.max(fromIdx, insertAt); i++) {
    const film = i === insertAt ? films[fromIdx]
      : fromIdx < insertAt ? films[i + 1] : films[i - 1];
    const before = Number(film.normal_rating);
    const after = Number(films[i].normal_rating);
    if (Math.abs(before - after) > 1e-4) {
      shifts.push({ film, before, after });
    }
  }
  return { fromIdx, insertAt, rating: Number(films[insertAt].normal_rating), shifts };
}

function jumpFilmToExactRank(slug, newRank1Based) {
  const films = state.session.normal_curve.films;
  const fromIdx = films.findIndex((f) => f.slug === slug);
  if (fromIdx === -1) return;
  const targetIdx = Math.max(0, Math.min(films.length - 1, Number(newRank1Based) - 1));
  if (fromIdx === targetIdx) return;

  const [moved] = films.splice(fromIdx, 1);
  films.splice(targetIdx, 0, moved);
  if (targetIdx >= (state.step2RenderLimit || 300)) {
    state.step2RenderLimit = targetIdx + 1;
  }
  renderAll();
  schedulePersistOrder();
}

function moveFilmByRatingTier(slug, action) {
  const films = state.session?.normal_curve?.films || [];
  const film = films.find((f) => f.slug === slug);
  if (!film || films.length < 2) return;

  const currRating = Number(film.normal_rating);
  const higherFilms = films.filter((f) => Number(f.normal_rating) > currRating + 1e-4);
  const lowerFilms = films.filter((f) => Number(f.normal_rating) < currRating - 1e-4);

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
  }
}

let followMoveFrame = null;

function clearSortFollowSpace() {
  const listEl = document.getElementById("manualSortList");
  if (listEl?.style) listEl.style.paddingBottom = "";
}

function followMovedFilm(listEl, slug, action, previousTop) {
  if (dropViewportFrame !== null) {
    cancelAnimationFrame(dropViewportFrame);
    dropViewportFrame = null;
  }
  const findRow = () => Array.from(listEl.querySelectorAll(".sort-row"))
    .find((row) => row.dataset.slug === slug);
  const alignRow = () => {
    const row = findRow();
    if (!row) return;
    const distance = row.getBoundingClientRect().top - previousTop;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const extraSpace = Math.ceil(window.scrollY + distance - maxScroll);
    if (extraSpace > 0) {
      listEl.style.paddingBottom = `${(parseFloat(listEl.style.paddingBottom) || 0) + extraSpace}px`;
    }
    if (Math.abs(distance) > 1) window.scrollBy(0, distance);
  };

  alignRow();
  findRow()?.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  if (followMoveFrame !== null) cancelAnimationFrame(followMoveFrame);
  followMoveFrame = requestAnimationFrame(() => {
    followMoveFrame = null;
    if (state.appMode === "full" && state.sortMode === "list") alignRow();
  });
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
    const previousTop = btn.closest(".sort-row").getBoundingClientRect().top;
    moveFilmByRatingTier(slug, action);
    followMovedFilm(listEl, slug, action, previousTop);
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
    r.classList.remove("dragging", "drag-over-top", "drag-over-bottom",
      "drag-rating-up", "drag-rating-down");
    r.removeAttribute("title");
  });
  document.querySelectorAll(".tier-separator.drag-rating-destination, .tier-separator.drag-drop-before").forEach((tier) =>
    tier.classList.remove("drag-rating-destination", "drag-drop-before")
  );
}

function updateDragTargetAtPoint(clientX, clientY) {
  if (!dragController.active) return;
  const listEl = document.getElementById("manualSortList");
  if (!listEl) return;

  const rows = Array.from(listEl.querySelectorAll(".sort-row"));
  if (!rows.length) return;

  rows.forEach((r) => {
    r.classList.remove("drag-over-top", "drag-over-bottom", "drag-rating-up", "drag-rating-down");
    r.removeAttribute("title");
  });
  listEl.querySelectorAll(".tier-separator.drag-rating-destination, .tier-separator.drag-drop-before").forEach((tier) =>
    tier.classList.remove("drag-rating-destination", "drag-drop-before")
  );

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
    ensureDragGhost().classList.add("hidden");
    return;
  }

  const rect = hoveredRow.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const placeAfter = clientY >= midY;

  hoveredRow.classList.toggle("drag-over-top", !placeAfter);
  hoveredRow.classList.toggle("drag-over-bottom", placeAfter);

  dragController.targetSlug = targetSlug;
  dragController.placeAfter = placeAfter;

  const preview = previewFilmMove(
    state.session.normal_curve.films, dragController.slug, targetSlug, placeAfter
  );
  if (!preview) return;
  const movedFilm = state.session.normal_curve.films[preview.fromIdx];
  const otherShifts = preview.shifts.filter(({ film }) => film.slug !== dragController.slug);
  const visibleRows = new Map(rows.map((row) => [row.dataset.slug, row]));
  for (const { film, before, after } of otherShifts) {
    const row = visibleRows.get(film.slug);
    if (!row) continue;
    row.classList.add(after > before ? "drag-rating-up" : "drag-rating-down");
    row.title = `${film.title}: ${formatStars(before)} → ${formatStars(after)}`;
  }
  const destinationStartsTier = preview.insertAt === 0 ||
    Number(state.session.normal_curve.films[preview.insertAt - 1].normal_rating) !== preview.rating;
  const shiftedFilmUp = preview.fromIdx < preview.insertAt &&
    otherShifts.some(({ before, after }) => after > before);
  listEl.querySelectorAll(".tier-separator").forEach((tier) => {
    if (Number(tier.dataset.tierRating) === preview.rating) {
      tier.classList.add("drag-rating-destination");
      if (destinationStartsTier) {
        hoveredRow.classList.remove("drag-over-top", "drag-over-bottom");
        if (!shiftedFilmUp) tier.classList.add("drag-drop-before");
      }
    }
  });

  const ghost = ensureDragGhost();
  ghost.classList.remove("hidden");
  const movedRatingChanged = preview.rating !== Number(movedFilm.normal_rating);
  ghost.innerHTML = `
    <span class="ghost-main"><span class="ghost-tag">Move</span>
      <strong>${escapeHtml(dragController.title)}</strong>
      <span class="ghost-target">&rarr; #${preview.insertAt + 1} · ${escapeHtml(formatStars(preview.rating))}${movedRatingChanged ? ` (was ${escapeHtml(movedFilm.normal_stars)})` : ""}</span>
    </span>
    <span class="ghost-shifts">${otherShifts.length
      ? otherShifts.slice(0, 3).map(({ film, before, after }) =>
        `<span class="ghost-shift ${after > before ? "drag-shift-up" : "drag-shift-down"}">${after > before ? "↑" : "↓"} ${escapeHtml(film.title)}: ${escapeHtml(formatStars(before))} → ${escapeHtml(formatStars(after))}</span>`
      ).join("") + (otherShifts.length > 3 ? `<span>+${otherShifts.length - 3} more rating shifts</span>` : "")
      : "No other ratings change"}</span>
  `;
  const maxX = Math.max(8, window.innerWidth - ghost.offsetWidth - 8);
  const clampedX = Math.min(maxX, Math.max(8, Math.round(clientX + 12)));
  const maxY = Math.max(8, window.innerHeight - ghost.offsetHeight - 8);
  const clampedY = Math.min(maxY, Math.max(8, Math.round(clientY - 28)));
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
  const films = [...(state.session?.normal_curve?.films || [])].sort((a, b) => {
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
  const films = state.session?.normal_curve?.films || [];
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

function startRandomBinarySearchForFilm(excludeSlug = null, clearBanner = true) {
  const films = (state.session?.normal_curve?.films || [])
    .filter((film) => film.slug !== excludeSlug);
  if (!films.length) return;
  const randomFilm = films[Math.floor(Math.random() * films.length)];
  startBinarySearchForFilm(randomFilm.slug, clearBanner);
}

function ensureBattlePair() {
  const films = state.session?.normal_curve?.films || [];
  if (films.length < 2) return;

  if (
    !state.battle.binaryState ||
    !films.some((f) => f.slug === state.battle.binaryState.targetSlug)
  ) {
    startRandomBinarySearchForFilm(null, false);
  }
}

function renderBattleArena() {
  const films = state.session?.normal_curve?.films || [];
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
  const films = state.session?.normal_curve?.films || [];
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
    state.session.normal_curve.films = others;
    recomputeNormalCurveClientSide();

    const placedFilm = state.session.normal_curve.films.find((f) => f.slug === bs.targetSlug);
    const normalStarText = placedFilm ? placedFilm.normal_stars : "";
    state.battle.lastPlacedMessage =
      `✓ Placed "${targetFilm.title}" at #${newRank} (${normalStarText})`;

    populateBinaryTargetSelect();
    startRandomBinarySearchForFilm(bs.targetSlug, false);
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
  const others = state.session.normal_curve.films.filter((film) => film.slug !== bs.targetSlug);
  state.battle.rightSlug = others[bs.mid].slug;
  state.battle.lastPlacedMessage = null;
  renderBattleArena();
}

// ---------------------------------------------------------------------------
// VIEW 2: Rating Curve Chart & Full Ranked Comparison Table
// ---------------------------------------------------------------------------

function isFilmRatingChanged(film) {
  if (film.original_rating === null || film.original_rating === undefined) {
    return true;
  }
  return Math.abs(Number(film.normal_rating) - Number(film.original_rating)) > 1e-4;
}

function hasMatchingDistribution() {
  const buckets = state.session?.normal_curve?.buckets;
  return buckets?.length === STAR_BUCKETS.length &&
    buckets.every((bucket) => bucket.original_count === bucket.normal_count);
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

function renderDistributionChart(buckets, parameters) {
  const maxBar = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.original_count, b.normal_count))
  );
  let curvePath = "";
  if (buckets.length > 1) {
    const { mean, bias, std_dev: spread } = parameters;
    const totalWeight = buckets.reduce(
      (sum, bucket) => sum + curveWeight(bucket.rating, mean, bias, spread), 0
    );
    const totalFilms = buckets.reduce((sum, b) => sum + b.normal_count, 0);
    const firstRating = buckets[0].rating;
    const step = (buckets[buckets.length - 1].rating - firstRating) / (buckets.length - 1);
    curvePath = Array.from({ length: 101 }, (_, i) => {
      const rating = firstRating + (i * buckets.length / 100 - 0.5) * step;
      const height = curveWeight(rating, mean, bias, spread) / totalWeight *
        totalFilms / maxBar * 140;
      return `${i === 0 ? "M" : "L"} ${i * 10} ${(140 - height).toFixed(2)}`;
    }).join(" ");
  }
  const curve = curvePath
    ? `<svg class="normal-target-curve" viewBox="0 0 1000 140" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${curvePath}"></path></svg>`
    : "";
  return curve + buckets.map((b) => {
    const hOrig = Math.max(2, Math.round((b.original_count / maxBar) * 140));
    const hNormal = Math.max(2, Math.round((b.normal_count / maxBar) * 140));
    return `
      <div class="normal-col">
        <div class="normal-bars-pair">
          <div class="bar-wrap" title="Original ${b.label}: ${b.original_count} films">
            <span class="bar-count">${b.original_count}</span>
            <div class="bar-orig" style="height: ${hOrig}px"></div>
          </div>
          <div class="bar-wrap" title="Target Curve ${b.label}: ${b.normal_count} films (${b.probability_pct}%)">
            <span class="bar-count" style="color: var(--lb-green)">${b.normal_count}</span>
            <div class="bar-normal" style="height: ${hNormal}px"></div>
          </div>
        </div>
        <span class="normal-col-label">${b.label}</span>
        <span class="normal-col-sub">${b.probability_pct}%</span>
      </div>
    `;
  }).join("");
}

function renderStep3() {
  const bc = state.session?.normal_curve;
  if (!bc) return;

  const stats = bc.stats || {};
  // Compact inline stats summary
  document.getElementById("normalKpiGrid").innerHTML = `
    <span class="kpi-pill"><strong>${bc.total_films}</strong> Films</span>
    <span class="kpi-pill">Mean: <strong>${stats.mean_original !== null ? stats.mean_original.toFixed(2) + "★" : "—"}</strong> &rarr; <strong class="stars-green">${stats.mean_normal !== null ? stats.mean_normal.toFixed(2) + "★" : "—"}</strong></span>
    <span class="kpi-pill"><strong class="stars-green">+${stats.upgraded_count}</strong> Upgraded</span>
    <span class="kpi-pill"><strong class="stars-orange">&minus;${stats.downgraded_count}</strong> Downgraded</span>
    <span class="kpi-pill"><strong>=${stats.unchanged_count}</strong> Unchanged</span>
  `;

  // Render Dual Bar Chart (0.5 to 5.0)
  const buckets = bc.buckets || [];
  document.getElementById("normalCurveChart").innerHTML =
    renderDistributionChart(buckets, bc.parameters);

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
        <td><strong class="stars-green">${b.normal_count}</strong></td>
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

  renderNormalComparisonTable(filteredFilms);
}

function renderNormalComparisonTable(filteredFilms) {
  const tbody = document.getElementById("normalTableBody");
  if (!filteredFilms.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted-meta">No matching films found.</td></tr>`;
    return;
  }

  const limit = state.step3RenderLimit || 300;
  const sliced = filteredFilms.slice(0, limit);

  let html = sliced
    .map((f) => {
      const actions = `
        <button type="button" class="btn btn-ghost btn-sm" data-action="find-in-list" data-slug="${escapeHtml(f.slug)}" aria-label="Find ${escapeHtml(f.title)} in List Sorter">List</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="rate-vs-film" data-slug="${escapeHtml(f.slug)}" aria-label="Rate ${escapeHtml(f.title)} in Single Movie Rate">A vs B</button>
      `;
      return `
      <tr>
        <td><strong>#${f.final_rank}</strong></td>
        <td>Top ${(100 - f.percentile).toFixed(1)}%</td>
        <td>
          <a href="${escapeHtml(f.letterboxd_uri)}" target="_blank" rel="noopener noreferrer" class="film-row-title">
            ${escapeHtml(f.title)} ${f.year ? `<span class="muted-meta">(${f.year})</span>` : ""} ${f.is_added ? '<span class="delta-pill delta-up">NEW</span>' : ""}
          </a>
          <div class="comparison-mobile-actions">${actions}</div>
        </td>
        <td><span class="stars-orange">${escapeHtml(formatStars(f.original_rating))}</span></td>
        <td><strong class="stars-green">${escapeHtml(f.normal_stars)}</strong></td>
        <td>${formatDeltaBadge(f.rating_delta, f.original_rating)}</td>
        <td>${f.continuous_normal_score.toFixed(2)}★</td>
        <td class="comparison-row-actions">${actions}</td>
      </tr>
    `; })
    .join("");

  if (filteredFilms.length > limit) {
    const rem = filteredFilms.length - limit;
    html += `
      <tr>
        <td colspan="8" style="text-align: center; padding: 12px;">
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
      renderNormalComparisonTable(filteredFilms);
    });
  }
  const allBtn = document.getElementById("step3LoadAllBtn");
  if (allBtn) {
    allBtn.addEventListener("click", () => {
      state.step3RenderLimit = filteredFilms.length;
      renderNormalComparisonTable(filteredFilms);
    });
  }
}

function openComparisonFilm(slug, action) {
  const film = state.session?.normal_curve?.films.find((item) => item.slug === slug);
  if (!film) {
    showError("This movie is no longer in the current list.");
    return;
  }
  switchStep("step2");
  if (action === "find-in-list") {
    setSortMode("list");
    scrollToMovie(film);
  } else if (action === "rate-vs-film") {
    setSortMode("battle");
    startBinarySearchForFilm(slug);
    renderBattleArena();
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

  for (const id of ["desktopIncludeUnrated", "mobileIncludeUnrated"]) {
    document.getElementById(id).addEventListener("change", (event) => {
      changeIncludeUnrated(event.target.checked);
    });
  }

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
      showError("Your rating distribution does not match the target curve yet. Open Full List Mode to sort and update your ratings, or choose Ignore to continue.");
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
  document.getElementById("goToMovieForm").addEventListener("submit", (e) => {
    e.preventDefault();
    goToMovie();
  });
  document.getElementById("goToMovieInput").addEventListener("input", (e) => {
    e.target.setCustomValidity("");
    showGoToMovieSuggestions();
  });
  document.getElementById("goToMovieInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      const first = document.querySelector("#goToMovieSuggestions button");
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Escape") {
      hideGoToMovieSuggestions();
    }
  });
  document.getElementById("goToMovieSuggestions").addEventListener("keydown", (e) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") {
      hideGoToMovieSuggestions();
      document.getElementById("goToMovieInput").focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(index + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  });
  document.getElementById("goToMovieSuggestions").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-slug]");
    if (!button) return;
    const film = state.session?.normal_curve?.films.find((item) => item.slug === button.dataset.slug);
    if (film) scrollToMovie(film);
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("goToMovieForm").contains(e.target)) {
      hideGoToMovieSuggestions();
    }
  });

  document.getElementById("resetOrderBtn").addEventListener("click", async () => {
    if (!state.session) return;
    const confirmed = await confirmAction(
      "Reset manual order?",
      "Reset your manual movie order back to your original Letterboxd rating sort?",
      "Reset order"
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
    if (!state.session || state.session.normal_curve.films.length < 2) {
      showTournamentError("Load at least two movies to start a tournament.");
      return;
    }
    showError(null);
    showTournamentError(null);
    state.tournamentApplied = null;
    state.tournament = TournamentSort.start(
      state.session.username, state.session.normal_curve.films.map((film) => film.slug)
    );
    saveTournamentDraft();
    renderTournament();
  });

  document.getElementById("tournamentCancelBtn").addEventListener("click", async () => {
    if (!state.tournament || !await confirmAction(
      "Discard tournament?",
      "Discard your unfinished tournament?",
      "Discard tournament"
    )) return;
    try {
      window.localStorage.removeItem(tournamentDraftKey(state.tournament.username));
    } catch (err) {
      showTournamentError(`Could not discard saved tournament: ${err.message}`);
      return;
    }
    state.tournament = null;
    showTournamentError(null);
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
    startRandomBinarySearchForFilm();
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

  // Step 3 Rating Curve Sliders
  document.getElementById("meanSlider").addEventListener("input", (e) => {
    if (!state.session) return;
    const val = parseFloat(e.target.value);
    state.session.settings.mean = val;
    document.getElementById("meanValueDisplay").textContent = `${val.toFixed(2)}★`;
    renderAll();
    schedulePersistOrder();
  });

  document.getElementById("biasSlider").addEventListener("input", (e) => {
    if (!state.session) return;
    const val = parseFloat(e.target.value);
    state.session.settings.bias = val;
    document.getElementById("biasValueDisplay").textContent = val.toFixed(1);
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

  for (const [id, defaultValue] of [
    ["meanSlider", DEFAULT_CENTER],
    ["biasSlider", DEFAULT_BIAS],
    ["stdSlider", DEFAULT_SPREAD],
  ]) {
    const slider = document.getElementById(id);
    slider.addEventListener("dblclick", () => {
      if (!state.session) return;
      slider.value = String(defaultValue);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  document.getElementById("standardCurveParamsBtn").addEventListener("click", resetToStandardCurve);

  document.getElementById("step3OnlyChangedToggle").addEventListener("change", (e) => {
    state.step3OnlyChanged = e.target.checked;
    renderStep3();
  });

  document.getElementById("step3SearchInput").addEventListener("input", (e) => {
    state.step3Search = e.target.value;
    renderStep3();
  });

  document.getElementById("normalTableBody").addEventListener("click", (e) => {
    const button = e.target.closest("button[data-action][data-slug]");
    if (button) openComparisonFilm(button.dataset.slug, button.dataset.action);
  });

});
