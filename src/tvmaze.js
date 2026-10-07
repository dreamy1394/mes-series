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
    id: s.id, title: s.name, year: year(s.premiered), endYear: year(s.ended),
    network: (s.network || s.webChannel || {}).name || "", country: country(((s.network || s.webChannel || {}).country || {}).code),
    poster: s.image ? s.image.medium : null, status: s.status,
  }));
}

// Meilleure correspondance pour un titre seul (import CSV). Renvoie l'id ou null.
export async function bestMatch(get, q, wantedYear) {
  const list = await searchShows(get, q);
  if (!list.length) return null;
  if (wantedYear) { const y = list.find((x) => x.year === wantedYear); if (y) return y.id; }
  return list[0].id;
}

// Fiche complète : saisons et épisodes (hors épisodes spéciaux), casting, créateurs, affiche.
export async function loadShow(get, id) {
  const s = await get(`${API}/shows/${id}?embed[]=episodes&embed[]=cast&embed[]=crew`);
  return toSeries(s);
}

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
    tvmazeId: s.id,
    title: s.name || "", originalTitle: s.name || "",
    year: year(s.premiered), endYear: year(s.ended), airing: s.status === "Running" || s.status === "In Development" || s.status === "To Be Determined",
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
