// Sources des fiches : TMDB d'abord (français), TVmaze en secours.
// Une fiche est identifiée par `ref` : « tmdb:1396 » ou « tvmaze:169 ».
import * as tmdb from "./tmdb.js";
import * as tvmaze from "./tvmaze.js";

export const tmdbReady = () => tmdb.hasKey();
export const refOf = (s) => s.ref || (s.tvmazeId ? "tvmaze:" + s.tvmazeId : null);

// Candidats pour une recherche manuelle : TMDB, complétés par TVmaze si TMDB ne donne rien.
export async function search(get, q) {
  let list = [];
  if (tmdb.hasKey()) try { list = await tmdb.searchShows(get, q); } catch {}
  if (!list.length) list = await tvmaze.searchShows(get, q);
  return list;
}

// Correspondance automatique d'après le titre : `ref` ou null.
export async function match(get, queries, wantedYear, maxYear) {
  let tmdbFailed = false;
  if (tmdb.hasKey()) {
    try { const id = await tmdb.bestMatch(get, queries, wantedYear, maxYear); if (id) return "tmdb:" + id; }
    catch (e) { tmdbFailed = true; }
  }
  const id = await tvmaze.bestMatch(get, queries, wantedYear, maxYear);
  if (id) return "tvmaze:" + id;
  if (tmdbFailed) throw new Error("network");
  return null;
}

// Fiche TVmaze existante → même série sur TMDB (par l'identifiant IMDb, sinon titre original + année exacte).
export async function toTmdb(get, s) {
  if (s.imdb) { const id = await tmdb.findByImdb(get, s.imdb); if (id) return "tmdb:" + id; }
  if (!s.year) return null;
  for (const q of [...new Set([s.originalTitle, s.title].filter(Boolean))]) {
    const hit = (await tmdb.searchShows(get, q)).find((x) => x.year && Math.abs(x.year - s.year) <= 1 && [x.title, x.originalTitle].some((t) => tvmaze.closeTitle(t, q)));
    if (hit) return hit.ref;
  }
  return null;
}

export function load(get, ref) {
  const [src, id] = String(ref).split(":");
  return src === "tmdb" ? tmdb.loadShow(get, +id) : tvmaze.loadShow(get, +id);
}
