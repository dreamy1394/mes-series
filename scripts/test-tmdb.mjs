// Vérifie, contre la vraie API TMDB, que la recherche et la fiche en français donnent ce que l'appli attend.
import assert from "node:assert/strict";
import { searchShows, bestMatch, loadShow, findByImdb } from "../src/tmdb.js";
import { match } from "../src/sources.js";

if (!process.env.TMDB_KEY) { console.warn("TMDB_KEY absente : test TMDB ignoré (ajoute le secret dans GitHub)."); process.exit(0); }

const get = async (url) => { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error(`${r.status} ${url.replace(/api_key=\w+/, "api_key=…")}`); return r.json(); };

const list = await searchShows(get, "breaking bad");
assert.ok(list.length > 0, "la recherche renvoie des séries");
const id = await bestMatch(get, "Breaking Bad", 2008);
assert.equal(id, 1396, "Breaking Bad = TMDB 1396");
const bb = await loadShow(get, id);
assert.deepEqual(bb.seasons.map((s) => s.count), [7, 13, 13, 13, 16], "Breaking Bad : 7, 13, 13, 13, 16 épisodes");
assert.ok(bb.seasons[0].titles[0], "titres d'épisodes présents");
assert.match(bb.seasons[0].dates[0], /^2008-01-2\d$/, "date du pilote");
assert.equal(bb.year, 2008); assert.equal(bb.endYear, 2013); assert.equal(bb.airing, false);
assert.ok(bb.cast.some((c) => c.name === "Bryan Cranston"), "casting");
assert.ok(bb.creators.includes("Vince Gilligan"), "créateur");
assert.ok(bb.posterUrl && bb.posterUrl.startsWith("https://image.tmdb.org/"), "affiche");
assert.match(bb.summary, /\b(le|la|les|un|une|de|des)\b/i, "résumé en français");
assert.equal(bb.imdb, "tt0903747");
assert.equal(await findByImdb(get, "tt0903747"), 1396, "conversion depuis IMDb");

// Titres français Netflix, introuvables sur TVmaze.
assert.equal(await match(get, ["Les Meurtres zen"], null, 2025), "tmdb:252372");
const dear = await match(get, ["Chère petite"], null, 2023);
assert.ok(dear && dear.startsWith("tmdb:"), "Chère petite trouvée sur TMDB");
console.log("TMDB OK :", bb.title, "·", bb.summary.slice(0, 80) + "…");
