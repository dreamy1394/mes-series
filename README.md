# Mes séries (Android)

Application Android pour suivre les séries vues : saisons, épisodes cochés au fur et à mesure, prochaines diffusions et bilan du temps passé.

## Installer sur le téléphone

1. Ouvre sur ton téléphone : <https://github.com/dreamy1394/mes-series/releases/latest/download/mes-series.apk>
2. Ouvre le fichier téléchargé. Android demande d'autoriser l'installation depuis le navigateur : accepte.
3. Pour mettre à jour, refais la même chose : la nouvelle version s'installe par-dessus et garde tes données.

## Fonctionnement

- Les fiches viennent de l'[API TVmaze](https://www.tvmaze.com/api) (gratuite, sans clé, données CC BY-SA) : saisons, titres et dates des épisodes, casting, créateurs, affiche. Résumés et titres d'épisodes sont en anglais.
- Les séries en cours de diffusion sont revérifiées automatiquement tous les 2 jours à l'ouverture (nouveaux épisodes, dates).
- Les données restent sur le téléphone. Menu ⋮ de « Mes séries » : import CSV, sauvegarde (fichier JSON à envoyer où tu veux), restauration.
- Au premier lancement, l'appli reprend les séries saisies dans le prototype web (`www/seed.json`).
- Les fichiers de `www/imports/` (ex. historique Netflix) sont importés une seule fois : chaque saison vue coche ses N premiers épisodes, puis la fiche TVmaze est recherchée (titre original si fourni dans `searchTitle`). Une série introuvable ou mal reconnue se corrige depuis sa fiche.

## Import CSV

Menu ⋮ > « Importer une liste de séries ». Un titre par ligne suffit ; colonnes reconnues : `titre`, `statut`, `vu_jusqu_a` (S02E05), `note` (sur 5), `annee`, `saisons` (8|10|10). Virgule, point-virgule ou tabulation.

## Développement

```bash
npm install
npm run build          # génère www/app.js et les polices
npm test               # vérifie l'API TVmaze (réseau requis)
npx cap add android    # une fois, nécessite le SDK Android
npx cap sync android && npx cap open android
```

Chaque push sur `main` vérifie TVmaze, compile l'APK via GitHub Actions (`.github/workflows/android.yml`) et le publie dans les Releases.

Le keystore de signature (`keystore/`) est versionné volontairement : appli perso installée hors Play Store, il garantit que chaque nouvelle version s'installe par-dessus la précédente. Ne pas réutiliser cette clé pour une appli publiée.
