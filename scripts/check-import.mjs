// Rapport : quelles séries d'un fichier d'import TVmaze reconnaît-il ? (node scripts/check-import.mjs www/imports/xxx.json)
import { readFileSync, writeFileSync } from "node:fs";
import { searchShows, bestMatch } from "../src/tvmaze.js";

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
const { series } = JSON.parse(readFileSync(file, "utf8"));
const found = [], missing = [];
const cache = new Map();
const getCached = async (url) => { if (!cache.has(url)) { cache.set(url, await get(url)); await sleep(550); } return cache.get(url); };
for (const s of series) {
  const id = await bestMatch(getCached, [s.searchTitle, s.title], s.year);
  if (id) {
    const hit = (await searchShows(getCached, s.searchTitle || s.title)).find((x) => x.id === id) || { title: "?" };
    found.push(`${s.title} → ${hit.title} (${hit.year ?? "?"}, #${id})`);
  } else missing.push(`${s.title}${s.searchTitle ? ` [${s.searchTitle}]` : ""} · ${Object.values(s.seasons).reduce((a, b) => a + b, 0)} ép.`);
}
const md = `# ${file}\n\n${found.length} trouvées, ${missing.length} introuvables sur ${series.length}.\n\n## Introuvables\n\n${missing.map((x) => `- ${x}`).join("\n")}\n\n## Trouvées\n\n${found.map((x) => `- ${x}`).join("\n")}\n`;
writeFileSync("rapport-import.md", md);
console.log(`${found.length} trouvées, ${missing.length} introuvables sur ${series.length}`);
