// Rapport : quelles séries d'un fichier d'import TMDB (puis TVmaze) reconnaît-il ? (node scripts/check-import.mjs www/imports/xxx.json)
import { readFileSync, writeFileSync } from "node:fs";
import { match, matchFilm } from "../src/sources.js";
import * as tmdb from "../src/tmdb.js";
import * as tvmaze from "../src/tvmaze.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(5000); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error("rate");
};
const file = process.argv[2];
const data = JSON.parse(readFileSync(file, "utf8"));
const found = [], missing = [];
const cache = new Map();
const getCached = async (url) => { if (!cache.has(url)) { cache.set(url, await get(url)); await sleep(url.includes("tvmaze") ? 550 : 40); } return cache.get(url); };

// Fichier de films (TMDB seulement) : `strict` = titre « Série: épisode » gardé seulement si un film porte ce titre exact.
if (data.films) {
  let skipped = 0;
  for (const f of data.films) {
    const ref = await matchFilm(getCached, [f.searchTitle, f.title], f.year, f.first ? +f.first.slice(0, 4) : null, f.strict);
    if (!ref) { if (f.strict) skipped++; else missing.push(f.title); continue; }
    const id = +ref.split(":")[1];
    let hit = { title: "?" };
    for (const q of [f.searchTitle, f.title].filter(Boolean)) { const h = (await tmdb.searchMovies(getCached, q)).find((x) => x.id === id); if (h) { hit = h; break; } }
    found.push(`${f.title}${f.strict ? " (?)" : ""} → ${hit.title}${hit.originalTitle && hit.originalTitle !== hit.title ? ` / ${hit.originalTitle}` : ""} (${hit.year ?? "?"}, ${ref})`);
  }
  const md = `# ${file}\n\n${found.length} films trouvés, ${missing.length} introuvables, ${skipped} titres « série: épisode » écartés sur ${data.films.length}.\n\n## Introuvables\n\n${missing.map((x) => `- ${x}`).join("\n")}\n\n## Trouvés\n\n${found.map((x) => `- ${x}`).join("\n")}\n`;
  writeFileSync("rapport-import.md", md);
  console.log(md);
  process.exit(0);
}
const { series } = data;
const bySrc = { tmdb: 0, tvmaze: 0 };
for (const s of series) {
  const ref = await match(getCached, [s.searchTitle, s.title], s.year, s.first ? +s.first.slice(0, 4) : null);
  if (ref) {
    const [src, id] = ref.split(":"); bySrc[src]++;
    const api = src === "tmdb" ? tmdb : tvmaze;
    let hit = { title: "?" };
    for (const q of [s.searchTitle, s.title].filter(Boolean)) { const h = (await api.searchShows(getCached, q)).find((x) => x.id === +id); if (h) { hit = h; break; } }
    found.push(`${s.title} → ${hit.title}${hit.originalTitle && hit.originalTitle !== hit.title ? ` / ${hit.originalTitle}` : ""} (${hit.year ?? "?"}, ${ref})`);
  } else missing.push(`${s.title}${s.searchTitle ? ` [${s.searchTitle}]` : ""} · ${Object.values(s.seasons).reduce((a, b) => a + b, 0)} ép.`);
}
const md = `# ${file}\n\n${found.length} trouvées (TMDB ${bySrc.tmdb}, TVmaze ${bySrc.tvmaze}), ${missing.length} introuvables sur ${series.length}.\n\n## Introuvables\n\n${missing.map((x) => `- ${x}`).join("\n")}\n\n## Trouvées\n\n${found.map((x) => `- ${x}`).join("\n")}\n`;
writeFileSync("rapport-import.md", md);
console.log(md);
