// Mes séries : application Android (Capacitor). Séries et films vus ; données sur le téléphone, fiches et affiches depuis TMDB (en français), TVmaze en secours pour les séries.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { App } from "@capacitor/app";
import { Share } from "@capacitor/share";
import { search as searchShows, match as bestMatch, load as loadShow, toTmdb, refOf, tmdbReady, searchFilms, matchFilm, loadFilm } from "./sources.js";

const $ = (id) => document.getElementById(id);
const state = { series: [], films: [], meta: {}, loaded: false, tab: "lib", detailId: null, detailKind: "series", filter: "all", sort: "recent", fFilter: "all", fSort: "recent", q: "", searchOpen: false, open: {}, listScroll: 0, enrich: null, fEnrich: null, filmOffer: null, impKind: "series" };
const native = Capacitor.isNativePlatform();

// ---------- Outils ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, fill) => `<span class="ms${fill ? " fill" : ""}" aria-hidden="true">${n}</span>`;
const p2 = (n) => String(n).padStart(2, "0");
const code = (s, e) => `S${p2(s)}E${p2(e)}`;
const plural = (n, w) => `${n} ${n > 1 ? w.split(" ").map((x) => x + "s").join(" ") : w}`;
const STATUS = { todo: "À voir", watching: "En cours", done: "Terminée", dropped: "Abandonnée" };
const find = (id) => state.series.find((s) => s.id === id);
const findFilm = (id) => state.films.find((f) => f.id === id);
const FSTATUS = { todo: "À voir", done: "Vu", dropped: "Abandonné" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", opts || { day: "numeric", month: "short" });
const whenLong = (iso) => fmtDate(iso, { weekday: "long", day: "numeric", month: "long", ...(iso.slice(0, 4) !== todayISO().slice(0, 4) ? { year: "numeric" } : {}) });
const fmtLong = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const norm = (v) => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const slug = (t) => (String(t).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "serie") + "-" + Math.random().toString(36).slice(2, 6);
const hue = (t) => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (t) => String(t).replace(/^(le|la|les|l'|the|un|une)\s+/i, "").split(/[\s:’'-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const years = (s) => s.year ? (s.airing ? `depuis ${s.year}` : s.endYear && s.endYear !== s.year ? `${s.year}–${s.endYear}` : `${s.year}`) : "";
function parseUpTo(t) {
  const m = String(t || "").trim().match(/^s?(\d{1,2})\s*[ex×]\s*(\d{1,3})$/i);
  return m ? { s: +m[1], e: +m[2] } : null;
}

// ---------- Réseau ----------
async function getJson(url) {
  if (native) {
    const r = await CapacitorHttp.get({ url, headers: { Accept: "application/json" } });
    if (r.status === 404) return null;
    if (r.status === 429) throw Object.assign(new Error("rate"), { code: "rate_limited" });
    if (r.status >= 400) throw new Error("http " + r.status);
    return typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  }
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (r.status === 429) throw Object.assign(new Error("rate"), { code: "rate_limited" });
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// TVmaze autorise environ 20 appels par 10 secondes : on espace et on réessaie une fois.
async function tv(fn) {
  try { return await fn(); }
  catch (e) { if (e && e.code === "rate_limited") { await sleep(6000); return fn(); } throw e; }
}

// ---------- Affiches (fichiers sur le téléphone) ----------
const posterSrc = {};
async function blobToBase64(blob) {
  return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = ko; r.readAsDataURL(blob); });
}
async function savePoster(s, url) {
  if (!url) return;
  let base64;
  if (native) {
    const r = await CapacitorHttp.get({ url, responseType: "blob" });
    if (r.status >= 400 || !r.data) throw new Error("poster");
    base64 = r.data;
  } else {
    const r = await fetch(url); if (!r.ok) throw new Error("poster");
    base64 = await blobToBase64(await r.blob());
  }
  const path = `posters/${s.id}-${Date.now().toString(36)}.jpg`;
  await Filesystem.writeFile({ path, data: base64, directory: Directory.Data, recursive: true });
  const old = s.poster;
  s.poster = path; delete posterSrc[s.id];
  if (old && old !== path) Filesystem.deleteFile({ path: old, directory: Directory.Data }).catch(() => {});
}
async function resolvePoster(s) {
  if (!s.poster || posterSrc[s.id] !== undefined) return;
  posterSrc[s.id] = null;
  try {
    if (native) { const { uri } = await Filesystem.getUri({ path: s.poster, directory: Directory.Data }); posterSrc[s.id] = Capacitor.convertFileSrc(uri); }
    else { const { data } = await Filesystem.readFile({ path: s.poster, directory: Directory.Data }); posterSrc[s.id] = "data:image/jpeg;base64," + (typeof data === "string" ? data : await blobToBase64(data)); }
    scheduleRender();
  } catch { posterSrc[s.id] = null; }
}
function poster(s, cls = "") {
  const src = s.id ? posterSrc[s.id] : s.posterUrl;
  if (s.id && s.poster && src === undefined) resolvePoster(s);
  return `<div class="poster ${cls}" style="--h:${hue(s.title)}" aria-hidden="true"><b>${esc(initials(s.title))}</b><small>${esc(s.year || "")}</small>${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ""}</div>`;
}

// ---------- Calculs ----------
// Un épisode compte quand il est diffusé (date passée). Sans date, il compte sauf en fin de série en cours (épisode annoncé).
function stats(s) {
  const today = todayISO();
  const seasons = (s.seasons || []).filter((x) => x && x.count > 0);
  const w = s.watched || {};
  let total = 0, seen = 0, next = null, upcoming = null;
  for (const se of seasons) {
    const set = new Set(w["s" + se.n] || []);
    for (let e = 1; e <= se.count; e++) {
      const d = (se.dates || [])[e - 1];
      const isAired = d ? d <= today : !(s.airing && se === seasons[seasons.length - 1] && se.dates && se.dates.some(Boolean));
      if (!isAired) { if (!upcoming && d) upcoming = { s: se.n, e, date: d, title: (se.titles || [])[e - 1] || "" }; continue; }
      total++;
      if (set.has(e)) seen++;
      else if (!next) next = { s: se.n, e, title: (se.titles || [])[e - 1] || "" };
    }
  }
  return { total, seen, next, upcoming, pct: total ? Math.round((seen / total) * 100) : 0, seasons };
}
function bucket(s) {
  if (s.status === "auto") return s.lastSeen && Date.now() - new Date(s.lastSeen) < 365 * 86400000 ? "watching" : "dropped";
  if (s.status === "dropped") return "dropped";
  if (s.status === "done") return "done";
  if (s.status === "watching" || stats(s).seen > 0) return "watching";
  return "todo";
}
function tagFor(s, st) {
  if (s.needsInfo === true) return `<span class="tag">${icon("hourglass_top")}Fiche à compléter</span>${s.status === "done" ? `<span class="tag done">${icon("check")}Vue</span>` : ""}`;
  if (s.needsInfo === "notfound") return `<span class="tag waiting">${icon("help")}Fiche introuvable</span>`;
  if (s.status === "done") return `<span class="tag done">${icon("check")}Terminée</span>`;
  if (s.status === "dropped") return `<span class="tag">Abandonnée</span>`;
  if (s.status === "auto") return `<span class="tag">${icon("hourglass_top")}Fiche à compléter</span>`;
  if (st.total && st.seen === st.total) return `<span class="tag waiting">${icon("schedule")}À jour</span>`;
  if (s.status === "watching") return `<span class="tag watching">En cours</span>`;
  return `<span class="tag">À voir</span>`;
}

// ---------- Stockage ----------
let persistTimer = null;
function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 300); }
async function persist() {
  clearTimeout(persistTimer);
  try {
    await Preferences.set({ key: "series", value: JSON.stringify(state.series) });
    await Preferences.set({ key: "films", value: JSON.stringify(state.films) });
    await Preferences.set({ key: "meta", value: JSON.stringify(state.meta) });
  } catch { snack("Enregistrement impossible : mémoire du téléphone pleine ?"); }
}
async function load() {
  const { value } = await Preferences.get({ key: "series" });
  if (value) state.series = JSON.parse(value);
  else {
    // Premier lancement : reprend les séries de la version web (prototype claude.ai).
    try { const r = await fetch("seed.json"); if (r.ok) state.series = ((await r.json()).series || []).map((s) => ({ ...s, needsInfo: refOf(s) ? s.needsInfo : true })); } catch {}
    await persist();
  }
  try { const m = await Preferences.get({ key: "meta" }); if (m.value) state.meta = JSON.parse(m.value); } catch {}
  // Films (v2) : clé séparée, les séries ne sont pas touchées.
  try { const f = await Preferences.get({ key: "films" }); if (f.value) state.films = JSON.parse(f.value); } catch {}
  try { state.fFilter = (await Preferences.get({ key: "fFilter" })).value || "all"; } catch {}
  try { state.fSort = (await Preferences.get({ key: "fSort" })).value || "recent"; } catch {}
  try { state.filter = (await Preferences.get({ key: "filter" })).value || "all"; } catch {}
  try { state.sort = (await Preferences.get({ key: "sort" })).value || "recent"; } catch {}
  await bundledImports();
  await filmOffer();
  // Passage à TMDB (fiches en français) : chaque fiche TVmaze est convertie une fois ; les introuvables sont recherchées à nouveau.
  if (!state.meta.tmdb && tmdbReady()) {
    for (const s of state.series) {
      if (refOf(s) && !String(refOf(s)).startsWith("tmdb:")) s.tmdbPending = true;
      if (s.needsInfo === "notfound") s.needsInfo = true;
    }
    state.meta.tmdb = 1; await persist();
  }
  state.loaded = true;
}
// Fichiers d'import livrés avec une version de l'appli (ex. historique Netflix) : chacun est importé une seule fois.
// Chaque saison vue sur Netflix coche ses N premiers épisodes ; le statut se décide une fois la fiche connue.
async function bundledImports() {
  let files = [];
  try { const r = await fetch("imports/index.json"); if (r.ok) files = await r.json(); } catch {}
  const done = new Set(state.meta.imports || []);
  for (const f of files) {
    if (done.has(f)) { await importFixes(f); continue; }
    try {
      const r = await fetch("imports/" + f); if (!r.ok) continue;
      const data = await r.json();
      const have = new Set(state.series.flatMap((s) => [norm(s.title), norm(s.originalTitle)]).filter(Boolean));
      let n = 0;
      for (const x of data.series || []) {
        if (!x.title || have.has(norm(x.title)) || (x.searchTitle && have.has(norm(x.searchTitle)))) continue;
        state.series.push(fromImport(x, data.source || f));
        have.add(norm(x.title)); n++;
      }
      state.meta.imports = [...done.add(f)];
      state.meta.importRev = { ...state.meta.importRev, [f]: data.revision || 1 };
      await persist();
      if (n) setTimeout(() => snack(`${plural(n, "série ajoutée")} depuis ${data.source || "l'import"}. Récupération des fiches en cours…`, null, 8000), 800);
    } catch {}
  }
}

function fromImport(x, source) {
  const watched = {}, seasons = [];
  for (const [k, c] of Object.entries(x.seasons || {})) { watched["s" + k] = Array.from({ length: c }, (_, i) => i + 1); seasons.push({ n: +k, count: c }); }
  seasons.sort((a, b) => a.n - b.n);
  return { id: slug(x.title), importWatched: clone(watched), title: x.title, searchTitle: x.searchTitle || undefined, year: x.year || null, status: "auto", rating: 0, seasons, watched, genres: [], cast: [], creators: [], directors: [], needsInfo: true, imported: true, source, lastSeen: x.last, firstSeen: x.first, addedAt: new Date().toISOString(), updatedAt: (x.last || "2000-01-01") + "T12:00:00.000Z" };
}
// Nouvelle révision d'un import déjà fait : les séries de `recheck` (titre de recherche corrigé, mauvaise série
// reconnue) sont recherchées à nouveau sur TVmaze, sauf celles dont Tanguy a choisi la série lui-même.
async function importFixes(f) {
  try {
    const r = await fetch("imports/" + f); if (!r.ok) return;
    const data = await r.json(), rev = data.revision || 1;
    if (rev <= ((state.meta.importRev || {})[f] || 1)) return;
    const byTitle = new Map((data.series || []).map((x) => [norm(x.title), x]));
    // `rechecks` : titres à rechercher à nouveau, par révision ; seules les révisions pas encore appliquées comptent.
    const from = (state.meta.importRev || {})[f] || 1;
    const lists = data.rechecks || { 2: data.recheck || [] };
    const recheck = new Set(Object.entries(lists).filter(([r]) => +r > from).flatMap(([, l]) => l).map(norm));
    // Séries d'une ancienne révision remplacées (ex. « Monstre » scindée en trois séries TVmaze).
    const gone = new Set((data.removed || []).map(norm));
    state.series = state.series.filter((s) => !(s.imported && !s.picked && gone.has(norm(s.title))));
    const have = new Set(state.series.flatMap((s) => [norm(s.title), norm(s.originalTitle)]).filter(Boolean));
    let n = 0;
    for (const x of data.series || []) if (recheck.has(norm(x.title)) && !have.has(norm(x.title))) { state.series.push(fromImport(x, data.source || f)); have.add(norm(x.title)); n++; }
    for (const s of state.series) {
      const x = s.imported && !s.picked && byTitle.get(norm(s.title));
      if (!x) continue;
      if (!s.firstSeen) s.firstSeen = x.first;
      if (!recheck.has(norm(s.title)) || s.needsInfo === true) continue;
      s.searchTitle = x.searchTitle || undefined; s.year = x.year || null; s.needsInfo = true; n++;
    }
    state.meta.importRev = { ...state.meta.importRev, [f]: rev };
    await persist();
    if (n) setTimeout(() => snack(`${plural(n, "fiche importée corrigée")} : nouvelle recherche des fiches…`, null, 6000), 800);
  } catch {}
}
// Remet une fiche importée dans son état d'origine (série introuvable après correction).
function resetImported(s) {
  if (s.poster) Filesystem.deleteFile({ path: s.poster, directory: Directory.Data }).catch(() => {});
  delete posterSrc[s.id];
  s.watched = clone(s.importWatched || {});
  s.seasons = Object.entries(s.watched).map(([k, v]) => ({ n: +k.slice(1), count: v.length })).sort((a, b) => a.n - b.n);
  for (const k of ["tvmazeId", "tmdbId", "ref", "source", "originalTitle", "endYear", "airing", "network", "country", "runtime", "summary", "posterUrl", "posterFrom", "poster", "imdb", "infoAt"]) delete s[k];
  Object.assign(s, { genres: [], cast: [], creators: [], directors: [] });
}

// `user` : action de Tanguy (fait remonter la série dans la liste) ; false pour une mise à jour de fiche.
function touch(s, user = true) {
  if (user) s.updatedAt = new Date().toISOString();
  persistSoon(); render();
}

// ---------- Snackbar ----------
let snackTimer, undoFn = null;
function snack(msg, undo, ms) {
  const el = $("snack"), host = document.querySelector("dialog[open]") || document.body;
  if (el.parentNode !== host) host.appendChild(el);
  $("snackTxt").textContent = msg; undoFn = undo || null; $("snackUndo").hidden = !undo; el.hidden = false;
  clearTimeout(snackTimer); snackTimer = setTimeout(() => { el.hidden = true; undoFn = null; }, ms || (undo ? 6000 : 4000));
}
$("snackUndo").addEventListener("click", () => { const f = undoFn; undoFn = null; $("snack").hidden = true; f && f(); });

// ---------- Cocher ----------
function setSeen(s, season, eps, on) {
  s.watched = s.watched || {};
  const key = "s" + season, set = new Set(s.watched[key] || []);
  for (const e of eps) on ? set.add(e) : set.delete(e);
  s.watched[key] = [...set].sort((a, b) => a - b);
  const st = stats(s);
  let msg = null;
  if (on && st.seen > 0 && s.status === "todo") s.status = "watching";
  if (on && st.total && st.seen === st.total && !s.airing && s.status !== "done") { s.status = "done"; s.finishedAt = todayISO(); msg = `${s.title} terminée. Bravo !`; }
  if (!on && s.status === "done" && st.seen < st.total) s.status = "watching";
  touch(s);
  return msg;
}
function markNext(s) {
  const st = stats(s); if (!st.next) return;
  const before = JSON.stringify([s.watched, s.status]);
  const msg = setSeen(s, st.next.s, [st.next.e], true);
  snack(msg || `${code(st.next.s, st.next.e)} vu · ${s.title}`, () => { const cur = find(s.id); if (!cur) return; const [w, status] = JSON.parse(before); cur.watched = w || {}; cur.status = status; touch(cur); });
}
// Import ou fiche complétée : « terminée » coche tout, « vu jusqu'à » coche jusqu'à l'épisode (seulement si rien n'est coché).
function applyProgress(s) {
  const seasons = (s.seasons || []).filter((x) => x && x.count > 0);
  if (!seasons.length) return;
  const empty = !Object.values(s.watched || {}).some((a) => a && a.length);
  const up = s.upTo ? parseUpTo(s.upTo) : null;
  if (empty && (s.status === "done" || up)) {
    s.watched = {};
    const today = todayISO();
    for (const se of seasons) {
      let n = s.status === "done" || se.n < up.s ? se.count : se.n === up.s ? Math.min(up.e, se.count) : 0;
      if (s.status === "done") while (n > 0 && (se.dates || [])[n - 1] && se.dates[n - 1] > today) n--;
      if (n) s.watched["s" + se.n] = Array.from({ length: n }, (_, i) => i + 1);
    }
  }
  delete s.upTo;
}

// Statut déduit pour les séries importées (historique Netflix) : tout vu → terminée,
// sinon en cours si vue dans l'année, abandonnée au-delà.
function autoStatus(s, byDate) {
  if (s.status !== "auto") return;
  const st = stats(s);
  if (!byDate && st.total && st.seen >= st.total) s.status = s.airing ? "watching" : "done";
  else s.status = s.lastSeen && Date.now() - new Date(s.lastSeen) < 365 * 86400000 ? "watching" : "dropped";
  if (s.status === "done" && s.lastSeen) s.finishedAt = s.lastSeen;
}

// ---------- Vues ----------
function card(s) {
  const st = stats(s);
  const meta = [years(s), s.network, st.seasons.length ? plural(st.seasons.length, "saison") : ""].filter(Boolean).join(" · ");
  const quick = st.next && s.status !== "dropped" && s.status !== "done";
  return `<div class="s-card" role="button" tabindex="0" data-act="open" data-id="${esc(s.id)}">
    ${poster(s)}
    <div class="s-body">
      <div class="s-t">${esc(s.title)}</div>
      <div class="s-sub">${s.rating ? `<span class="s-rate" aria-label="Note ${s.rating} sur 5">★ ${s.rating}</span>${meta ? " · " : ""}` : ""}${esc(meta)}</div>
      <div class="bar" aria-hidden="true"><span style="width:${st.pct}%"></span></div>
      <div class="s-foot"><span class="num">${st.seen} / ${st.total} ép.</span>${tagFor(s, st)}${st.next && s.status === "watching" ? `<span class="code">→ ${code(st.next.s, st.next.e)}</span>` : ""}</div>
    </div>
    ${quick ? `<button class="seen-btn" type="button" data-act="seen" data-id="${esc(s.id)}" aria-label="Marquer ${code(st.next.s, st.next.e)} de ${esc(s.title)} comme vu">${icon("done")}</button>` : ""}
  </div>`;
}
function matches(s) {
  if (state.q) {
    const hay = [s.title, s.originalTitle, s.network, ...(s.cast || []).map((c) => c.name), ...(s.creators || [])].join(" ").toLowerCase();
    if (!hay.includes(state.q)) return false;
  }
  return state.filter === "all" || bucket(s) === state.filter;
}
const loading = () => `<div class="empty"><span class="spinner"></span><span>Chargement de tes séries…</span></div>`;

// Tri de la bibliothèque. « Récentes » garde le regroupement par statut (en cours d'abord).
const SORTS = [["recent", "Récentes"], ["title", "Titre A → Z"], ["rating", "Note"]];
const byTitle = (a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base", numeric: true });
const STATUS_ORDER = { watching: 0, todo: 1, done: 2, dropped: 3 };
const SORT_FN = {
  recent: (a, b) => STATUS_ORDER[bucket(a)] - STATUS_ORDER[bucket(b)] || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || byTitle(a, b),
  title: byTitle,
  // Les séries non notées passent après les notées.
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b),
};

function libView() {
  if (!state.loaded) return loading();
  const all = state.series, eps = all.reduce((n, s) => n + stats(s).seen, 0);
  const count = (k) => all.filter((s) => k === "all" || bucket(s) === k).length;
  const chips = [["all", "Toutes"], ["watching", "En cours"], ["todo", "À voir"], ["done", "Terminées"], ["dropped", "Abandonnées"]]
    .map(([k, l]) => `<button class="chip" type="button" data-act="filter" data-f="${k}" aria-pressed="${state.filter === k}">${l}<span class="n num">${count(k)}</span></button>`).join("");
  let html = `<p class="summary"><span><b class="num">${all.length}</b> série${all.length > 1 ? "s" : ""}</span><span><b class="num">${eps}</b> épisode${eps > 1 ? "s" : ""} vus</span><label class="sort">${icon("sort")}<select data-act="sort" aria-label="Trier par">${SORTS.map(([k, l]) => `<option value="${k}"${state.sort === k ? " selected" : ""}>${l}</option>`).join("")}</select></label></p><div class="chips" role="group" aria-label="Filtrer par statut">${chips}</div>`;
  const pend = all.filter((s) => s.needsInfo === true).length;
  if (state.enrich) html += `<div class="info"><span class="spinner"></span><span>Fiches en cours de remplissage : <b class="num">${state.enrich.done}</b> / ${state.enrich.total}.</span></div>`;
  else if (pend) html += `<div class="info">${icon("cloud_download")}<span style="flex:1">${plural(pend, "série")} sans fiche (saisons, affiche, casting).</span><button class="btn primary small" type="button" data-act="enrich">Compléter</button></div>`;
  if (!all.length) return html + `<div class="empty">${icon("live_tv")}<strong>Aucune série pour l'instant</strong><span>Ajoute la première avec le bouton « Série » : saisons, épisodes, résumé, casting et affiche arrivent tout seuls.</span></div>`;
  const shown = all.filter(matches).sort(SORT_FN[state.sort] || SORT_FN.recent);
  if (!shown.length) return html + `<div class="empty">${icon("filter_alt_off")}<span>Aucune série ne correspond.</span></div>`;
  return html + `<div class="list">${shown.map(card).join("")}</div>`;
}

// « À suivre » : seulement les séries que Tanguy a marquées (bouton « Suivre » de la fiche).
function nextView() {
  if (!state.loaded) return loading();
  const rows = state.series.filter((s) => s.follow).map((s) => ({ s, st: stats(s) }));
  const films = state.films.filter((f) => f.status === "todo").sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!rows.length && !films.length) return `<div class="empty">${icon("bookmark_add")}<strong>Rien à suivre pour l'instant</strong><span>Ouvre une série et touche « Suivre » : elle apparaîtra ici avec son prochain épisode et ses dates de diffusion. Les films « À voir » s'y ajoutent aussi.</span></div>`;
  const recent = (a, b) => String(b.s.updatedAt || "").localeCompare(String(a.s.updatedAt || ""));
  const going = rows.filter((r) => r.st.next && r.st.seen > 0).sort(recent);
  const todo = rows.filter((r) => r.st.next && !r.st.seen).sort(recent);
  const soon = rows.filter((r) => r.st.upcoming).sort((a, b) => a.st.upcoming.date.localeCompare(b.st.upcoming.date));
  const waiting = rows.filter((r) => !r.st.next && !r.st.upcoming).sort(recent);
  const sm = (s) => `${poster(s, "sm")}`;
  const body = (s, sub) => `<div class="row-body" data-act="open" data-id="${esc(s.id)}" role="button" tabindex="0"><div class="s-t" style="font-size:15px">${esc(s.title)}</div><div class="s-sub">${sub}</div>`;
  let html = "";
  if (going.length) html += `<div class="h2">Reprendre <small>${plural(going.length, "série")}</small></div><div class="panel">${going.map(({ s, st }) => `<div class="row">${sm(s)}${body(s, `<span class="code">${code(st.next.s, st.next.e)}</span>${st.next.title ? " · " + esc(st.next.title) : ""}`)}<div class="bar"><span style="width:${st.pct}%"></span></div></div>
    <button class="seen-btn" type="button" data-act="seen" data-id="${esc(s.id)}" aria-label="Marquer ${code(st.next.s, st.next.e)} comme vu">${icon("done")}</button></div>`).join("")}</div>`;
  if (soon.length) html += `<div class="h2">Prochaines diffusions</div><div class="panel">${soon.map(({ s, st }) => `<div class="row">${sm(s)}${body(s, `<span class="code">${code(st.upcoming.s, st.upcoming.e)}</span> · ${whenLong(st.upcoming.date)}`)}</div></div>`).join("")}</div>`;
  if (todo.length) html += `<div class="h2">Pas encore commencées <small>${todo.length}</small></div><div class="panel">${todo.map(({ s, st }) => `<div class="row">${sm(s)}${body(s, `${plural(st.seasons.length, "saison")} · ${st.total} ép.${s.runtime ? ` · ${s.runtime} min` : ""}`)}</div>
    <button class="btn soft small" type="button" data-act="seen" data-id="${esc(s.id)}">${icon("play_arrow")}${code(st.next.s, st.next.e)}</button></div>`).join("")}</div>`;
  if (waiting.length) html += `<div class="h2">À jour <small>${waiting.length}</small></div><div class="panel">${waiting.map(({ s }) => `<div class="row">${sm(s)}${body(s, s.airing ? "En attente de la suite" : "Tout est vu")}</div>
    <button class="icon-btn" type="button" data-act="follow" data-id="${esc(s.id)}" aria-label="Ne plus suivre ${esc(s.title)}">${icon("bookmark_remove")}</button></div>`).join("")}</div>`;
  if (films.length) html += `<div class="h2">Films à voir <small>${films.length}</small></div><div class="panel">${films.map((f) => `<div class="row">${sm(f)}<div class="row-body" data-act="fopen" data-id="${esc(f.id)}" role="button" tabindex="0"><div class="s-t" style="font-size:15px">${esc(f.title)}</div><div class="s-sub">${esc(filmMeta(f))}</div></div>
    <button class="btn soft small" type="button" data-act="fseen" data-id="${esc(f.id)}">${icon("done")}Vu</button></div>`).join("")}</div>`;
  return html;
}

function statsView() {
  if (!state.loaded) return loading();
  const all = state.series;
  if (!all.length && !state.films.length) return `<div class="empty">${icon("insights")}<strong>Pas encore de bilan</strong><span>Ajoute des séries ou des films pour voir ton temps passé devant l'écran.</span></div>`;
  return (all.length ? seriesStats(all) : "") + filmStats();
}
function filmStats() {
  const seen = state.films.filter((f) => f.status === "done");
  if (!seen.length) return "";
  const hours = Math.round(seen.reduce((n, f) => n + (f.runtime || 0), 0) / 60), rated = seen.filter((f) => f.rating);
  const avg = rated.length ? (rated.reduce((n, f) => n + f.rating, 0) / rated.length).toFixed(1).replace(".", ",") : "–";
  let html = `<div class="h2" style="margin-top:28px">Films</div><div class="tiles">
    <div class="tile"><b class="num">${seen.length}</b><span>films vus</span></div>
    <div class="tile"><b class="num">${hours} h</b><span>de films${hours >= 24 ? `, soit ${(hours / 24).toFixed(1).replace(".", ",")} jours` : ""}</span></div>
    <div class="tile"><b class="num">${state.films.filter((f) => f.status === "todo").length}</b><span>à voir</span></div>
    <div class="tile"><b class="num">${avg}</b><span>note moyenne${rated.length ? ` (${rated.length} notés)` : ""}</span></div></div>`;
  const bars = (title, small, entries) => {
    if (!entries.length) return "";
    const max = entries[0][1];
    return `<div class="h2">${title} <small>${small}</small></div><div class="hbars">${entries.map(([k, n]) => `<div class="hbar"><span class="lbl">${esc(k)}</span><span class="track"><span style="width:${(n / max) * 100}%"></span></span><span class="v">${n}</span></div>`).join("")}</div>`;
  };
  const count = (key) => { const g = {}; for (const f of seen) for (const x of key(f)) g[x] = (g[x] || 0) + 1; return Object.entries(g).sort((a, b) => b[1] - a[1]); };
  html += bars("Genres", "nombre de films", count((f) => f.genres || []).slice(0, 8));
  html += bars("Réalisateurs", "films vus", count((f) => f.directors || []).filter(([, n]) => n > 1).slice(0, 6));
  const years = {}; for (const f of seen) if (f.seenAt) years[f.seenAt.slice(0, 4)] = (years[f.seenAt.slice(0, 4)] || 0) + 1;
  html += bars("Par année", "films vus", Object.entries(years).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8));
  return html;
}
function seriesStats(all) {
  let eps = 0, mins = 0;
  for (const s of all) { const n = stats(s).seen; eps += n; mins += n * (s.runtime || 0); }
  const done = all.filter((s) => s.status === "done").length, hours = Math.round(mins / 60);
  let html = `${state.films.length ? `<div class="h2" style="margin-top:4px">Séries</div>` : ""}<div class="tiles">
    <div class="tile"><b class="num">${all.length}</b><span>séries suivies</span></div>
    <div class="tile"><b class="num">${done}</b><span>terminées</span></div>
    <div class="tile"><b class="num">${eps}</b><span>épisodes vus</span></div>
    <div class="tile"><b class="num">${hours} h</b><span>devant l'écran (estimé${hours >= 24 ? `, soit ${(hours / 24).toFixed(1).replace(".", ",")} jours` : ""})</span></div></div>`;
  const byTime = all.map((s) => ({ s, h: (stats(s).seen * (s.runtime || 0)) / 60 })).filter((x) => x.h > 0).sort((a, b) => b.h - a.h).slice(0, 8);
  if (byTime.length) {
    const max = byTime[0].h;
    html += `<div class="h2">Là où passe ton temps <small>heures</small></div><div class="hbars">${byTime.map(({ s, h }) => `<div class="hbar"><span class="lbl">${esc(s.title)}</span><span class="track"><span style="width:${(h / max) * 100}%"></span></span><span class="v">${Math.round(h)}</span></div>`).join("")}</div>`;
  }
  const g = {};
  for (const s of all) for (const x of s.genres || []) g[x] = (g[x] || 0) + 1;
  const genres = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (genres.length) {
    const max = genres[0][1];
    html += `<div class="h2">Genres <small>nombre de séries</small></div><div class="hbars">${genres.map(([k, n]) => `<div class="hbar"><span class="lbl">${esc(k)}</span><span class="track"><span style="width:${(n / max) * 100}%"></span></span><span class="v">${n}</span></div>`).join("")}</div>`;
  }
  return html;
}

function detailView() {
  const s = find(state.detailId);
  if (!s) return `<div class="empty">${icon("search_off")}<span>Cette série n'existe plus.</span></div>`;
  const st = stats(s), today = todayISO();
  const meta = [years(s), s.network, s.country, s.runtime ? `${s.runtime} min` : ""].filter(Boolean).join(" · ");
  let html = `<div class="hero">${poster(s, "big")}<div class="hero-txt">
    <h2>${esc(s.title)}</h2>
    ${s.originalTitle && s.originalTitle !== s.title ? `<div class="orig">${esc(s.originalTitle)}</div>` : ""}
    <div class="meta">${esc(meta)}</div>
    <div class="s-foot" style="margin-top:4px">${tagFor(s, st)}${s.airing ? `<span class="tag">${icon("sensors")}En production</span>` : ""}</div></div></div>`;
  if (s.imported && refOf(s) && !state.fixOpen) html += `<button class="btn ghost small" type="button" data-act="fixopen" style="margin:-8px 0 8px -10px">${icon("swap_horiz")}Pas la bonne série ? Changer</button>`;
  if (s.needsInfo === "notfound" || s.needsInfo === true || state.fixOpen) html += `<div class="info warn" style="margin:0 0 12px">${icon("help")}<span>${s.needsInfo === "notfound" ? "Ni TMDB ni TVmaze n'ont reconnu ce titre." : state.fixOpen ? "Cherche la bonne série et choisis-la : tes épisodes vus sont conservés." : "Fiche pas encore remplie."} Corrige le titre si besoin (le titre original marche mieux) puis lance la recherche.</span></div>
    <div class="searchrow" style="margin-bottom:14px"><div class="field"><label for="fixTitle">Titre</label><input id="fixTitle" maxlength="120" value="${esc(s.title)}" autocomplete="off"></div><button class="btn primary" type="button" data-act="fix">${icon("travel_explore")}Rechercher</button></div><div class="cands" id="fixCands"></div>`;
  html += `<div class="seg" role="group" aria-label="Mon statut">${Object.entries(STATUS).map(([k, l]) => `<button type="button" data-act="status" data-v="${k}" aria-pressed="${s.status === k}">${l}</button>`).join("")}</div>
    <button class="btn follow" type="button" data-act="follow" data-id="${esc(s.id)}" aria-pressed="${!!s.follow}">${icon(s.follow ? "bookmark_added" : "bookmark_add", s.follow)}${s.follow ? "Dans « À suivre »" : "Suivre dans « À suivre »"}</button>
    <div class="stars" role="group" aria-label="Ma note">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${(s.rating || 0) >= n ? "on" : ""}" data-act="rate" data-v="${n}" aria-label="${n} sur 5" aria-pressed="${s.rating === n}">${icon("star", (s.rating || 0) >= n)}</button>`).join("")}<span class="lbl">${s.rating ? `${s.rating}/5` : "Pas encore notée"}</span></div>`;
  html += `<div class="progress-box"><div class="top"><span><b class="num">${st.seen}</b> / ${st.total} épisodes vus</span><span class="num">${st.pct} %</span></div><div class="bar" style="margin:0"><span style="width:${st.pct}%"></span></div>
    ${st.next ? `<div class="next"><span class="ms">play_circle</span><div class="grow"><div class="code">Prochain : ${code(st.next.s, st.next.e)}</div><div class="t">${esc(st.next.title || `Saison ${st.next.s}, épisode ${st.next.e}`)}</div></div><button class="btn small" type="button" data-act="seen" data-id="${esc(s.id)}">${icon("done")}Vu</button></div>`
    : st.total ? `<div class="info" style="margin:0">${icon(s.airing ? "schedule" : "celebration")}<span>${s.airing ? (st.upcoming ? `Tu es à jour. Prochain épisode le ${whenLong(st.upcoming.date)}.` : "Tu es à jour. Pas encore de date pour la suite.") : "Série terminée, tout est vu."}</span></div>` : ""}</div>`;
  if (s.summary) html += `<div class="h2">Résumé</div><p class="prose">${esc(s.summary)}</p>`;
  const facts = [["Création", (s.creators || []).join(", ")], ["Réalisation", (s.directors || []).join(", ")], ["Genres", (s.genres || []).join(", ")], ["Diffusion", s.network]].filter(([, v]) => v);
  if (facts.length) html += `<div class="h2">Fiche</div><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  if ((s.cast || []).length) html += `<div class="h2">Acteurs principaux</div><div class="cast">${s.cast.map((c) => `<div class="person"><b>${esc(c.name)}</b>${c.role ? `<span>${esc(c.role)}</span>` : ""}</div>`).join("")}</div>`;
  html += `<div class="h2">Saisons et épisodes <small>${plural(st.seasons.length, "saison")} · ${st.total} ép.</small></div>`;
  if (!st.seasons.length) html += `<div class="info">${icon("info")}<span>Aucune saison renseignée pour l'instant.</span></div>`;
  const openDefault = st.next ? st.next.s : null;
  for (const se of st.seasons) {
    const set = new Set((s.watched || {})["s" + se.n] || []);
    const airedN = Array.from({ length: se.count }, (_, i) => i + 1).filter((e) => !(se.dates || [])[e - 1] || se.dates[e - 1] <= today).length;
    const seen = [...set].filter((e) => e <= se.count).length;
    const key = s.id + ":" + se.n, open = state.open[key] ?? se.n === openDefault;
    html += `<div class="season" data-open="${open}"><div class="season-h" data-act="toggle" data-k="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="grow"><div class="t">Saison ${se.n} <small class="num">${seen}/${se.count}${se.year ? ` · ${se.year}` : ""}</small></div><div class="bar" style="margin:0"><span style="width:${se.count ? (seen / se.count) * 100 : 0}%"></span></div></div>
      ${seen === se.count ? `<span class="tag done">${icon("check")}Vue</span>` : airedN < se.count ? `<span class="tag waiting">${icon("schedule")}En diffusion</span>` : ""}<span class="ms chev">expand_more</span></div>`;
    if (open) {
      const all = seen < airedN;
      html += `<div class="season-b"><div class="season-tools"><button class="btn soft small" type="button" data-act="all" data-s="${se.n}" data-on="${all}">${icon(all ? "done_all" : "remove_done")}${all ? "Toute la saison vue" : "Tout décocher"}</button></div>`;
      if ((se.titles || []).some(Boolean)) {
        html += `<div class="ep-list">${Array.from({ length: se.count }, (_, i) => i + 1).map((e) => {
          const on = set.has(e), nx = st.next && st.next.s === se.n && st.next.e === e, d = (se.dates || [])[e - 1], fut = d && d > today;
          return `<button class="ep-row ${on ? "on" : ""} ${nx ? "nx" : ""} ${fut ? "future" : ""}" type="button" data-act="ep" data-s="${se.n}" data-e="${e}" aria-pressed="${on}" ${fut ? "disabled" : ""}><span class="box">${icon("check")}</span><span class="code">E${p2(e)}</span><span class="tt">${esc(se.titles[e - 1] || "")}</span>${fut ? `<span class="when">${fmtDate(d)}</span>` : ""}</button>`;
        }).join("")}</div>`;
      } else {
        html += `<div class="eps">${Array.from({ length: se.count }, (_, i) => i + 1).map((e) => {
          const on = set.has(e), nx = st.next && st.next.s === se.n && st.next.e === e;
          return `<button class="ep ${on ? "on" : ""} ${nx ? "nx" : ""}" type="button" data-act="ep" data-s="${se.n}" data-e="${e}" aria-pressed="${on}" aria-label="${code(se.n, e)}${on ? ", vu" : ""}">${p2(e)}</button>`;
        }).join("")}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  if (s.infoAt) html += `<p class="source">Fiche ${refOf(s) ? `${s.source || "TVmaze"} mise à jour le ${fmtLong(s.infoAt)}` : `du ${fmtLong(s.infoAt)}`}.</p>`;
  return html;
}

// ---------- Rendu ----------
let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }
function render() {
  const inDetail = !!state.detailId, isFilm = state.detailKind === "film", s = inDetail ? (isFilm ? findFilm : find)(state.detailId) : null;
  const listTab = state.tab === "lib" || state.tab === "films";
  $("backBtn").hidden = !inDetail;
  $("appbar").classList.toggle("with-back", inDetail);
  $("searchBtn").hidden = inDetail || !listTab;
  $("menuBtn").hidden = inDetail || !listTab;
  $("refreshBtn").hidden = !inDetail || !s;
  $("delBtn").hidden = !inDetail || !s;
  $("refreshBtn").setAttribute("aria-label", isFilm ? "Mettre à jour les infos du film" : "Mettre à jour les infos de la série");
  $("delBtn").setAttribute("aria-label", isFilm ? "Supprimer le film" : "Supprimer la série");
  $("searchbar").hidden = inDetail || !listTab || !state.searchOpen;
  $("search").placeholder = state.tab === "films" ? "Titre, réalisateur, acteur…" : "Titre, acteur, chaîne…";
  $("barTitle").innerHTML = inDetail ? esc(s ? s.title : "") : esc({ lib: "Mes séries", films: "Mes films", next: "À suivre", stats: "Bilan" }[state.tab]) + (listTab ? `<span class="dot" aria-hidden="true"></span>` : "");
  $("fab").hidden = inDetail || state.tab === "stats";
  $("fabTxt").textContent = state.tab === "films" ? "Film" : "Série";
  for (const b of document.querySelectorAll(".nav-item")) b.setAttribute("aria-current", !inDetail && b.dataset.tab === state.tab ? "page" : "false");
  const nGoing = state.series.filter((x) => x.follow && stats(x).next).length + state.films.filter((f) => f.status === "todo").length;
  $("nextBadge").hidden = !nGoing; $("nextBadge").textContent = nGoing;
  const html = inDetail ? (isFilm ? filmDetailView() : detailView()) : state.tab === "next" ? nextView() : state.tab === "stats" ? statsView() : state.tab === "films" ? filmsView() : libView();
  const key = inDetail ? "d:" + state.detailId : state.tab, main = $("main");
  const typing = document.activeElement && document.activeElement.id === "fixTitle" ? $("fixTitle").value : null;
  const cands = $("fixCands") ? $("fixCands").innerHTML : "";
  if (main.dataset.key !== key) { main.innerHTML = `<div class="view">${html}</div>`; main.dataset.key = key; }
  else main.firstElementChild.innerHTML = html;
  if ($("fixCands") && cands) $("fixCands").innerHTML = cands;
  if (typing !== null && $("fixTitle")) { $("fixTitle").value = typing; $("fixTitle").focus(); }
}
function go(tab) { state.tab = tab; state.detailId = null; render(); window.scrollTo(0, 0); }
function openDetail(id, kind = "series") { state.fixOpen = false; if (!state.detailId) state.listScroll = window.scrollY; state.detailId = id; state.detailKind = kind; render(); window.scrollTo(0, 0); }
function back() { state.detailId = null; render(); window.scrollTo(0, state.listScroll); }
window.addEventListener("scroll", () => $("appbar").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

// ---------- Événements ----------
document.querySelector(".navbar").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
$("backBtn").addEventListener("click", back);
$("searchBtn").addEventListener("click", () => { state.searchOpen = true; render(); $("search").focus(); });
$("searchClose").addEventListener("click", () => { state.searchOpen = false; state.q = ""; $("search").value = ""; render(); });
$("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
$("fab").addEventListener("click", () => (state.tab === "films" ? openAddFilm() : openAdd()));

$("main").addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]"); if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act === "filter") { state.filter = el.dataset.f; Preferences.set({ key: "filter", value: state.filter }).catch(() => {}); render(); return; }
  if (act === "toggle") { const k = el.dataset.k; state.open[k] = el.getAttribute("aria-expanded") !== "true"; render(); return; }
  if (act === "enrich") { enrichAll(); return; }
  if (act === "fixopen") { state.fixOpen = true; render(); return; }
  if (act[0] === "f" && act !== "fix" && act !== "fixopen" && act !== "follow" && act !== "filter") return filmAction(act, el, ev);
  if (act === "pick") { const s = find(state.detailId); if (s) { state.fixOpen = false; s.picked = true; applyShow(s, el.dataset.tv).catch(() => snack("Pas de réponse des bases de séries. Vérifie ta connexion.")); } return; }
  const s = el.dataset.id ? find(el.dataset.id) : find(state.detailId);
  if (!s) return;
  if (act === "open") return openDetail(s.id);
  if (act === "seen") { ev.stopPropagation(); markNext(s); }
  if (act === "status") { s.status = el.dataset.v; if (s.status === "done" && !s.finishedAt) s.finishedAt = todayISO(); touch(s); }
  if (act === "rate") { const v = +el.dataset.v; s.rating = s.rating === v ? 0 : v; touch(s); }
  if (act === "follow") {
    ev.stopPropagation();
    const id = s.id, on = !s.follow;
    const set = (v) => { const cur = find(id); if (!cur) return; if (v) cur.follow = true; else delete cur.follow; touch(cur, false); };
    set(on);
    snack(on ? `${s.title} ajoutée à « À suivre »` : `${s.title} retirée de « À suivre »`, () => set(!on));
  }
  if (act === "ep") { const se = +el.dataset.s, e = +el.dataset.e, on = !((s.watched || {})["s" + se] || []).includes(e); const msg = setSeen(s, se, [e], on); if (msg) snack(msg); }
  if (act === "all") {
    const se = (s.seasons || []).find((x) => x.n === +el.dataset.s); if (!se) return;
    const on = el.dataset.on === "true", today = todayISO();
    const eps = Array.from({ length: se.count }, (_, i) => i + 1).filter((e) => !on || !(se.dates || [])[e - 1] || se.dates[e - 1] <= today);
    const msg = setSeen(s, se.n, eps, on);
    snack(msg || (on ? `Saison ${se.n} cochée` : `Saison ${se.n} décochée`));
  }
  if (act === "fix") {
    const t = ($("fixTitle").value || "").replace(/\s+/g, " ").trim(); if (!t) return;
    el.disabled = true;
    try {
      const list = await tv(() => searchShows(getJson, t));
      $("fixCands").innerHTML = list.length ? list.map(candHtml).join("") : `<p class="note err">Toujours rien. Essaie le titre original.</p>`;
    } catch { $("fixCands").innerHTML = `<p class="note err">Pas de réponse des bases de séries. Vérifie ta connexion.</p>`; }
    finally { el.disabled = false; }
  }
});
$("main").addEventListener("change", (e) => {
  const act = e.target.dataset.act;
  if (act === "sort") { state.sort = e.target.value; Preferences.set({ key: "sort", value: state.sort }).catch(() => {}); render(); }
  if (act === "fsort") { state.fSort = e.target.value; Preferences.set({ key: "fSort", value: state.fSort }).catch(() => {}); render(); }
  if (act === "fdate") { const f = findFilm(state.detailId); if (f && e.target.value) { f.seenAt = e.target.value; touchFilm(f); } }
});
async function filmAction(act, el, ev) {
  if (act === "ffilter") { state.fFilter = el.dataset.f; Preferences.set({ key: "fFilter", value: state.fFilter }).catch(() => {}); render(); return; }
  if (act === "fenrich") { enrichFilms(); return; }
  if (act === "fofferyes") { importFilmOffer(); return; }
  if (act === "fofferno") {
    const o = state.filmOffer; if (!o) return;
    state.meta.filmDeclined = [...(state.meta.filmDeclined || []), o.file]; state.filmOffer = null; persistSoon(); render();
    snack("D'accord. L'import reste possible depuis le menu ⋮ des films.", () => { state.meta.filmDeclined = state.meta.filmDeclined.filter((x) => x !== o.file); state.filmOffer = o; persistSoon(); render(); });
    return;
  }
  const f = el.dataset.id ? findFilm(el.dataset.id) : findFilm(state.detailId);
  if (!f) return;
  if (act === "fopen") return openDetail(f.id, "film");
  if (act === "fseen") { ev.stopPropagation(); markFilmSeen(f); }
  if (act === "fstatus") setFilmStatus(f, el.dataset.v);
  if (act === "frate") { const v = +el.dataset.v; f.rating = f.rating === v ? 0 : v; touchFilm(f); }
  if (act === "fpick") { state.fixOpen = false; f.picked = true; applyFilm(f, el.dataset.ref).catch(() => snack("Pas de réponse de TMDB. Vérifie ta connexion.")); }
  if (act === "ffix") {
    const t = ($("fixTitle").value || "").replace(/\s+/g, " ").trim(); if (!t) return;
    if (!tmdbReady()) { $("fixCands").innerHTML = `<p class="note err">Recherche de films indisponible dans cette version de l'appli.</p>`; return; }
    el.disabled = true;
    try {
      const list = await searchFilms(getJson, t);
      $("fixCands").innerHTML = list.length ? list.map(filmCandHtml).join("") : `<p class="note err">Toujours rien. Essaie le titre original.</p>`;
    } catch { $("fixCands").innerHTML = `<p class="note err">Pas de réponse de TMDB. Vérifie ta connexion.</p>`; }
    finally { el.disabled = false; }
  }
}
$("main").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[role=button][data-act]")) { e.preventDefault(); e.target.click(); } });
const candHtml = (c) => `<button class="cand" type="button" data-act="pick" data-tv="${c.ref}">${poster({ title: c.title, year: c.year, posterUrl: c.poster }, "sm")}<span class="grow"><span class="s-t" style="font-size:15px">${esc(c.title)}</span><span class="s-sub">${esc([c.year ? (c.endYear && c.endYear !== c.year ? `${c.year}–${c.endYear}` : c.year) : "", c.network, c.country].filter(Boolean).join(" · "))}</span></span>${icon("chevron_right")}</button>`;

// ---------- Fiche TMDB / TVmaze ----------
// Remplace les infos d'une série par celles de la fiche `ref`, en gardant les épisodes cochés, le statut et la note.
// `migrate` : même série vue sur TMDB ; abandon si ses saisons ne contiennent pas tous les épisodes déjà cochés.
async function applyShow(s, ref, { silent, migrate } = {}) {
  const info = await tv(() => loadShow(getJson, ref));
  const cur = find(s.id); if (!cur) return null;
  if (migrate) {
    const fits = Object.entries(cur.watched || {}).every(([k, eps]) => { const se = info.seasons.find((x) => "s" + x.n === k); return !eps.length || (se && Math.max(...eps) <= se.count); });
    if (!fits) return null;
  }
  const before = stats(cur).total, old = refOf(cur);
  if (old && old !== info.ref && !migrate) delete cur.tvmazeId;
  // Titre : celui de la fiche française, sauf série importée (titre Netflix) ou renommée par Tanguy.
  const keepTitle = cur.imported || cur.renamed ? cur.title : info.title;
  // Changement de série sur une fiche importée : on repart de la progression d'origine.
  if (cur.imported && cur.importWatched && old && old !== info.ref && !migrate) cur.watched = clone(cur.importWatched);
  const { posterUrl, ...rest } = info;
  Object.assign(cur, rest, { title: keepTitle, posterUrl, infoAt: new Date().toISOString() });
  delete cur.needsInfo; delete cur.example; delete cur.confidence;
  applyProgress(cur);
  // Épisodes cochés hors de la fiche (numérotation différente sur Netflix) : on les retire.
  for (const k of Object.keys(cur.watched || {})) {
    const se = cur.seasons.find((x) => "s" + x.n === k);
    if (!se) delete cur.watched[k]; else cur.watched[k] = cur.watched[k].filter((e) => e <= se.count);
  }
  autoStatus(cur);
  if (posterUrl && (!cur.poster || cur.posterFrom !== posterUrl)) { try { await savePoster(cur, posterUrl); cur.posterFrom = posterUrl; } catch {} }
  touch(cur, false);
  const added = stats(cur).total - before;
  if (!silent) snack(added > 0 && before ? `${plural(added, "nouvel épisode")} pour ${cur.title}` : `Fiche de ${cur.title} à jour`);
  return added;
}
$("refreshBtn").addEventListener("click", async () => {
  if (state.detailKind === "film") {
    const f = findFilm(state.detailId); if (!f) return;
    $("refreshBtn").disabled = true;
    try { await refreshFilm(f); } catch { snack("Pas de réponse de TMDB. Vérifie ta connexion."); }
    finally { $("refreshBtn").disabled = false; }
    return;
  }
  const s = find(state.detailId); if (!s) return;
  const btn = $("refreshBtn"); btn.disabled = true;
  try {
    const id = refOf(s) || await tv(() => bestMatch(getJson, [s.searchTitle, s.title, s.originalTitle], s.year, s.firstSeen ? +s.firstSeen.slice(0, 4) : null));
    if (!id) { snack("Série introuvable sur TMDB et TVmaze. Corrige le titre puis réessaie."); s.needsInfo = "notfound"; touch(s); return; }
    await applyShow(s, id);
  } catch { snack("Pas de réponse des bases de séries. Vérifie ta connexion."); }
  finally { btn.disabled = false; }
});

// Met à jour les séries en cours de diffusion (nouveaux épisodes, dates).
async function refreshAiring({ silent } = {}) {
  const list = state.series.filter((s) => refOf(s) && s.airing && s.status !== "dropped");
  let added = 0, names = [];
  for (const s of list) {
    try { const n = await applyShow(s, refOf(s), { silent: true }); if (n > 0) { added += n; names.push(s.title); } } catch {}
    await sleep(400);
  }
  state.meta.checkedAt = new Date().toISOString(); persistSoon();
  if (added) snack(`Nouveaux épisodes : ${names.join(", ")}`, null, 8000);
  else if (!silent) snack(list.length ? "Aucun nouvel épisode." : "Aucune série en cours de diffusion.");
}

async function enrichAll() {
  if (state.enrich) return;
  const queue = state.series.filter((s) => s.needsInfo === true || (s.tmdbPending && tmdbReady())).map((s) => s.id);
  if (!queue.length) return;
  state.enrich = { done: 0, total: queue.length };
  let ok = 0, nf = 0, net = 0;
  render();
  for (const id of queue) {
    const s = find(id);
    if (s && s.tmdbPending && s.needsInfo !== true) {
      try {
        const ref = await tv(() => toTmdb(getJson, s));
        if (ref && await applyShow(s, ref, { silent: true, migrate: true }) != null) ok++;
        delete s.tmdbPending;
      } catch { net++; if (net >= 3) break; }
      await sleep(250);
    } else if (s && s.needsInfo === true) {
      delete s.tmdbPending;
      try {
        const tvId = await tv(() => bestMatch(getJson, [s.searchTitle, s.title, s.originalTitle], s.year, s.firstSeen ? +s.firstSeen.slice(0, 4) : null));
        if (tvId) { await applyShow(s, tvId, { silent: true }); ok++; }
        else { if (s.imported && refOf(s)) resetImported(s); s.needsInfo = "notfound"; autoStatus(s, true); touch(s, false); nf++; }
      } catch { net++; if (net >= 3) break; }
      await sleep(400);
    }
    state.enrich.done++; render();
    if (state.enrich.done % 10 === 0) await persist();
  }
  state.enrich = null; render();
  if (net >= 3) snack("Pas de réponse des bases de séries. Vérifie ta connexion puis touche « Compléter ».", null, 6000);
  else snack(`${plural(ok, "fiche complétée")}${nf ? `, ${nf} introuvable${nf > 1 ? "s" : ""} : ouvre leur fiche pour corriger le titre` : ""}`, null, 6000);
}

$("delBtn").addEventListener("click", () => {
  const film = state.detailKind === "film", s = (film ? findFilm : find)(state.detailId); if (!s) return;
  $("confirmH").textContent = film ? "Supprimer le film ?" : "Supprimer la série ?";
  $("confirmTxt").textContent = film ? `${s.title} sera retiré de ta liste de films.` : `${s.title} et les ${stats(s).seen} épisode(s) cochés seront retirés de ta liste.`;
  $("confirmDlg").showModal();
});
$("confirmNo").addEventListener("click", () => $("confirmDlg").close());
$("confirmYes").addEventListener("click", async () => {
  const film = state.detailKind === "film", s = (film ? findFilm : find)(state.detailId); $("confirmDlg").close(); if (!s) return;
  if (film) state.films = state.films.filter((x) => x.id !== s.id);
  else state.series = state.series.filter((x) => x.id !== s.id);
  if (s.poster) Filesystem.deleteFile({ path: s.poster, directory: Directory.Data }).catch(() => {});
  await persist(); back(); snack(`${s.title} supprimé${film ? "" : "e"}`);
});

// ---------- Ajout ----------
let found = null, cands = [];
function openAdd() {
  found = null; cands = [];
  $("addForm").reset();
  $("lookupNote").hidden = true; $("cands").hidden = true; $("foundBox").hidden = true; $("addErr").hidden = true; $("manualBtn").hidden = true;
  $("detailsBox").hidden = true;
  $("addDlg").showModal();
  $("a-q").focus();
}
$("addClose").addEventListener("click", () => $("addDlg").close());
$("a-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } });
$("lookupBtn").addEventListener("click", () => lookup());
$("manualBtn").addEventListener("click", () => { found = null; $("cands").hidden = true; $("foundBox").hidden = true; fillDetails({}); $("lookupNote").textContent = "Saisie manuelle : indique le nombre d'épisodes de chaque saison."; $("lookupNote").hidden = false; });
$("cands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tv]"); if (!b) return;
  const note = $("lookupNote");
  note.className = "note"; note.textContent = "Chargement de la fiche…"; note.hidden = false;
  try {
    found = await tv(() => loadShow(getJson, b.dataset.tv));
    const total = found.seasons.reduce((n, x) => n + x.count, 0);
    $("foundBox").innerHTML = `<div class="found">${poster(found)}<div class="grow"><div class="t">${esc(found.title)}</div>
      <div class="s-sub">${esc([years(found), found.network, `${plural(found.seasons.length, "saison")}, ${total} ép.`].filter(Boolean).join(" · "))}</div>
      <div class="s-sub">${esc(found.cast.slice(0, 3).map((c) => c.name).join(", "))}</div>${found.summary ? `<p>${esc(found.summary)}</p>` : ""}</div></div>`;
    $("foundBox").hidden = false; $("cands").hidden = true;
    note.textContent = `Fiche ${found.source} trouvée. Indique où tu en es, puis ajoute-la.`;
    fillDetails(found);
  } catch { note.className = "note err"; note.textContent = "Pas de réponse des bases de séries. Vérifie ta connexion."; }
});
async function lookup() {
  const q = $("a-q").value.trim(), note = $("lookupNote");
  if (!q) { note.textContent = "Tape d'abord le titre de la série."; note.hidden = false; return; }
  $("lookupBtn").disabled = true; $("lookupBtn").innerHTML = `<span class="spinner"></span>Recherche`;
  note.hidden = false; note.className = "note"; note.textContent = "Recherche…";
  $("foundBox").hidden = true; $("detailsBox").hidden = true; found = null;
  try {
    cands = await tv(() => searchShows(getJson, q));
    $("cands").innerHTML = cands.map(candHtml).join("");
    $("cands").hidden = !cands.length;
    note.textContent = cands.length ? "Choisis la bonne série :" : "Aucune série trouvée. Essaie le titre original, ou saisis-la à la main.";
  } catch {
    note.className = "note err"; note.textContent = "Pas de réponse des bases de séries. Vérifie ta connexion, ou saisis la série à la main.";
  } finally {
    $("manualBtn").hidden = false;
    $("lookupBtn").disabled = false; $("lookupBtn").innerHTML = `${icon("travel_explore")}Rechercher`;
  }
}
function fillDetails(d) {
  $("a-year").value = d.year || "";
  $("a-network").value = d.network || "";
  $("a-seasons").value = (d.seasons || []).map((x) => x.count).join(", ");
  $("detailsBox").hidden = false;
}
$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("detailsBox").hidden) return lookup();
  const err = (m) => { $("addErr").textContent = m; $("addErr").hidden = false; };
  const title = (found && found.title) || $("a-q").value.trim();
  if (!title) return err("Donne un titre à la série.");
  const counts = $("a-seasons").value.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (counts.some((n) => !Number.isInteger(n) || n < 1 || n > 500)) return err("Épisodes par saison : écris des nombres séparés par des virgules, par exemple 8, 10, 10.");
  const upRaw = $("a-upto").value.trim(), up = upRaw ? parseUpTo(upRaw) : null;
  if (upRaw && !up) return err("« Déjà vu jusqu'à » doit ressembler à S02E05.");
  if (up && (up.s > counts.length || up.e > counts[up.s - 1])) return err(`${code(up.s, up.e)} n'existe pas avec ces saisons.`);
  if (found && found.ref && state.series.some((x) => refOf(x) === found.ref)) return err("Cette série est déjà dans ta liste.");
  const base = found ? clone(found) : { title, genres: [], cast: [], creators: [], directors: [], seasons: [] };
  const fs = new Map((base.seasons || []).map((x) => [x.n, x]));
  // Les saisons de la fiche sont gardées telles quelles si le nombre d'épisodes n'a pas été modifié.
  const seasons = counts.map((count, i) => { const o = fs.get(i + 1); return o && o.count === count ? o : { n: i + 1, count, year: (o || {}).year || null }; });
  let status = $("a-status").value;
  if (up && status === "todo") status = "watching";
  const posterUrl = base.posterUrl; delete base.posterUrl;
  const now = new Date().toISOString();
  const s = { ...base, id: slug(title), follow: $("a-status").value !== "done" || undefined, title, year: +$("a-year").value || base.year || null, network: $("a-network").value.trim() || base.network || "", seasons, watched: {}, status, rating: 0, addedAt: now, updatedAt: now, upTo: up ? code(up.s, up.e) : undefined, ...(found ? { infoAt: now } : {}) };
  if (status === "done") s.finishedAt = todayISO();
  applyProgress(s);
  $("saveBtn").disabled = true;
  if (posterUrl) { try { await savePoster(s, posterUrl); s.posterFrom = posterUrl; } catch {} }
  state.series.push(JSON.parse(JSON.stringify(s)));
  await persist();
  $("saveBtn").disabled = false;
  $("addDlg").close(); snack(`${title} ajoutée`); openDetail(s.id);
});

// ---------- Films ----------
// Même principe que les séries : fiche TMDB (en français), statut, note, tri, recherche, import. Un film est « vu » ou non (pas d'épisodes).
const fslug = (t) => "film-" + slug(t);
const filmMeta = (f) => [f.year, f.runtime ? fmtRuntime(f.runtime) : "", (f.directors || [])[0]].filter(Boolean).join(" · ");
const fmtRuntime = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${p2(m % 60)}` : `${m} min`);
function filmTag(f) {
  if (f.needsInfo === true) return `<span class="tag">${icon("hourglass_top")}Fiche à compléter</span>`;
  if (f.needsInfo === "notfound") return `<span class="tag waiting">${icon("help")}Fiche introuvable</span>`;
  if (f.status === "done") return `<span class="tag done">${icon("check")}Vu${f.seenAt ? ` le ${fmtDate(f.seenAt, { day: "numeric", month: "short", year: "numeric" })}` : ""}</span>`;
  if (f.status === "dropped") return `<span class="tag">Abandonné</span>`;
  return `<span class="tag watching">À voir</span>`;
}
function filmCard(f) {
  const meta = filmMeta(f);
  return `<div class="s-card" role="button" tabindex="0" data-act="fopen" data-id="${esc(f.id)}">
    ${poster(f)}
    <div class="s-body">
      <div class="s-t">${esc(f.title)}</div>
      <div class="s-sub">${f.rating ? `<span class="s-rate" aria-label="Note ${f.rating} sur 5">★ ${f.rating}</span>${meta ? " · " : ""}` : ""}${esc(meta)}</div>
      <div class="s-foot">${filmTag(f)}${(f.genres || []).length ? `<span class="s-sub">${esc(f.genres.slice(0, 2).join(", "))}</span>` : ""}</div>
    </div>
    ${f.status === "todo" ? `<button class="seen-btn" type="button" data-act="fseen" data-id="${esc(f.id)}" aria-label="Marquer ${esc(f.title)} comme vu">${icon("done")}</button>` : ""}
  </div>`;
}
const FSORTS = [["recent", "Récents"], ["title", "Titre A → Z"], ["rating", "Note"], ["year", "Année de sortie"]];
const FSTATUS_ORDER = { todo: 0, done: 1, dropped: 2 };
const FSORT_FN = {
  recent: (a, b) => FSTATUS_ORDER[a.status] - FSTATUS_ORDER[b.status] || String(b.seenAt || b.updatedAt || "").localeCompare(String(a.seenAt || a.updatedAt || "")) || byTitle(a, b),
  title: byTitle,
  rating: (a, b) => (b.rating || 0) - (a.rating || 0) || byTitle(a, b),
  year: (a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b),
};
function filmMatches(f) {
  if (state.q) {
    const hay = [f.title, f.originalTitle, ...(f.directors || []), ...(f.cast || []).map((c) => c.name)].join(" ").toLowerCase();
    if (!hay.includes(state.q)) return false;
  }
  return state.fFilter === "all" || f.status === state.fFilter;
}
function filmsView() {
  if (!state.loaded) return loading();
  const all = state.films, seen = all.filter((f) => f.status === "done");
  const hours = Math.round(seen.reduce((n, f) => n + (f.runtime || 0), 0) / 60);
  const count = (k) => all.filter((f) => k === "all" || f.status === k).length;
  const chips = [["all", "Tous"], ["todo", "À voir"], ["done", "Vus"], ["dropped", "Abandonnés"]]
    .map(([k, l]) => `<button class="chip" type="button" data-act="ffilter" data-f="${k}" aria-pressed="${state.fFilter === k}">${l}<span class="n num">${count(k)}</span></button>`).join("");
  let html = `<p class="summary"><span><b class="num">${all.length}</b> film${all.length > 1 ? "s" : ""}</span><span><b class="num">${hours} h</b> de films vus</span><label class="sort">${icon("sort")}<select data-act="fsort" aria-label="Trier par">${FSORTS.map(([k, l]) => `<option value="${k}"${state.fSort === k ? " selected" : ""}>${l}</option>`).join("")}</select></label></p><div class="chips" role="group" aria-label="Filtrer par statut">${chips}</div>`;
  if (state.filmOffer) html += `<div class="info">${icon("movie")}<span style="flex:1">Ton historique Netflix contient environ <b class="num">${state.filmOffer.films.length}</b> films. Les ajouter comme vus ?</span><button class="btn ghost small" type="button" data-act="fofferno" aria-label="Ne pas importer">Non</button><button class="btn primary small" type="button" data-act="fofferyes">Importer</button></div>`;
  const pend = all.filter((f) => f.needsInfo === true).length;
  if (state.fEnrich) html += `<div class="info"><span class="spinner"></span><span>Fiches en cours de remplissage : <b class="num">${state.fEnrich.done}</b> / ${state.fEnrich.total}.</span></div>`;
  else if (pend && tmdbReady()) html += `<div class="info">${icon("cloud_download")}<span style="flex:1">${plural(pend, "film")} sans fiche (affiche, résumé, casting).</span><button class="btn primary small" type="button" data-act="fenrich">Compléter</button></div>`;
  if (!all.length) return html + `<div class="empty">${icon("movie")}<strong>Aucun film pour l'instant</strong><span>Ajoute le premier avec le bouton « Film » : affiche, résumé, réalisateur et casting arrivent tout seuls.</span></div>`;
  const shown = all.filter(filmMatches).sort(FSORT_FN[state.fSort] || FSORT_FN.recent);
  if (!shown.length) return html + `<div class="empty">${icon("filter_alt_off")}<span>Aucun film ne correspond.</span></div>`;
  return html + `<div class="list">${shown.map(filmCard).join("")}</div>`;
}
function filmDetailView() {
  const f = findFilm(state.detailId);
  if (!f) return `<div class="empty">${icon("search_off")}<span>Ce film n'existe plus.</span></div>`;
  const meta = [f.year, f.runtime ? fmtRuntime(f.runtime) : "", f.country].filter(Boolean).join(" · ");
  let html = `<div class="hero">${poster(f, "big")}<div class="hero-txt">
    <h2>${esc(f.title)}</h2>
    ${f.originalTitle && f.originalTitle !== f.title ? `<div class="orig">${esc(f.originalTitle)}</div>` : ""}
    <div class="meta">${esc(meta)}</div>
    <div class="s-foot" style="margin-top:4px">${filmTag(f)}</div></div></div>`;
  if (f.imported && f.ref && !state.fixOpen) html += `<button class="btn ghost small" type="button" data-act="fixopen" style="margin:-8px 0 8px -10px">${icon("swap_horiz")}Pas le bon film ? Changer</button>`;
  if (f.needsInfo === "notfound" || f.needsInfo === true || state.fixOpen) html += `<div class="info warn" style="margin:0 0 12px">${icon("help")}<span>${!tmdbReady() ? "Recherche de films indisponible dans cette version de l'appli." : f.needsInfo === "notfound" ? "TMDB n'a pas reconnu ce titre." : state.fixOpen ? "Cherche le bon film et choisis-le : ton statut et ta note sont conservés." : "Fiche pas encore remplie."} Corrige le titre si besoin (le titre original marche mieux) puis lance la recherche.</span></div>
    <div class="searchrow" style="margin-bottom:14px"><div class="field"><label for="fixTitle">Titre</label><input id="fixTitle" maxlength="120" value="${esc(f.title)}" autocomplete="off"></div><button class="btn primary" type="button" data-act="ffix">${icon("travel_explore")}Rechercher</button></div><div class="cands" id="fixCands"></div>`;
  html += `<div class="seg seg3" role="group" aria-label="Mon statut">${Object.entries(FSTATUS).map(([k, l]) => `<button type="button" data-act="fstatus" data-v="${k}" aria-pressed="${f.status === k}">${l}</button>`).join("")}</div>
    <div class="stars" role="group" aria-label="Ma note">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${(f.rating || 0) >= n ? "on" : ""}" data-act="frate" data-v="${n}" aria-label="${n} sur 5" aria-pressed="${f.rating === n}">${icon("star", (f.rating || 0) >= n)}</button>`).join("")}<span class="lbl">${f.rating ? `${f.rating}/5` : "Pas encore noté"}</span></div>`;
  if (f.status === "done") html += `<div class="field" style="margin-bottom:16px"><label for="fSeenAt">Vu le</label><input id="fSeenAt" type="date" data-act="fdate" value="${esc(f.seenAt || "")}" max="${todayISO()}"></div>`;
  if (f.tagline) html += `<p class="prose" style="font-style:italic;margin-bottom:0">${esc(f.tagline)}</p>`;
  if (f.summary) html += `<div class="h2">Résumé</div><p class="prose">${esc(f.summary)}</p>`;
  const facts = [["Réalisation", (f.directors || []).join(", ")], ["Genres", (f.genres || []).join(", ")], ["Pays", f.country], ["Durée", f.runtime ? fmtRuntime(f.runtime) : ""]].filter(([, v]) => v);
  if (facts.length) html += `<div class="h2">Fiche</div><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  if ((f.cast || []).length) html += `<div class="h2">Acteurs principaux</div><div class="cast">${f.cast.map((c) => `<div class="person"><b>${esc(c.name)}</b>${c.role ? `<span>${esc(c.role)}</span>` : ""}</div>`).join("")}</div>`;
  if (f.imported && f.firstSeen) html += `<p class="source">Historique Netflix : vu ${f.views > 1 ? `${f.views} fois, ` : ""}${f.firstSeen !== f.lastSeen ? `du ${fmtLong(f.firstSeen)} au ${fmtLong(f.lastSeen)}` : `le ${fmtLong(f.firstSeen)}`}.</p>`;
  if (f.infoAt) html += `<p class="source">Fiche ${f.ref ? `TMDB mise à jour le ${fmtLong(f.infoAt)}` : `du ${fmtLong(f.infoAt)}`}.</p>`;
  return html;
}
const filmCandHtml = (c) => `<button class="cand" type="button" data-act="fpick" data-ref="${c.ref}">${poster({ title: c.title, year: c.year, posterUrl: c.poster }, "sm")}<span class="grow"><span class="s-t" style="font-size:15px">${esc(c.title)}</span><span class="s-sub">${esc([c.year, c.originalTitle !== c.title ? c.originalTitle : ""].filter(Boolean).join(" · "))}</span></span>${icon("chevron_right")}</button>`;

function touchFilm(f, user = true) {
  if (user) f.updatedAt = new Date().toISOString();
  persistSoon(); render();
}
function setFilmStatus(f, v) {
  f.status = v;
  if (v === "done" && !f.seenAt) f.seenAt = todayISO();
  touchFilm(f);
}
function markFilmSeen(f) {
  const before = [f.status, f.seenAt];
  setFilmStatus(f, "done");
  snack(`${f.title} vu`, () => { const cur = findFilm(f.id); if (!cur) return; [cur.status, cur.seenAt] = before; if (!cur.seenAt) delete cur.seenAt; touchFilm(cur); });
}
// Remplace les infos du film par celles de la fiche TMDB, en gardant le statut, la note et la date de visionnage.
async function applyFilm(f, ref, { silent } = {}) {
  const info = await loadFilm(getJson, ref);
  const cur = findFilm(f.id); if (!cur) return;
  const keepTitle = cur.imported || cur.renamed ? cur.title : info.title;
  const { posterUrl, ...rest } = info;
  Object.assign(cur, rest, { title: keepTitle, posterUrl, infoAt: new Date().toISOString() });
  delete cur.needsInfo; delete cur.strict;
  if (posterUrl && (!cur.poster || cur.posterFrom !== posterUrl)) { try { await savePoster(cur, posterUrl); cur.posterFrom = posterUrl; } catch {} }
  touchFilm(cur, false);
  if (!silent) snack(`Fiche de ${cur.title} à jour`);
}
async function refreshFilm(f) {
  const ref = f.ref || await matchFilm(getJson, [f.searchTitle, f.title, f.originalTitle], f.year, f.firstSeen ? +f.firstSeen.slice(0, 4) : null);
  if (!ref) { snack(tmdbReady() ? "Film introuvable sur TMDB. Corrige le titre puis réessaie." : "Recherche de films indisponible dans cette version de l'appli."); f.needsInfo = "notfound"; touchFilm(f, false); return; }
  await applyFilm(f, ref);
}
// Fiches à remplir (ajout par import) : correspondance TMDB d'après le titre et l'année de visionnage.
// Un titre Netflix « Série: épisode » (`strict`) que TMDB ne connaît pas comme film est retiré : c'était un épisode.
async function enrichFilms() {
  if (state.fEnrich || !tmdbReady()) return;
  const queue = state.films.filter((f) => f.needsInfo === true).map((f) => f.id);
  if (!queue.length) return;
  state.fEnrich = { done: 0, total: queue.length };
  let ok = 0, nf = 0, net = 0;
  render();
  for (const id of queue) {
    const f = findFilm(id);
    if (f && f.needsInfo === true) {
      try {
        const ref = await matchFilm(getJson, [f.searchTitle, f.title, f.originalTitle], f.year, f.firstSeen ? +f.firstSeen.slice(0, 4) : null, f.strict);
        if (ref && !state.films.some((x) => x.id !== f.id && x.ref === ref)) { await applyFilm(f, ref, { silent: true }); ok++; }
        else if (ref || f.strict) state.films = state.films.filter((x) => x.id !== f.id); // doublon ou épisode de série
        else { f.needsInfo = "notfound"; nf++; }
      } catch { net++; if (net >= 3) break; }
      await sleep(50);
    }
    state.fEnrich.done++; render();
    if (state.fEnrich.done % 20 === 0) await persist();
  }
  state.fEnrich = null; await persist(); render();
  if (net >= 3) snack("Pas de réponse de TMDB. Vérifie ta connexion puis touche « Compléter ».", null, 6000);
  else snack(`${plural(ok, "fiche complétée")}${nf ? `, ${nf} introuvable${nf > 1 ? "s" : ""} : ouvre leur fiche pour corriger le titre` : ""}`, null, 6000);
}

// Films de l'historique Netflix : proposés dans l'onglet Films, importés seulement si Tanguy accepte.
async function filmOffer() {
  state.filmOffer = null;
  let files = [];
  try { const r = await fetch("imports/films.json"); if (r.ok) files = await r.json(); } catch {}
  const done = new Set([...(state.meta.filmImports || []), ...(state.meta.filmDeclined || [])]);
  for (const f of files) {
    if (done.has(f)) continue;
    try { const r = await fetch("imports/" + f); if (!r.ok) continue; const data = await r.json(); state.filmOffer = { file: f, source: data.source || f, films: data.films || [] }; return; } catch {}
  }
}
async function importFilmOffer() {
  const o = state.filmOffer; if (!o) return;
  const have = new Set(state.films.flatMap((f) => [norm(f.title), norm(f.originalTitle)]).filter(Boolean));
  let n = 0;
  for (const x of o.films) {
    if (!x.title || have.has(norm(x.title))) continue;
    state.films.push({ id: fslug(x.title), title: x.title, searchTitle: x.searchTitle || undefined, year: x.year || null, status: "done", rating: 0, seenAt: x.last, firstSeen: x.first, lastSeen: x.last, views: x.count || 1, genres: [], cast: [], directors: [], needsInfo: true, imported: true, source: o.source, ...(x.strict ? { strict: true } : {}), addedAt: new Date().toISOString(), updatedAt: x.last + "T12:00:00.000Z" });
    have.add(norm(x.title)); n++;
  }
  state.meta.filmImports = [...(state.meta.filmImports || []), o.file];
  state.filmOffer = null;
  await persist(); render();
  snack(`${plural(n, "film ajouté")} depuis ${o.source}. Récupération des fiches…`, null, 6000);
  enrichFilms();
}

// Ajout d'un film
let fFound = null;
function openAddFilm() {
  fFound = null;
  $("filmForm").reset();
  for (const id of ["fNote", "fCands", "fFoundBox", "fErr", "fDetails", "fManual"]) $(id).hidden = true;
  $("filmDlg").showModal();
  $("f-q").focus();
}
async function lookupFilm() {
  const q = $("f-q").value.trim(), note = $("fNote");
  note.hidden = false; note.className = "note";
  if (!q) { note.textContent = "Tape d'abord le titre du film."; return; }
  $("fFoundBox").hidden = true; $("fDetails").hidden = true; fFound = null;
  if (!tmdbReady()) { note.textContent = "Recherche de films indisponible dans cette version : saisis le film à la main."; $("fManual").hidden = false; return; }
  $("fLookup").disabled = true; $("fLookup").innerHTML = `<span class="spinner"></span>Recherche`;
  note.textContent = "Recherche…";
  try {
    const list = await searchFilms(getJson, q);
    $("fCands").innerHTML = list.map(filmCandHtml).join("");
    $("fCands").hidden = !list.length;
    note.textContent = list.length ? "Choisis le bon film :" : "Aucun film trouvé. Essaie le titre original, ou saisis-le à la main.";
  } catch { note.className = "note err"; note.textContent = "Pas de réponse de TMDB. Vérifie ta connexion, ou saisis le film à la main."; }
  finally { $("fManual").hidden = false; $("fLookup").disabled = false; $("fLookup").innerHTML = `${icon("travel_explore")}Rechercher`; }
}
function filmDetails(d) {
  $("f-year").value = d.year || "";
  $("fDetails").hidden = false;
  $("f-status").dispatchEvent(new Event("change"));
}
$("filmClose").addEventListener("click", () => $("filmDlg").close());
$("f-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookupFilm(); } });
$("fLookup").addEventListener("click", lookupFilm);
$("fManual").addEventListener("click", () => { fFound = null; $("fCands").hidden = true; $("fFoundBox").hidden = true; filmDetails({}); $("fNote").textContent = "Saisie manuelle : la fiche pourra être complétée plus tard depuis le film."; $("fNote").hidden = false; });
$("f-status").addEventListener("change", () => { $("fSeenBox").hidden = $("f-status").value !== "done"; if (!$("f-seen").value) $("f-seen").value = todayISO(); });
$("fCands").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-ref]"); if (!b) return;
  const note = $("fNote");
  note.className = "note"; note.textContent = "Chargement de la fiche…"; note.hidden = false;
  try {
    fFound = await loadFilm(getJson, b.dataset.ref);
    $("fFoundBox").innerHTML = `<div class="found">${poster(fFound)}<div class="grow"><div class="t">${esc(fFound.title)}</div>
      <div class="s-sub">${esc(filmMeta(fFound))}</div>
      <div class="s-sub">${esc(fFound.cast.slice(0, 3).map((c) => c.name).join(", "))}</div>${fFound.summary ? `<p>${esc(fFound.summary)}</p>` : ""}</div></div>`;
    $("fFoundBox").hidden = false; $("fCands").hidden = true;
    note.textContent = "Fiche TMDB trouvée. Indique si tu l'as vu, puis ajoute-le.";
    filmDetails(fFound);
  } catch { note.className = "note err"; note.textContent = "Pas de réponse de TMDB. Vérifie ta connexion."; }
});
$("filmForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("fDetails").hidden) return lookupFilm();
  const err = (m) => { $("fErr").textContent = m; $("fErr").hidden = false; };
  const title = (fFound && fFound.title) || $("f-q").value.trim();
  if (!title) return err("Donne un titre au film.");
  if (fFound && state.films.some((x) => x.ref === fFound.ref)) return err("Ce film est déjà dans ta liste.");
  const status = $("f-status").value, now = new Date().toISOString();
  const base = fFound ? clone(fFound) : { title, genres: [], cast: [], directors: [] };
  const posterUrl = base.posterUrl; delete base.posterUrl;
  const f = { ...base, id: fslug(title), title, year: +$("f-year").value || base.year || null, status, rating: 0, addedAt: now, updatedAt: now, ...(status === "done" ? { seenAt: $("f-seen").value || todayISO() } : {}), ...(fFound ? { infoAt: now } : {}) };
  $("fSave").disabled = true;
  if (posterUrl) { try { await savePoster(f, posterUrl); f.posterFrom = posterUrl; f.posterUrl = posterUrl; } catch {} }
  state.films.push(f);
  await persist();
  $("fSave").disabled = false;
  $("filmDlg").close(); snack(`${title} ajouté`); openDetail(f.id, "film");
});

// ---------- Import CSV ou liste collée ----------
const COLS = {
  title: ["titre", "title", "serie", "series", "nom", "name", "titredelaserie"],
  status: ["statut", "status", "etat"],
  upTo: ["vujusqua", "vujusqu", "progression", "dernierepisode", "dernierepisodevu", "episode", "upto"],
  rating: ["note", "rating", "notesur5", "score"],
  year: ["annee", "year", "anneedecreation", "date"],
  seasons: ["saisons", "seasons", "episodesparsaison", "episodes"],
};
function colOf(h) { const n = norm(h); for (const [k, list] of Object.entries(COLS)) if (list.includes(n)) return k; return null; }
function normStatus(v) {
  const n = norm(v);
  if (!n) return null;
  if (/^(pasvu|pascommence|avoir|todo|envie|alist|watchlist)/.test(n)) return "todo";
  if (/^(abandon|drop|arret|stop)/.test(n)) return "dropped";
  if (/^(encours|cours|watching|commence|current)/.test(n)) return "watching";
  if (/^(termin|fini|vu|vue|vues|done|complet|regarde|completed|watched|oui|x)$/.test(n) || /^(termin|fini|complet)/.test(n)) return "done";
  return null;
}
function parseRating(v) {
  const m = String(v || "").trim().match(/^(\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+))?$/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", ".")), scale = m[2] ? +m[2] : val > 5 ? 10 : 5;
  return scale ? Math.max(0, Math.min(5, Math.round((val / scale) * 5))) : null;
}
function parseSeasons(v) {
  const nums = String(v || "").split(/[|/+;\s-]+/).filter(Boolean).map(Number);
  return nums.length && nums.every((n) => Number.isInteger(n) && n > 0 && n <= 500) ? nums : null;
}
function splitRows(text, d) {
  const out = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && !cell.trim()) { q = true; cell = ""; }
    else if (d && c === d) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += c;
  }
  row.push(cell); out.push(row);
  return out.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}
function parseList(text) {
  text = String(text || "").replace(/^﻿/, "");
  const first = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const d = [";", "\t", ","].map((c) => [c, first.split(c).length - 1]).sort((a, b) => b[1] - a[1])[0];
  const rows = splitRows(text, d[1] ? d[0] : null);
  if (!rows.length) return [];
  const map = rows[0].map(colOf), hasHeader = map.includes("title");
  const body = hasHeader ? rows.slice(1) : rows;
  return body.map((r) => {
    const it = {};
    if (hasHeader) r.forEach((v, i) => { if (map[i] && v && it[map[i]] == null) it[map[i]] = v; });
    else {
      it.title = r[0];
      for (const v of r.slice(1)) {
        if (parseUpTo(v)) it.upTo = it.upTo || v;
        else if (/^(19|20)\d\d$/.test(v)) it.year = it.year || v;
        else if (normStatus(v)) it.status = it.status || v;
        else if (parseRating(v) != null) it.rating = it.rating || v;
      }
    }
    const up = it.upTo ? parseUpTo(it.upTo) : null;
    return {
      title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
      status: normStatus(it.status), upTo: up ? code(up.s, up.e) : null,
      rating: parseRating(it.rating), year: /^\d{4}$/.test(String(it.year || "").trim()) ? +String(it.year).trim() : null,
      seasons: parseSeasons(it.seasons),
    };
  }).filter((x) => x.title);
}

let impItems = [];
function impPreview() {
  const items = parseList($("impText").value), def = $("impDefault").value, film = state.impKind === "film";
  const have = new Set((film ? state.films : state.series).map((s) => norm(s.title))), seen = new Set();
  impItems = items.map((x) => {
    const k = norm(x.title), dup = have.has(k) || seen.has(k);
    seen.add(k);
    // Films : pas d'« en cours », un film commencé reste à voir.
    const status = x.status || (x.upTo && !film ? "watching" : def);
    return { ...x, status: film && status === "watching" ? "todo" : status, dup };
  });
  const n = impItems.filter((x) => !x.dup).length, dups = impItems.length - n;
  const btn = $("impGo");
  btn.disabled = !n;
  btn.innerHTML = `${icon("playlist_add")}${n ? `Importer ${plural(n, film ? "film" : "série")}` : "Importer"}`;
  if (!impItems.length) { $("impPreview").innerHTML = $("impText").value.trim() ? `<p class="note err">Aucun titre reconnu. Mets un titre par ligne, ou une colonne « titre » dans ton CSV.</p>` : ""; return; }
  $("impPreview").innerHTML = `<p class="note"><b class="num">${n}</b> à importer${dups ? `, ${dups} déjà dans ta liste (ignorée${dups > 1 ? "s" : ""})` : ""}. Les fiches et affiches seront ensuite récupérées automatiquement.</p>
    <div class="prev">${impItems.slice(0, 200).map((x) => `<div class="prev-row ${x.dup ? "skip" : ""}"><span class="t">${esc(x.title)}${x.year ? ` <span class="s-sub">(${x.year})</span>` : ""}</span>${x.upTo ? `<span class="code">${x.upTo}</span>` : ""}${x.rating ? `<span class="num s-sub">${x.rating}/5</span>` : ""}<span class="tag ${x.status === "done" ? "done" : x.status === "watching" ? "watching" : ""}">${(film ? FSTATUS : STATUS)[x.status]}</span></div>`).join("")}${impItems.length > 200 ? `<p class="note">… et ${impItems.length - 200} autres.</p>` : ""}</div>`;
}
function openImport() {
  const film = state.impKind === "film";
  for (const d of ["addDlg", "filmDlg", "menuDlg"]) if ($(d).open) $(d).close();
  $("impTitle").textContent = film ? "Importer des films" : "Importer des séries";
  $("impHelp").innerHTML = film
    ? `Un fichier CSV (export Excel, Letterboxd, Notion…) ou une simple liste collée, un film par ligne. Seul le titre est obligatoire ; les colonnes reconnues sont <span class="code">titre</span>, <span class="code">statut</span> (vu, à voir), <span class="code">note</span> (sur 5) et <span class="code">annee</span>.`
    : `Un fichier CSV (export Excel, Google Sheets, Notion…) ou une simple liste collée, une série par ligne. Seul le titre est obligatoire ; les colonnes reconnues sont <span class="code">titre</span>, <span class="code">statut</span>, <span class="code">vu_jusqu_a</span> (ex. S02E05), <span class="code">note</span> (sur 5), <span class="code">annee</span> et <span class="code">saisons</span> (épisodes par saison, ex. 8|10|10).`;
  $("impDefault").innerHTML = film
    ? `<option value="done">Vu</option><option value="todo">À voir</option>`
    : `<option value="done">Terminée (déjà vue)</option><option value="watching">En cours</option><option value="todo">À voir</option>`;
  $("impText").value = ""; $("impFile").value = ""; impItems = []; impPreview();
  $("impDlg").showModal();
}
$("toImport").addEventListener("click", () => { state.impKind = "series"; openImport(); });
$("fToImport").addEventListener("click", () => { state.impKind = "film"; openImport(); });
$("impClose").addEventListener("click", () => $("impDlg").close());
let impTimer;
$("impText").addEventListener("input", () => { clearTimeout(impTimer); impTimer = setTimeout(impPreview, 250); });
$("impDefault").addEventListener("change", impPreview);
$("impFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  if (f.size > 2e6) { snack("Fichier trop gros (2 Mo maximum)."); return; }
  const buf = await f.arrayBuffer();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); } // exports Excel français
  $("impText").value = text; impPreview();
});
$("impTpl").addEventListener("click", async () => {
  if (state.impKind === "film") return shareText("modele-mes-films.csv", "﻿titre;statut;note;annee\r\nLe Voyage de Chihiro;vu;5;2001\r\nDune;à voir;;2021\r\nTenet;vu;3;2020\r\n", "Modèle d'import de films");
  const csv = "﻿titre;statut;vu_jusqu_a;note;annee\r\nBreaking Bad;terminée;;5;2008\r\nThe Office;en cours;S03E12;4;2005\r\nFleabag;à voir;;;\r\nLupin;abandonnée;S01E03;2;2021\r\n";
  await shareText("modele-mes-series.csv", csv, "Modèle d'import Mes séries");
});
$("impGo").addEventListener("click", async () => {
  const items = impItems.filter((x) => !x.dup);
  if (!items.length) return;
  const now = new Date().toISOString();
  if (state.impKind === "film") {
    for (const x of items) state.films.push({ id: fslug(x.title), title: x.title, year: x.year, status: x.status, rating: x.rating || 0, genres: [], cast: [], directors: [], needsInfo: true, imported: true, addedAt: now, updatedAt: now, ...(x.status === "done" ? { seenAt: todayISO() } : {}) });
    await persist();
    $("impDlg").close();
    state.fFilter = "all"; go("films");
    snack(`${plural(items.length, "film importé")}`);
    setTimeout(enrichFilms, 400);
    return;
  }
  for (const x of items) {
    const s = { id: slug(x.title), title: x.title, year: x.year, status: x.status, rating: x.rating || 0, seasons: (x.seasons || []).map((count, i) => ({ n: i + 1, count })), watched: {}, genres: [], cast: [], creators: [], directors: [], needsInfo: true, addedAt: now, updatedAt: now, imported: true };
    if (x.upTo) s.upTo = x.upTo;
    if (x.status === "done") s.finishedAt = todayISO();
    applyProgress(s);
    if (!s.seasons.length && x.upTo) s.upTo = x.upTo;
    state.series.push(s);
  }
  await persist();
  $("impDlg").close();
  state.filter = "all"; go("lib");
  snack(`${plural(items.length, "série importée")}`);
  setTimeout(enrichAll, 400);
});

// ---------- Menu : sauvegarde ----------
async function shareText(name, text, title) {
  if (native) {
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: "utf8" });
    await Share.share({ title, files: [uri], dialogTitle: "Envoyer vers…" });
  } else {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; a.click();
  }
}
$("menuBtn").addEventListener("click", () => {
  const film = state.tab === "films";
  $("mImportT").textContent = film ? "Importer une liste de films" : "Importer une liste de séries";
  $("mRefresh").hidden = film;
  const nf = state.meta.filmDeclined && state.meta.filmDeclined.length && !state.filmOffer;
  $("mFilmsNetflix").hidden = !(film && nf);
  $("lastExport").textContent = state.meta.lastExport ? `Dernier envoi le ${fmtLong(state.meta.lastExport)}` : "Aucun envoi pour l'instant";
  $("lastCheck").textContent = state.meta.checkedAt ? `Dernière vérification le ${fmtLong(state.meta.checkedAt)}` : "Nouveaux épisodes, dates de diffusion";
  $("menuDlg").showModal();
});
$("menuClose").addEventListener("click", () => $("menuDlg").close());
$("mImport").addEventListener("click", () => { state.impKind = state.tab === "films" ? "film" : "series"; openImport(); });
$("mFilmsNetflix").addEventListener("click", async () => {
  $("menuDlg").close();
  state.meta.filmDeclined = []; await filmOffer();
  if (state.filmOffer) importFilmOffer(); else snack("Plus de films à importer depuis Netflix.");
});
$("mExport").addEventListener("click", async () => {
  try {
    // Les affiches ne sont pas incluses : elles se re-téléchargent à la restauration.
    const strip = (s) => { const c = clone(s); delete c.poster; return c; };
    await shareText(`mes-series-${todayISO()}.json`, JSON.stringify({ app: "mes-series", version: 2, exportedAt: new Date().toISOString(), series: state.series.map(strip), films: state.films.map(strip) }), "Sauvegarde Mes séries");
    state.meta.lastExport = new Date().toISOString(); await persist();
    $("lastExport").textContent = `Dernier envoi le ${fmtLong(state.meta.lastExport)}`;
  } catch (e) { if (!/cancel/i.test(String(e && e.message))) snack("La sauvegarde n'a pas pu être envoyée."); }
});
$("mRestore").addEventListener("click", () => $("restoreFile").click());
$("restoreFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || d.app !== "mes-series" || !Array.isArray(d.series) || d.series.some((s) => !s.id || !s.title)) throw new Error();
    // Sauvegarde v1 (avant les films) : seules les séries sont remplacées, les films restent.
    const films = Array.isArray(d.films) ? d.films.filter((f) => f.id && f.title) : null;
    if (!confirm(`Remplacer tes séries actuelles (${state.series.length}) par celles du fichier (${d.series.length})${films ? ` et tes films (${state.films.length}) par ceux du fichier (${films.length})` : ""} ?`)) return;
    const reset = (s) => { delete s.poster; delete s.posterFrom; return s; };
    state.series = d.series.map(reset);
    if (films) state.films = films.map(reset);
    await persist(); $("menuDlg").close(); go("lib");
    snack(`${plural(d.series.length, "série restaurée")}${films ? `, ${plural(films.length, "film restauré")}` : ""}. Récupération des affiches…`);
    for (const s of [...state.series, ...state.films]) { if (s.posterUrl) { try { await savePoster(s, s.posterUrl); s.posterFrom = s.posterUrl; } catch {} } }
    await persist(); render();
  } catch { snack("Ce fichier n'est pas une sauvegarde Mes séries."); }
});
$("mRefresh").addEventListener("click", async () => { $("menuDlg").close(); snack("Recherche de nouveaux épisodes…"); await refreshAiring(); });

// ---------- Bouton retour Android ----------
App.addListener("backButton", () => {
  const open = [...document.querySelectorAll("dialog[open]")].pop();
  if (open) { open.close(); return; }
  if (state.searchOpen) { $("searchClose").click(); return; }
  if (state.detailId && state.fixOpen) { state.fixOpen = false; render(); return; }
  if (state.detailId) { back(); return; }
  if (state.tab !== "lib") { go("lib"); return; }
  App.exitApp();
}).catch(() => {});
App.addListener("pause", () => { persist(); }).catch(() => {});

// ---------- Démarrage ----------
render();
load().then(() => {
  render();
  if (state.films.some((f) => f.needsInfo === true)) enrichFilms();
  if (state.series.some((s) => s.needsInfo === true || (s.tmdbPending && tmdbReady()))) enrichAll().then(() => refreshAiring({ silent: true }));
  else {
    const last = state.meta.checkedAt ? new Date(state.meta.checkedAt) : null;
    if (!last || Date.now() - last > 2 * 86400000) refreshAiring({ silent: true });
  }
});
