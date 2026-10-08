// Films de l'historique Netflix (NetflixViewingHistory.csv) : tout ce qui n'est pas un épisode de série.
// node scripts/netflix-films.mjs NetflixViewingHistory.csv www/imports/netflix-2026-10-07.json > www/imports/netflix-films-AAAA-MM-JJ.json
// Le second fichier (import des séries) sert à écarter les épisodes des séries déjà reconnues.
import { readFileSync } from "node:fs";

const [csvPath, seriesPath] = process.argv.slice(2);
const norm = (v) => String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

// CSV « Title,Date » ; dates au format M/J/AA.
const rows = [];
for (const line of readFileSync(csvPath, "utf8").replace(/^﻿/, "").split(/\r?\n/).slice(1)) {
  const m = line.match(/^"((?:[^"]|"")*)","(\d+)\/(\d+)\/(\d+)"$/);
  if (!m) continue;
  rows.push({ title: m[1].replace(/""/g, '"').trim(), date: `20${m[4].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` });
}

const seriesKeys = new Set();
for (const s of JSON.parse(readFileSync(seriesPath, "utf8")).series) for (const t of [s.title, s.searchTitle]) if (t) seriesKeys.add(norm(t));

// Netflix sépare titre, saison et épisode par « : » (sans espace avant) ; « Titre : sous-titre » fait partie du nom.
const parts = (t) => t.split(/(?<=\S): /);
const EPISODE = /^(saison|season|partie|part|volume|vol\.|mini-série|livre|chapitre|épisode|episode|collection|limited series|série)\b|^\d+(re|e|ère)? partie\b/i;
const isSeries = (p) => p.some((_, i) => i < p.length - 1 && seriesKeys.has(norm(p.slice(0, i + 1).join(": ")))) || p.slice(1).some((x) => EPISODE.test(x));

const prefixCount = {};
for (const r of rows) { const p = parts(r.title); if (p.length > 1) prefixCount[norm(p[0])] = (prefixCount[norm(p[0])] || 0) + 1; }

const films = new Map();
for (const r of rows) {
  const p = parts(r.title);
  if (!norm(p[0]) || /^[:\s]/.test(r.title) || EPISODE.test(r.title)) continue; // épisode sans titre de série
  if (p.length === 1 && seriesKeys.has(norm(r.title))) continue;
  if (p.length > 1 && (isSeries(p) || prefixCount[norm(p[0])] > 1)) continue;
  const k = norm(r.title), f = films.get(k);
  if (f) { f.count++; if (r.date < f.first) f.first = r.date; if (r.date > f.last) f.last = r.date; continue; }
  // « Titre: sous-titre » vu une seule fois : film (« Venom: Let There Be Carnage ») ou épisode isolé d'une série.
  // L'appli ne le garde que si TMDB reconnaît un film de ce titre exact.
  films.set(k, { title: r.title, first: r.date, last: r.date, count: 1, ...(p.length > 1 ? { strict: true } : {}) });
}

const list = [...films.values()].sort((a, b) => b.last.localeCompare(a.last));
const out = { source: "Historique Netflix", kind: "films", exportedAt: rows.length ? rows.map((r) => r.date).sort().pop() : null, revision: 1, films: list.map(({ count, ...f }) => (count > 1 ? { ...f, count } : f)) };
process.stdout.write(JSON.stringify(out) + "\n");
console.error(`${list.length} films (${list.filter((f) => f.strict).length} à confirmer par TMDB) sur ${rows.length} lignes.`);
