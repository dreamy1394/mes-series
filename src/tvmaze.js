// Accès à l'API publique TVmaze (gratuite, sans clé) : https://www.tvmaze.com/api
// `get(url)` est fourni par l'appelant (CapacitorHttp dans l'appli, fetch dans les tests) et renvoie le JSON.
export const API = "https://api.tvmaze.com";

const GENRES = {
  Drama: "Drame", Comedy: "Comédie", Thriller: "Thriller", Crime: "Policier", Action: "Action", Adventure: "Aventure",
  "Science-Fiction": "Science-fiction", Fantasy: "Fantastique", Horror: "Horreur", Romance: "Romance", Mystery: "Mystère",
  Family: "Famille", History: "Histoire", War: "Guerre", Western: "Western", Music: "Musique", Sports: "Sport",
  Medical: "Médical", Legal: "Judiciaire", Espionage: "Espionnage", Supernatural: "Surnaturel", Anime: "Animé",
  Children: "Jeunesse", Food: "Cuisine", Travel: "Voyage", Nature: "Nature", DIY: "Bricolage", Adult: "Adulte",
};
const year = (d) => (d && /^\d{4}/.test(d) ? +d.slice(0, 4) : null);
const country = (code) => {
  if (!code) return "";
  try { return new Intl.DisplayNames(["fr"], { type: "region" }).of(code) || ""; } catch { return ""; }
};
export const stripHtml = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Recherche : jusqu'à 8 séries candidates, la plus pertinente d'abord.
export async function searchShows(get, q) {
  const list = await get(`${API}/search/shows?q=${encodeURIComponent(q)}`);
  return (Array.isArray(list) ? list : []).slice(0, 8).map(({ show: s }) => ({
    id: s.id, ref: "tvmaze:" + s.id, title: s.name, originalTitle: s.name, year: year(s.premiered), endYear: year(s.ended),
    network: (s.network || s.webChannel || {}).name || "", country: country(((s.network || s.webChannel || {}).country || {}).code),
    poster: s.image ? s.image.medium : null, status: s.status,
  }));
}

// Correspondance stricte pour un titre seul (import, fiche sans identifiant TVmaze) : on essaie chaque titre
// et on n'accepte qu'un nom identique ou contenu dans le titre (« The Handmaid's Tale: La Servante écarlate » → « The Handmaid's Tale »).
// Sinon null : mieux vaut « introuvable » qu'une mauvaise série.
export const key = (t) => String(t || "").toLowerCase().replace(/×/g, "x").replace(/\([^)]*\)/g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
// Même titre, ou titre TVmaze avec un sous-titre (« Arcane: League of Legends »),
// ou précédé d'un nom (« Tyler Perry's Beauty in Black »). Pas de correspondance approximative : « Safe » ≠ « Safe Home ».
export function closeTitle(found, wanted) {
  const a = key(found), b = key(wanted);
  if (!a || !b) return false;
  if (a === b) return true;
  if (String(found).toLowerCase().startsWith(String(wanted).toLowerCase().trim() + ":")) return true;
  return b.length >= 8 && a.endsWith(b) && /['’]s /.test(found);
}
// `maxYear` : année où Tanguy a commencé la série ; on écarte les homonymes sortis après (ordre de pertinence TVmaze conservé).
export const bestMatch = (get, queries, wantedYear, maxYear) => matchIn((q) => searchShows(get, q), queries, wantedYear, maxYear);

// Commun à TVmaze et TMDB : `search(q)` renvoie des candidats {id, title, originalTitle, year}.
export async function matchIn(search, queries, wantedYear, maxYear) {
  const full = [...new Set((Array.isArray(queries) ? queries : [queries]).filter((q) => q && q.length >= 2))];
  // Titre avant « : » (« Shadow and Bone: La saga Grisha ») : essayé aussi, mais seulement à l'identique.
  const short = full.filter((q) => q.includes(": ")).map((q) => q.split(": ")[0]).filter((q) => q.length >= 2);
  const same = (t, w) => closeTitle(t, w);
  const ok = (x) => [x.title, x.originalTitle].filter(Boolean).some((t) => full.some((w) => same(t, w)) || short.some((w) => key(t) === key(w)));
  // Année connue : on essaie toutes les recherches avant de se rabattre sur la première liste trouvée.
  let first = null;
  for (const q of [...new Set([...full, ...short])]) {
    const list = (await search(q)).filter(ok);
    if (!list.length) continue;
    const y = wantedYear && (list.find((x) => x.year === wantedYear) || list.find((x) => x.year && Math.abs(x.year - wantedYear) === 1));
    if (y) return y.id;
    first = first || list;
    if (!wantedYear) break;
  }
  if (!first) return null;
  if (maxYear) {
    const old = first.filter((x) => !x.year || x.year <= maxYear);
    if (old.length) return old[0].id;
  }
  return first[0].id;
}

// Fiche complète : saisons et épisodes (hors épisodes spéciaux), casting, créateurs, affiche.
export async function loadShow(get, id) {
  const s = await get(`${API}/shows/${id}?embed[]=episodes&embed[]=cast&embed[]=crew`);
  return toSeries(s);
}

const lastYear = (seasons) => { const d = seasons[seasons.length - 1].dates.filter(Boolean).pop(); return year(d); };

export function toSeries(s) {
  const emb = s._embedded || {};
  const bySeason = new Map();
  for (const e of emb.episodes || []) {
    if (!e || !Number.isInteger(e.season) || e.season < 1 || e.type === "significant_special" || e.number == null) continue;
    if (!bySeason.has(e.season)) bySeason.set(e.season, []);
    bySeason.get(e.season).push(e);
  }
  const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([n, eps]) => {
    eps.sort((a, b) => a.number - b.number);
    return { n, count: eps.length, year: year(eps[0].airdate), titles: eps.map((e) => e.name || ""), dates: eps.map((e) => e.airdate || "") };
  });
  const crew = emb.crew || [];
  const people = (re) => [...new Set(crew.filter((c) => re.test(c.type || "")).map((c) => c.person && c.person.name).filter(Boolean))].slice(0, 4);
  const net = s.network || s.webChannel || {};
  return {
    tvmazeId: s.id, ref: "tvmaze:" + s.id, source: "TVmaze",
    title: s.name || "", originalTitle: s.name || "",
    // Fin = dernier épisode régulier : TVmaze date parfois la fin d'après un téléfilm ou un épisode spécial (ex. Breaking Bad 2019).
    year: year(s.premiered), endYear: s.ended ? (seasons.length ? lastYear(seasons) || year(s.ended) : year(s.ended)) : null, airing: s.status === "Running" || s.status === "In Development" || s.status === "To Be Determined",
    network: net.name || "", country: country((net.country || {}).code),
    genres: (s.genres || []).map((g) => GENRES[g] || g).slice(0, 4),
    runtime: s.averageRuntime || s.runtime || null,
    creators: people(/^(Creator|Developer)$/), directors: people(/^Director$/),
    cast: (emb.cast || []).slice(0, 6).map((c) => ({ name: (c.person || {}).name || "", role: (c.character || {}).name || "" })).filter((c) => c.name),
    summary: stripHtml(s.summary).slice(0, 1500),
    seasons,
    posterUrl: s.image ? s.image.medium || s.image.original : null,
    imdb: (s.externals || {}).imdb || null,
  };
}
