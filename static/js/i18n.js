/* ================================================================
   MotionCut — i18n
   Lightweight translation engine. Mark HTML with [data-i18n="key"]
   for textContent and [data-i18n-attr="title:key,placeholder:k2"] for
   attributes. Dynamic JS strings call MC.i18n.t(key, {params}).
   ================================================================ */
(() => {
'use strict';

const STRINGS = {
  // ============================================================
  //  ENGLISH (default)
  // ============================================================
  en: {
    // Topbar
    'topbar.cmdk':           'Search · run command',
    'topbar.undo':           'Undo (⌘Z)',
    'topbar.redo':           'Redo (⌘Y)',
    'topbar.save':           'Save project',
    'topbar.load':           'Load project',
    'topbar.theme':          'Toggle theme',
    'topbar.lang':           'Language',
    'topbar.ffmpeg':         'FFmpeg',
    'topbar.ffmpeg.ready':   'FFmpeg ready',
    'topbar.ffmpeg.missing': 'FFmpeg missing',

    // Stage
    'stage.empty.title':     'Drop your footage anywhere',
    'stage.empty.sub':       'MP4 · MOV · WebM — up to 2GB · 100% local',
    'stage.empty.browse':    'Or browse files',
    'stage.play':            'Play / Pause (Space)',
    'stage.fit':             'Fit to screen',
    'stage.mute':            'Mute',

    // Aspect ratios (label + use-case)
    'aspect.16_9.desc':  'YouTube · Vimeo · TV · widescreen cinematic',
    'aspect.1_1.desc':   'Instagram feed · LinkedIn · X · Facebook posts',
    'aspect.9_16.desc':  'Reels · TikTok · Stories · YouTube Shorts',

    // Panel headers
    'panel.media':       'Media',
    'panel.layers':      'Layers',
    'panel.inspector':   'Inspector',
    'panel.style':       'Style',
    'panel.templates':   'Templates',
    'panel.export':      'Export',

    // Dropzones
    'dz.video.title':    'Video',
    'dz.video.sub':      'MP4 · MOV · WebM',
    'dz.logo.title':     'Logo',
    'dz.audio.title':    'Music',

    // Drop overlay
    'drop.title':        'Drop to import',
    'drop.sub':          'Video · image · audio',

    // Add-layer buttons
    'add.text':          'Add text (T)',
    'add.logo':          'Add image (L)',
    'add.color':         'Add overlay (O)',

    // Layers panel
    'layers.empty.title':'No layers yet',
    'layers.empty.sub':  'Add text, logo, or overlay above',

    // Inspector
    'inspector.empty':   'Select a layer to edit',

    // Style
    'style.grade':       'Color grade',
    'style.fx':          'FX',
    'style.fx.vignette': 'Vignette',
    'style.fx.grain':    'Film grain',
    'style.music':       'Music',
    'style.music.none':  'No music loaded',
    'style.music.volume':'Volume',
    'style.music.fadein':'Fade in',
    'style.music.fadeout':'Fade out',
    'style.music.mode':  'Mix mode',
    'style.music.mix':   'Mix with original',
    'style.music.replace':'Replace original',

    // Color grades (chip labels)
    'grade.natural':     'Natural',
    'grade.cinematic':   'Cinematic',
    'grade.teal_orange': 'Teal · Orange',
    'grade.moody_dark':  'Moody',
    'grade.bright_airy': 'Airy',
    'grade.bw':          'B&W',

    // Templates
    'tpl.cinematic.name':   'Cinematic',
    'tpl.cinematic.desc':   'Letterbox · vignette · fade title',
    'tpl.real_estate.name': 'Real Estate',
    'tpl.real_estate.desc': 'Drone reveal · price tag',
    'tpl.travel.name':      'Travel',
    'tpl.travel.desc':      'Full-width title reveal',
    'tpl.social.name':      'Social',
    'tpl.social.desc':      'Reels · TikTok · bold',
    'tpl.corporate.name':   'Corporate',
    'tpl.corporate.desc':   'Clean · minimal · gold rule',

    // Export
    'export.169':       'Export 16:9',
    'export.916':       'Export 9:16',

    // Toasts
    'toast.uploading':       'Uploading {name} — {pct}%',
    'toast.upload_start':    'Uploading {name}…',
    'toast.loaded':          'Loaded {name}',
    'toast.no_video':        'Drop a video first',
    'toast.no_music':        'Drop music first',
    'toast.beats':           'Detected {n} beats',
    'toast.beats_fail':      'Beat detection failed',
    'toast.detecting':       'Detecting beats…',
    'toast.in_mark':         'In mark: {t}',
    'toast.out_mark':        'Out mark: {t}',
    'toast.marks_clear':     'Marks cleared',
    'toast.snap_on':         'Snap to beat: on',
    'toast.snap_off':        'Snap to beat: off',
    'toast.template':        'Template: {n}',
    'toast.project_saved':   'Project saved',
    'toast.project_loaded':  'Project loaded',
    'toast.export_done':     'Export complete',

    // Projects
    'project.new':           'New project',
    'project.save_as':       'Save current as…',
    'project.save_prompt':   'Save current work as a project. Name?',
    'project.untitled':      'Untitled project',
    'project.prompt':        'Project name?',
    'project.confirm_delete':'Delete this project and all its files?',
    'library.title':         'Project library',
    'library.empty':         'No files in this project yet',
    'library.video':         'video',
    'library.image':         'image',
    'library.audio':         'audio',
    'library.delete':        'Delete from project',
    'library.confirm_delete':'Delete this file from the project? This cannot be undone.',
    'toast.file_deleted':    'File deleted',
    'toast.project_created': 'Project created: {n}',
    'toast.project_switched':'Switched to: {n}',
    'toast.project_deleted': 'Project deleted',
  },

  // ============================================================
  //  FRENCH
  // ============================================================
  fr: {
    'topbar.cmdk':           'Rechercher · exécuter',
    'topbar.undo':           'Annuler (⌘Z)',
    'topbar.redo':           'Rétablir (⌘Y)',
    'topbar.save':           'Enregistrer le projet',
    'topbar.load':           'Charger un projet',
    'topbar.theme':          'Changer de thème',
    'topbar.lang':           'Langue',
    'topbar.ffmpeg':         'FFmpeg',
    'topbar.ffmpeg.ready':   'FFmpeg prêt',
    'topbar.ffmpeg.missing': 'FFmpeg introuvable',

    'stage.empty.title':     'Dépose ta vidéo n\'importe où',
    'stage.empty.sub':       'MP4 · MOV · WebM — jusqu\'à 2 Go · 100% local',
    'stage.empty.browse':    'Ou parcourir les fichiers',
    'stage.play':            'Lecture / Pause (Espace)',
    'stage.fit':             'Ajuster à l\'écran',
    'stage.mute':            'Couper le son',

    'aspect.16_9.desc':  'YouTube · Vimeo · TV · format cinéma',
    'aspect.1_1.desc':   'Feed Instagram · LinkedIn · X · Facebook',
    'aspect.9_16.desc':  'Reels · TikTok · Stories · YouTube Shorts',

    'panel.media':       'Médias',
    'panel.layers':      'Calques',
    'panel.inspector':   'Inspecteur',
    'panel.style':       'Style',
    'panel.templates':   'Modèles',
    'panel.export':      'Exporter',

    'dz.video.title':    'Vidéo',
    'dz.video.sub':      'MP4 · MOV · WebM',
    'dz.logo.title':     'Logo',
    'dz.audio.title':    'Musique',

    'drop.title':        'Déposer pour importer',
    'drop.sub':          'Vidéo · image · audio',

    'add.text':          'Ajouter du texte (T)',
    'add.logo':          'Ajouter une image (L)',
    'add.color':         'Ajouter un overlay (O)',

    'layers.empty.title':'Aucun calque',
    'layers.empty.sub':  'Ajoute du texte, logo ou overlay',

    'inspector.empty':   'Sélectionne un calque pour modifier',

    'style.grade':       'Étalonnage',
    'style.fx':          'Effets',
    'style.fx.vignette': 'Vignettage',
    'style.fx.grain':    'Grain pellicule',
    'style.music':       'Musique',
    'style.music.none':  'Aucune musique',
    'style.music.volume':'Volume',
    'style.music.fadein':'Fondu d\'entrée',
    'style.music.fadeout':'Fondu de sortie',
    'style.music.mode':  'Mode de mix',
    'style.music.mix':   'Mixer avec l\'original',
    'style.music.replace':'Remplacer l\'original',

    'grade.natural':     'Naturel',
    'grade.cinematic':   'Cinéma',
    'grade.teal_orange': 'Teal & Orange',
    'grade.moody_dark':  'Sombre',
    'grade.bright_airy': 'Lumineux',
    'grade.bw':          'N&B',

    'tpl.cinematic.name':   'Cinéma',
    'tpl.cinematic.desc':   'Bandes noires · vignettage · titre fondu',
    'tpl.real_estate.name': 'Immobilier',
    'tpl.real_estate.desc': 'Plan drone · étiquette prix',
    'tpl.travel.name':      'Voyage',
    'tpl.travel.desc':      'Révélation titre pleine largeur',
    'tpl.social.name':      'Réseaux',
    'tpl.social.desc':      'Reels · TikTok · audacieux',
    'tpl.corporate.name':   'Corporate',
    'tpl.corporate.desc':   'Épuré · minimal · liseré or',

    'export.169':       'Exporter 16:9',
    'export.916':       'Exporter 9:16',

    'toast.uploading':       'Envoi de {name} — {pct}%',
    'toast.upload_start':    'Envoi de {name}…',
    'toast.loaded':          '{name} chargé',
    'toast.no_video':        'Dépose une vidéo d\'abord',
    'toast.no_music':        'Dépose de la musique d\'abord',
    'toast.beats':           '{n} beats détectés',
    'toast.beats_fail':      'Échec de la détection',
    'toast.detecting':       'Détection des beats…',
    'toast.in_mark':         'Marqueur début : {t}',
    'toast.out_mark':        'Marqueur fin : {t}',
    'toast.marks_clear':     'Marqueurs effacés',
    'toast.snap_on':         'Calage sur beat : activé',
    'toast.snap_off':        'Calage sur beat : désactivé',
    'toast.template':        'Modèle : {n}',
    'toast.project_saved':   'Projet enregistré',
    'toast.project_loaded':  'Projet chargé',
    'toast.export_done':     'Export terminé',

    'project.new':           'Nouveau projet',
    'project.save_as':       'Enregistrer comme…',
    'project.save_prompt':   'Enregistrer le travail courant comme projet. Nom ?',
    'project.untitled':      'Projet sans titre',
    'project.prompt':        'Nom du projet ?',
    'project.confirm_delete':'Supprimer ce projet et tous ses fichiers ?',
    'library.title':         'Bibliothèque du projet',
    'library.empty':         'Aucun fichier dans ce projet',
    'library.video':         'vidéo',
    'library.image':         'image',
    'library.audio':         'audio',
    'library.delete':        'Supprimer du projet',
    'library.confirm_delete':'Supprimer ce fichier du projet ? Action irréversible.',
    'toast.file_deleted':    'Fichier supprimé',
    'toast.project_created': 'Projet créé : {n}',
    'toast.project_switched':'Projet : {n}',
    'toast.project_deleted': 'Projet supprimé',
  },
};

const LANGS = [
  { code: 'en', label: 'EN', name: 'English'  },
  { code: 'fr', label: 'FR', name: 'Français' },
];

let current = 'en';

function t(key, params = {}) {
  const dict = STRINGS[current] || STRINGS.en;
  let s = dict[key] || STRINGS.en[key] || key;
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(v);
  return s;
}

function applyToDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => {
    const spec = el.getAttribute('data-i18n-attr');
    spec.split(',').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  const lbl = document.querySelector('#btn-lang .lang-label');
  if (lbl) lbl.textContent = current.toUpperCase();
}

function setLang(code) {
  if (!STRINGS[code]) return;
  current = code;
  document.documentElement.setAttribute('lang', code);
  applyToDOM();
  try { localStorage.setItem('mc-lang', code); } catch {}
  window.dispatchEvent(new CustomEvent('mc-lang-change', { detail: code }));
}
function getLang()  { return current; }
function getLangs() { return LANGS.slice(); }

function init() {
  const saved = localStorage.getItem('mc-lang')
             || (navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en');
  setLang(STRINGS[saved] ? saved : 'en');
}

window.MC = window.MC || {};
window.MC.i18n = { t, setLang, getLang, getLangs, init, applyToDOM };

// Auto-init early so static labels translate before editor.js paints
document.addEventListener('DOMContentLoaded', init);

})();
