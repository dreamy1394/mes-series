// Accès à TMDB (The Movie Database) : fiches en français (titres, résumés, épisodes, affiches).
// La clé TMDB (lecture seule) n'est pas dans le dépôt : elle vient du secret GitHub TMDB_KEY, injecté
// à la compilation (scripts/build.mjs) ou lu dans l'environnement par les scripts de test.
// Sans clé, les appels échouent et l'appli se rabat sur TVmaze.
// `get(url)` est fourni par l'appelant et renvoie le JSON (null si 404).
import { matchIn } from "./tvmaze.js";

export const TMDB = "https://api.themoviedb.org/3";
/* global __TMDB_KEY__ */
const KEY = typeof __TMDB_KEY__ !== "undefined" ? __TMDB_KEY__ : (globalThis.process && process.env.TMDB_KEY) || "";
export const hasKey = () => !!KEY;
const IMG = "https://image.tmdb.org/t/p/";

const url = (path, params = {}) => {
  if (!KEY) throw new Error("tmdb: pas de clé");
  return `${TMDB}${path}?${new URLSearchParams({ api_key: KEY, language: "fr-FR", ...params })}`;
};
const year = (d) => (d && /^\d{4}/.test(d) ? +d.slice(0, 4) : null);
const country = (code) => {
  if (!code) return "";
  try { return new Intl.DisplayNames(["fr"], { type: "region" }).of(code) || ""; } catch { return ""; }
};

export async function searchShows(get, q) {
  const r = await get(url("/search/tv", { query: q, include_adult: "false" }));
  return ((r && r.results) || []).slice(0, 8).map((s) => ({
    id: s.id, ref: "tmdb:" + s.id, title: s.name, originalTitle: s.original_name,
    year: year(s.first_air_date), endYear: null, network: "", country: country((s.origin_country || [])[0]),
    poster: s.poster_path ? IMG + "w154" + s.poster_path : null,
  }));
}

export const bestMatch = (get, queries, wantedYear, maxYear) => matchIn((q) => searchShows(get, q), queries, wantedYear, maxYear);

// Série TMDB correspondant à un identifiant IMDb (fiches TVmaze déjà associées).
export async function findByImdb(get, imdb) {
  const r = await get(url(`/find/${imdb}`, { external_source: "imdb_id" }));
  const t = r && (r.tv_results || [])[0];
  return t ? t.id : null;
}

// Fiche complète : détails + casting, puis les épisodes par lots de 20 saisons (limite d'append_to_response).
export async function loadShow(get, id) {
  const s = await get(url(`/tv/${id}`, { append_to_response: "aggregate_credits,external_ids" }));
  if (!s) throw new Error("tmdb 404");
  const nums = (s.seasons || []).map((x) => x.season_number).filter((n) => n >= 1).sort((a, b) => a - b);
  const eps = {};
  for (let i = 0; i < nums.length; i += 20) {
    const chunk = nums.slice(i, i + 20);
    const r = await get(url(`/tv/${id}`, { append_to_response: chunk.map((n) => "season/" + n).join(",") }));
    for (const n of chunk) eps[n] = ((r && r["season/" + n]) || {}).episodes || [];
  }
  // Pas de résumé traduit : on prend l'anglais plutôt que rien.
  if (!s.overview) { try { const en = await get(url(`/tv/${id}`, { language: "en-US" })); s.overview = (en && en.overview) || ""; } catch {} }
  return toSeries(s, eps);
}

export function toSeries(s, eps) {
  const seasons = Object.keys(eps).map(Number).sort((a, b) => a - b).map((n) => {
    const list = eps[n].filter((e) => e && e.episode_number != null).sort((a, b) => a.episode_number - b.episode_number);
    return { n, count: list.length, year: year((list[0] || {}).air_date), titles: list.map((e) => e.name || ""), dates: list.map((e) => e.air_date || "") };
  }).filter((x) => x.count > 0);
  const ended = s.status === "Ended" || s.status === "Canceled";
  const lastDate = seasons.length ? seasons[seasons.length - 1].dates.filter(Boolean).pop() : null;
  const cr = s.aggregate_credits || {};
  const directors = (cr.crew || []).filter((c) => (c.jobs || []).some((j) => j.job === "Director"))
    .sort((a, b) => (b.total_episode_count || 0) - (a.total_episode_count || 0)).map((c) => c.name);
  const net = (s.networks || [])[0] || {};
  const firstEp = ((eps[seasons[0] && seasons[0].n] || [])[0]) || {};
  return {
    tmdbId: s.id, ref: "tmdb:" + s.id, source: "TMDB",
    title: s.name || s.original_name || "", originalTitle: s.original_name || s.name || "",
    year: year(s.first_air_date), endYear: ended ? year(lastDate) || year(s.last_air_date) : null,
    airing: ["Returning Series", "In Production", "Planned", "Pilot"].includes(s.status),
    network: net.name || "", country: country((s.origin_country || [])[0] || net.origin_country),
    genres: (s.genres || []).map((g) => g.name).slice(0, 4),
    runtime: (s.episode_run_time || [])[0] || (s.last_episode_to_air || {}).runtime || firstEp.runtime || null,
    creators: (s.created_by || []).map((c) => c.name).filter(Boolean).slice(0, 4),
    directors: [...new Set(directors)].slice(0, 4),
    cast: (cr.cast || []).slice(0, 6).map((c) => ({ name: c.name || "", role: ((c.roles || [])[0] || {}).character || "" })).filter((c) => c.name),
    summary: String(s.overview || "").trim().slice(0, 1500),
    seasons,
    posterUrl: s.poster_path ? IMG + "w342" + s.poster_path : null,
    imdb: (s.external_ids || {}).imdb_id || null,
  };
}
