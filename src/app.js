// Mes séries : application Android (Capacitor). Données sur le téléphone, fiches et affiches depuis TMDB (en français), TVmaze en secours.
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { App } from "@capacitor/app";
import { Share } from "@capacitor/share";
import { search as searchShows, match as bestMatch, load as loadShow, toTmdb, refOf, tmdbReady } from "./sources.js";

const $ = (id) => document.getElementById(id);
const state = { series: [], meta: {}, loaded: false, tab: "lib", detailId: null, filter: "all", sort: "recent", q: "", searchOpen: false, open: {}, listScroll: 0, enrich: null };
const native = Capacitor.isNativePlatform();

// ---------- Outils ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, fill) => `<span class="ms${fill ? " fill" : ""}" aria-hidden="true">${n}</span>`;
const p2 = (n) => String(n).padStart(2, "0");
const code = (s, e) => `S${p2(s)}E${p2(e)}`;
const plural = (n, w) => `${n} ${n > 1 ? w.split(" ").map((x) => x + "s").join(" ") : w}`;
const STATUS = { todo: "À voir", watching: "En cours", done: "Terminée", dropped: "Abandonnée" };
const find = (id) => state.series.find((s) => s.id === id);
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
  try { state.filter = (await Preferences.get({ key: "filter" })).value || "all"; } catch {}
  try { state.sort = (await Preferences.get({ key: "sort" })).value || "recent"; } catch {}
  await bundledImports();
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

function nextView() {
  if (!state.loaded) return loading();
  const rows = state.series.map((s) => ({ s, st: stats(s) }));
  const going = rows.filter((r) => bucket(r.s) === "watching" && r.st.next && r.s.status !== "dropped").sort((a, b) => String(b.s.updatedAt || "").localeCompare(String(a.s.updatedAt || "")));
  const soon = rows.filter((r) => r.st.upcoming && r.s.status !== "dropped").sort((a, b) => a.st.upcoming.date.localeCompare(b.st.upcoming.date));
  const todo = rows.filter((r) => bucket(r.s) === "todo" && r.st.next);
  const sm = (s) => `${poster(s, "sm")}`;
  let html = `<div class="h2">Reprendre <small>${plural(going.length, "série")}</small></div>`;
  html += going.length ? `<div class="panel">${going.map(({ s, st }) => `<div class="row">${sm(s)}<div class="row-body" data-act="open" data-id="${esc(s.id)}" role="button" tabindex="0"><div class="s-t" style="font-size:15px">${esc(s.title)}</div><div class="s-sub"><span class="code">${code(st.next.s, st.next.e)}</span>${st.next.title ? " · " + esc(st.next.title) : ""}</div><div class="bar"><span style="width:${st.pct}%"></span></div></div>
    <button class="seen-btn" type="button" data-act="seen" data-id="${esc(s.id)}" aria-label="Marquer ${code(st.next.s, st.next.e)} comme vu">${icon("done")}</button></div>`).join("")}</div>`
    : `<div class="info">${icon("weekend")}<span>Rien en cours. Coche un premier épisode d'une série pour la retrouver ici.</span></div>`;
  if (soon.length) html += `<div class="h2">Prochaines diffusions</div><div class="panel">${soon.map(({ s, st }) => `<div class="row">${sm(s)}<div class="row-body" data-act="open" data-id="${esc(s.id)}" role="button" tabindex="0"><div class="s-t" style="font-size:15px">${esc(s.title)}</div><div class="s-sub"><span class="code">${code(st.upcoming.s, st.upcoming.e)}</span> · ${whenLong(st.upcoming.date)}</div></div></div>`).join("")}</div>`;
  if (todo.length) html += `<div class="h2">Pas encore commencées <small>${todo.length}</small></div><div class="panel">${todo.map(({ s, st }) => `<div class="row">${sm(s)}<div class="row-body" data-act="open" data-id="${esc(s.id)}" role="button" tabindex="0"><div class="s-t" style="font-size:15px">${esc(s.title)}</div><div class="s-sub">${plural(st.seasons.length, "saison")} · ${st.total} ép.${s.runtime ? ` · ${s.runtime} min` : ""}</div></div>
    <button class="btn soft small" type="button" data-act="seen" data-id="${esc(s.id)}">${icon("play_arrow")}S01E01</button></div>`).join("")}</div>`;
  return html;
}

function statsView() {
  if (!state.loaded) return loading();
  const all = state.series;
  if (!all.length) return `<div class="empty">${icon("insights")}<strong>Pas encore de bilan</strong><span>Ajoute des séries et coche tes épisodes pour voir ton temps passé devant l'écran.</span></div>`;
  let eps = 0, mins = 0;
  for (const s of all) { const n = stats(s).seen; eps += n; mins += n * (s.runtime || 0); }
  const done = all.filter((s) => s.status === "done").length, hours = Math.round(mins / 60);
  let html = `<div class="tiles">
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
  const inDetail = !!state.detailId, s = inDetail ? find(state.detailId) : null;
  $("backBtn").hidden = !inDetail;
  $("appbar").classList.toggle("with-back", inDetail);
  $("searchBtn").hidden = inDetail || state.tab !== "lib";
  $("menuBtn").hidden = inDetail || state.tab !== "lib";
  $("refreshBtn").hidden = !inDetail || !s;
  $("delBtn").hidden = !inDetail || !s;
  $("searchbar").hidden = inDetail || state.tab !== "lib" || !state.searchOpen;
  $("barTitle").innerHTML = inDetail ? esc(s ? s.title : "") : esc({ lib: "Mes séries", next: "À suivre", stats: "Bilan" }[state.tab]) + (state.tab === "lib" ? `<span class="dot" aria-hidden="true"></span>` : "");
  $("fab").hidden = inDetail || state.tab === "stats";
  for (const b of document.querySelectorAll(".nav-item")) b.setAttribute("aria-current", !inDetail && b.dataset.tab === state.tab ? "page" : "false");
  const nGoing = state.series.filter((x) => bucket(x) === "watching" && x.status !== "dropped" && stats(x).next).length;
  $("nextBadge").hidden = !nGoing; $("nextBadge").textContent = nGoing;
  const html = inDetail ? detailView() : state.tab === "next" ? nextView() : state.tab === "stats" ? statsView() : libView();
  const key = inDetail ? "d:" + state.detailId : state.tab, main = $("main");
  const typing = document.activeElement && document.activeElement.id === "fixTitle" ? $("fixTitle").value : null;
  const cands = $("fixCands") ? $("fixCands").innerHTML : "";
  if (main.dataset.key !== key) { main.innerHTML = `<div class="view">${html}</div>`; main.dataset.key = key; }
  else main.firstElementChild.innerHTML = html;
  if ($("fixCands") && cands) $("fixCands").innerHTML = cands;
  if (typing !== null && $("fixTitle")) { $("fixTitle").value = typing; $("fixTitle").focus(); }
}
function go(tab) { state.tab = tab; state.detailId = null; render(); window.scrollTo(0, 0); }
function openDetail(id) { state.fixOpen = false; if (!state.detailId) state.listScroll = window.scrollY; state.detailId = id; render(); window.scrollTo(0, 0); }
function back() { state.detailId = null; render(); window.scrollTo(0, state.listScroll); }
window.addEventListener("scroll", () => $("appbar").classList.toggle("scrolled", window.scrollY > 4), { passive: true });

// ---------- Événements ----------
document.querySelector(".navbar").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
$("backBtn").addEventListener("click", back);
$("searchBtn").addEventListener("click", () => { state.searchOpen = true; render(); $("search").focus(); });
$("searchClose").addEventListener("click", () => { state.searchOpen = false; state.q = ""; $("search").value = ""; render(); });
$("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
$("fab").addEventListener("click", openAdd);

$("main").addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-act]"); if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act === "filter") { state.filter = el.dataset.f; Preferences.set({ key: "filter", value: state.filter }).catch(() => {}); render(); return; }
  if (act === "toggle") { const k = el.dataset.k; state.open[k] = el.getAttribute("aria-expanded") !== "true"; render(); return; }
  if (act === "enrich") { enrichAll(); return; }
  if (act === "fixopen") { state.fixOpen = true; render(); return; }
  if (act === "pick") { const s = find(state.detailId); if (s) { state.fixOpen = false; s.picked = true; applyShow(s, el.dataset.tv).catch(() => snack("Pas de réponse des bases de séries. Vérifie ta connexion.")); } return; }
  const s = el.dataset.id ? find(el.dataset.id) : find(state.detailId);
  if (!s) return;
  if (act === "open") return openDetail(s.id);
  if (act === "seen") { ev.stopPropagation(); markNext(s); }
  if (act === "status") { s.status = el.dataset.v; if (s.status === "done" && !s.finishedAt) s.finishedAt = todayISO(); touch(s); }
  if (act === "rate") { const v = +el.dataset.v; s.rating = s.rating === v ? 0 : v; touch(s); }
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
  if (e.target.dataset.act !== "sort") return;
  state.sort = e.target.value; Preferences.set({ key: "sort", value: state.sort }).catch(() => {}); render();
});
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
  const s = find(state.detailId); if (!s) return;
  $("confirmTxt").textContent = `${s.title} et les ${stats(s).seen} épisode(s) cochés seront retirés de ta liste.`;
  $("confirmDlg").showModal();
});
$("confirmNo").addEventListener("click", () => $("confirmDlg").close());
$("confirmYes").addEventListener("click", async () => {
  const s = find(state.detailId); $("confirmDlg").close(); if (!s) return;
  state.series = state.series.filter((x) => x.id !== s.id);
  if (s.poster) Filesystem.deleteFile({ path: s.poster, directory: Directory.Data }).catch(() => {});
  await persist(); back(); snack(`${s.title} supprimée`);
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
  const s = { ...base, id: slug(title), title, year: +$("a-year").value || base.year || null, network: $("a-network").value.trim() || base.network || "", seasons, watched: {}, status, rating: 0, addedAt: now, updatedAt: now, upTo: up ? code(up.s, up.e) : undefined, ...(found ? { infoAt: now } : {}) };
  if (status === "done") s.finishedAt = todayISO();
  applyProgress(s);
  $("saveBtn").disabled = true;
  if (posterUrl) { try { await savePoster(s, posterUrl); s.posterFrom = posterUrl; } catch {} }
  state.series.push(JSON.parse(JSON.stringify(s)));
  await persist();
  $("saveBtn").disabled = false;
  $("addDlg").close(); snack(`${title} ajoutée`); openDetail(s.id);
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
  const items = parseList($("impText").value), def = $("impDefault").value;
  const have = new Set(state.series.map((s) => norm(s.title))), seen = new Set();
  impItems = items.map((x) => {
    const k = norm(x.title), dup = have.has(k) || seen.has(k);
    seen.add(k);
    return { ...x, status: x.status || (x.upTo ? "watching" : def), dup };
  });
  const n = impItems.filter((x) => !x.dup).length, dups = impItems.length - n;
  const btn = $("impGo");
  btn.disabled = !n;
  btn.innerHTML = `${icon("playlist_add")}${n ? `Importer ${plural(n, "série")}` : "Importer"}`;
  if (!impItems.length) { $("impPreview").innerHTML = $("impText").value.trim() ? `<p class="note err">Aucun titre reconnu. Mets un titre par ligne, ou une colonne « titre » dans ton CSV.</p>` : ""; return; }
  $("impPreview").innerHTML = `<p class="note"><b class="num">${n}</b> à importer${dups ? `, ${dups} déjà dans ta liste (ignorée${dups > 1 ? "s" : ""})` : ""}. Les fiches et affiches seront ensuite récupérées automatiquement.</p>
    <div class="prev">${impItems.slice(0, 200).map((x) => `<div class="prev-row ${x.dup ? "skip" : ""}"><span class="t">${esc(x.title)}${x.year ? ` <span class="s-sub">(${x.year})</span>` : ""}</span>${x.upTo ? `<span class="code">${x.upTo}</span>` : ""}${x.rating ? `<span class="num s-sub">${x.rating}/5</span>` : ""}<span class="tag ${x.status === "done" ? "done" : x.status === "watching" ? "watching" : ""}">${STATUS[x.status]}</span></div>`).join("")}${impItems.length > 200 ? `<p class="note">… et ${impItems.length - 200} autres.</p>` : ""}</div>`;
}
function openImport() {
  for (const d of ["addDlg", "menuDlg"]) if ($(d).open) $(d).close();
  $("impText").value = ""; $("impFile").value = ""; impItems = []; impPreview();
  $("impDlg").showModal();
}
$("toImport").addEventListener("click", openImport);
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
  const csv = "﻿titre;statut;vu_jusqu_a;note;annee\r\nBreaking Bad;terminée;;5;2008\r\nThe Office;en cours;S03E12;4;2005\r\nFleabag;à voir;;;\r\nLupin;abandonnée;S01E03;2;2021\r\n";
  await shareText("modele-mes-series.csv", csv, "Modèle d'import Mes séries");
});
$("impGo").addEventListener("click", async () => {
  const items = impItems.filter((x) => !x.dup);
  if (!items.length) return;
  const now = new Date().toISOString();
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
  $("lastExport").textContent = state.meta.lastExport ? `Dernier envoi le ${fmtLong(state.meta.lastExport)}` : "Aucun envoi pour l'instant";
  $("lastCheck").textContent = state.meta.checkedAt ? `Dernière vérification le ${fmtLong(state.meta.checkedAt)}` : "Nouveaux épisodes, dates de diffusion";
  $("menuDlg").showModal();
});
$("menuClose").addEventListener("click", () => $("menuDlg").close());
$("mImport").addEventListener("click", openImport);
$("mExport").addEventListener("click", async () => {
  try {
    // Les affiches ne sont pas incluses : elles se re-téléchargent à la restauration.
    const series = state.series.map((s) => { const c = clone(s); delete c.poster; return c; });
    await shareText(`mes-series-${todayISO()}.json`, JSON.stringify({ app: "mes-series", version: 1, exportedAt: new Date().toISOString(), series }), "Sauvegarde Mes séries");
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
    if (!confirm(`Remplacer tes séries actuelles (${state.series.length}) par celles du fichier (${d.series.length}) ?`)) return;
    state.series = d.series.map((s) => { delete s.poster; delete s.posterFrom; return s; });
    await persist(); $("menuDlg").close(); go("lib");
    snack(`${plural(d.series.length, "série restaurée")}. Récupération des affiches…`);
    for (const s of state.series) { if (s.posterUrl) { try { await savePoster(s, s.posterUrl); s.posterFrom = s.posterUrl; } catch {} } }
    await persist(); render();
  } catch { snack("Ce fichier n'est pas une sauvegarde Mes séries."); }
});
$("mRefresh").addEventListener("click", async () => { $("menuDlg").close(); snack("Recherche de nouveaux épisodes…"); await refreshAiring(); });

// ---------- Bouton retour Android ----------
App.addListener("backButton", () => {
  const open = [...document.querySelectorAll("dialog[open]")].pop();
  if (open) { open.close(); return; }
  if (state.searchOpen) { $("searchClose").click(); return; }
  if (state.detailId) { back(); return; }
  if (state.tab !== "lib") { go("lib"); return; }
  App.exitApp();
}).catch(() => {});
App.addListener("pause", () => { persist(); }).catch(() => {});

// ---------- Démarrage ----------
render();
load().then(() => {
  render();
  if (state.series.some((s) => s.needsInfo === true || (s.tmdbPending && tmdbReady()))) enrichAll().then(() => refreshAiring({ silent: true }));
  else {
    const last = state.meta.checkedAt ? new Date(state.meta.checkedAt) : null;
    if (!last || Date.now() - last > 2 * 86400000) refreshAiring({ silent: true });
  }
});
