// Construit www/ : bundle JS + polices embarquées (l'appli marche hors ligne).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("www/fonts", { recursive: true });
const fonts = {
  "material-symbols-rounded.woff2": "material-symbols/material-symbols-rounded.woff2",
  "bricolage-500.woff2": "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-500-normal.woff2",
  "bricolage-700.woff2": "@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff2",
  "figtree-400.woff2": "@fontsource/figtree/files/figtree-latin-400-normal.woff2",
  "figtree-500.woff2": "@fontsource/figtree/files/figtree-latin-500-normal.woff2",
  "figtree-600.woff2": "@fontsource/figtree/files/figtree-latin-600-normal.woff2",
  "jetbrains-mono-500.woff2": "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2",
};
for (const [to, from] of Object.entries(fonts)) copyFileSync(`node_modules/${from}`, `www/fonts/${to}`);
await build({ entryPoints: ["src/app.js"], bundle: true, format: "iife", target: "es2020", outfile: "www/app.js", minify: true });
console.log("www/ prêt");
