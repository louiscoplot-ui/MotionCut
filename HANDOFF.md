# HANDOFF — état de session MotionCut

> **Pour reprendre dans VS Code :** `git pull`, puis dire à Claude Code
> *"lis HANDOFF.md, HEALTH.md et AUDIT.md pour te mettre en contexte"*.
> Tout le code est déjà sur la branche — seul l'historique de chat ne suit pas.

## Contexte machine (chez l'utilisateur)
- **OS** : Windows. App lancée en local avec `python app.py` → http://localhost:5000
  (wizard `/`, éditeur `/edit`).
- **FFmpeg** : installé à `C:\ffmpeg\bin\ffmpeg.exe` (le PATH winget ne marchait
  pas ; on a copié les binaires là, et `find_ffmpeg()` les trouve en fallback).
  `/api/health` renvoie `ffmpeg: true`.
- **Branche** : `claude/festive-mccarthy-8sjk79` (HEAD = `815459a`).
- **Auto-pull ON** : le serveur pull `origin` toutes les 15 s et le reloader Flask
  redémarre → tout push est récupéré + relance auto (et tue le job en cours).
- Le conteneur web (où l'autre session tournait) **ne peut pas binder de port**
  (kill exit 144) — c'est pour ça que les tests serveur se faisaient chez l'user.

## EN COURS — à vérifier en priorité
**Bug "génération bloquée" = analyse 4K trop lente. Corrigé dans `815459a`.**
- Cause : `_ffmpeg_signalstats` + `_ffmpeg_scene_cuts` (app.py ~1186-1224)
  tournaient sur des frames **pleine résolution 4K** → plusieurs minutes/clip,
  faux "hang" (9 min sans output, juste le brief parsé puis silence).
- Fix : `scale=-2:240` AVANT signalstats/scene + timeout `120s→60s`.
- **À valider** : relancer GENERATE sur les 6 clips → l'analyse doit prendre
  quelques **secondes**. Si ça bloque encore mais à l'**étape 4 (rendu)**, c'est
  un autre sujet (FFmpeg xfade/export), pas l'analyse.

## OUVERT — pas encore traité
1. **Doublons d'upload** : le projet `default` a ~21 fichiers au lieu de 6
   (ré-uploads pendant un job bloqué — chaque upload refait une copie avec un
   nouveau préfixe uuid). À nettoyer via l'éditeur → Project Library → bouton `×`.
   Améliorations possibles : bloquer l'upload pendant un render, ou dédup par nom
   d'origine (strip du préfixe `^[a-f0-9]{6,16}_`).
2. **UI demandée, PAS encore livrée** (commencée puis revertée pour garder l'arbre
   propre) :
   - **Séparateur ajustable** preview/timeline (glisser haut/bas). Layout :
     `.stage-col` (flex column) = `.stage-toolbar` + `.stage-wrap` (flex:1) +
     `#timeline-host` (height:220px, a déjà `resize:vertical`). Insérer un
     `<div class="vsplit">` entre `.stage-wrap` et `#timeline-host`
     (templates/editor.html ~248) + JS qui ajuste `#timeline-host` height.
   - **Vignettes sur les clips de la timeline** (actuellement juste des blocs
     colorés → "on voit pas la vidéo"). Dans `timeline.js renderVideoTrack`,
     ajouter un `background-image:url(/api/thumbnail?project=..&filename=..)` sur
     `.tl-clip.clip-segment` (vidéo) ou `s.url` (image) + overlay sombre pour
     lisibilité du texte.
   - Thème : un toggle clair/sombre existe déjà (bouton ☀️ topbar, `toggleTheme`).
   - Repères : lignes de librairie = `.lib-item[data-name][data-kind][data-url]`,
     badges injectés dans `.lib-meta` (cf. face-detect.js `aiBadges`).
3. **Cosmétique** : warning `[mcp] ... circular import` au démarrage. Inoffensif
   (le MCP écoute quand même sur 19790). Cause : lancer `python app.py` fait que
   `mcp_server` ré-importe `app` une 2e fois. Fix propre : dans mcp_server.py,
   réutiliser `sys.modules.get("app") or sys.modules.get("__main__")` au lieu de
   `import app as motioncut_app`.

## Règles repo (CLAUDE.md)
- **Ne PAS modifier** `run_export_job()`, `build_filter_complex()`,
  `build_segments_chain()` (cœur du rendu) sauf demande explicite.
- Pas de TypeScript / build step. Vanilla JS, Flask, FFmpeg subprocess.
- Pas de nouvelles deps sans accord (déjà ajoutées : anthropic, python-dotenv).

## Docs de contexte déjà dans le repo
- `HEALTH.md` — diagnostic complet (l'app marche, FFmpeg = seul vrai manque).
- `AUDIT.md` — récap des 9 sprints (timeline, export, beats, MCP, ML, RE, etc.).
- `agents/AGENT_REPORT.md` — système d'agents d'audit (tourne offline sans clé API).
- `.env.example` — copier en `.env` + `ANTHROPIC_API_KEY` pour activer l'IA
  (`/api/ai/plan`, panneau "✨", agents en mode API).

## Prochaines étapes suggérées (ordre)
1. Confirmer que le fix 4K débloque la génération (relancer GENERATE).
2. Nettoyer les doublons de la librairie.
3. Livrer l'UI demandée : séparateur ajustable + vignettes timeline.
4. (Optionnel) Nettoyer le warning MCP circular-import.
