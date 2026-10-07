// Vérifie, contre la vraie API TVmaze, que la recherche et la fiche donnent ce que l'appli attend.
import assert from "node:assert/strict";
import { searchShows, bestMatch, loadShow } from "../src/tvmaze.js";

const get = async (url) => { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };

const list = await searchShows(get, "breaking bad");
assert.ok(list.length > 0, "la recherche renvoie des séries");
assert.equal(list[0].title, "Breaking Bad");

const id = await bestMatch(get, "Breaking Bad", 2008);
const bb = await loadShow(get, id);
assert.deepEqual(bb.seasons.map((s) => s.count), [7, 13, 13, 13, 16], "Breaking Bad : 7, 13, 13, 13, 16 épisodes");
assert.equal(bb.seasons[0].titles.length, 7);
assert.ok(bb.seasons[0].titles[0], "titres d'épisodes présents");
assert.match(bb.seasons[0].dates[0], /^2008-01-2\d$/, "date du pilote");
assert.equal(bb.year, 2008); assert.equal(bb.endYear, 2013); assert.equal(bb.airing, false);
assert.ok(bb.cast.some((c) => c.name === "Bryan Cranston"), "casting");
assert.ok(bb.posterUrl && bb.posterUrl.startsWith("https://"), "affiche");
assert.ok(bb.summary.length > 50 && !bb.summary.includes("<"), "résumé sans HTML");
console.log("Breaking Bad OK :", bb.network, bb.genres.join(", "), "· créateurs :", bb.creators.join(", ") || "(aucun)");

const lb = await loadShow(get, await bestMatch(get, "Le Bureau des légendes"));
assert.equal(lb.seasons.length, 5, "Le Bureau des légendes : 5 saisons");
console.log("Le Bureau des légendes OK :", lb.seasons.map((s) => s.count).join(", "), "·", lb.country);

console.log("Tests TVmaze OK");
