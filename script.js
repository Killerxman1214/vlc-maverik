// ── STATE ──
const vid    = document.getElementById('vid');
const plist  = document.getElementById('plist');
const pbar   = document.getElementById('pbar');
const pbuf   = document.getElementById('pbuf');
const pth    = document.getElementById('pth');
const td     = document.getElementById('td');
const stL    = document.getElementById('stL');
const stR    = document.getElementById('stR');
const splash = document.getElementById('splash');
const osdEl  = document.getElementById('osd');
const vosdEl = document.getElementById('vosd');

let hlsI = null, dashI = null, flvI = null;
let channels = [], filtered = [], chIdx = -1;
let fQueue = [], fIdx = 0;
let shuf = false, rep = false, muted = false;
let mrec = null, rchunks = [];
let osdT = null, vosdT = null;
let seekActive = false;
let subCues = [], subLoop = null;
let objUrl = null;
let vizAF = null, audioCtx = null, srcNode = null, analyser = null;
let currentMedia = { name:'—', url:'', type:'', source:'', group:'', ext:'', local:false, file:null, startedAt:null };
let selectedChannels = new Set();
let qualityMode = 'best'; // best | auto | manual
let loadedSubName = '';
let customSubEnabled = true;

// ── FORMAT SETS ──
const AUDIO = new Set(['mp3','aac','flac','wav','ogg','opus','wma','m4a','aiff','aif','mka','ac3','dts','amr','mid','midi','ra','ape']);
const VIDEO = new Set(['mp4','mkv','avi','mov','wmv','webm','ts','mts','m2ts','ogv','3gp','3g2','mpeg','mpg','m4v','f4v','vob','flv']);
const LIST  = new Set(['m3u','m3u8','pls']);
const SUBS  = new Set(['srt','vtt','ass','ssa','sub']);

function xext(s){ return (s.split('.').pop() || '').toLowerCase(); }

// ── BEST QUALITY MODE ──
// Essaie toujours de prendre la meilleure qualité disponible.
// Note: pour un fichier/flux direct MP3/MP4, la qualité dépend déjà du fichier/source.
const BEST_QUALITY_MODE = true;

function applyBestMediaQuality(){
  try{
    vid.preload = 'auto';
    vid.defaultPlaybackRate = 1;

    // Garde le son naturel si on change la vitesse.
    if ('preservesPitch' in vid) vid.preservesPitch = true;
    if ('mozPreservesPitch' in vid) vid.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in vid) vid.webkitPreservesPitch = true;
  } catch(e){}
}

function playMediaNow(){
  applyBestMediaQuality();
  return vid.play().catch(() => {});
}

function setCurrentMedia(info = {}){
  currentMedia = {
    name: info.name || info.label || '—',
    url: info.url || '',
    type: info.type || (info.url ? detect(info.url) : ''),
    source: info.source || '',
    group: info.group || '',
    ext: info.ext || xext(info.url || info.name || ''),
    local: !!info.local,
    file: info.file || null,
    fileSize: info.fileSize || (info.file ? info.file.size : 0) || 0,
    lastModified: info.lastModified || (info.file ? info.file.lastModified : 0) || 0,
    startedAt: new Date()
  };
}

function fmtBytes(bytes){
  if (!bytes || isNaN(bytes)) return '—';
  const units = ['o','Ko','Mo','Go','To'];
  let n = Number(bytes), i = 0;
  while (n >= 1024 && i < units.length - 1){ n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(ts){
  if (!ts) return '—';
  try{ return new Date(ts).toLocaleString(); }catch(e){ return '—'; }
}

function escHtml(v){
  return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function guessCodecFromExt(ext, type){
  ext = String(ext || '').toLowerCase();
  const map = {
    mp3:'Audio MPEG Layer III (MP3)', aac:'Audio AAC', m4a:'Audio AAC / ALAC', flac:'Audio FLAC sans perte',
    wav:'Audio PCM / WAV', ogg:'Audio Ogg Vorbis/Opus', opus:'Audio Opus', wma:'Audio Windows Media Audio',
    mp4:'Conteneur MP4 — souvent H.264/H.265 + AAC', m4v:'Conteneur MP4 — souvent H.264 + AAC',
    webm:'Conteneur WebM — VP8/VP9/AV1 + Opus/Vorbis', mkv:'Conteneur Matroska — codecs variables',
    avi:'Conteneur AVI — codecs variables', mov:'Conteneur QuickTime/MOV — codecs variables',
    ts:'MPEG-TS — souvent H.264/H.265 + AAC/AC3', m2ts:'MPEG-TS Blu-ray — codecs variables', mts:'MPEG-TS — codecs variables',
    flv:'Flash Video — H.264/VP6 + AAC/MP3', mpd:'MPEG-DASH adaptatif', m3u8:'HLS adaptatif'
  };
  if (type === 'hls') return 'HLS adaptatif (.m3u8)';
  if (type === 'dash') return 'MPEG-DASH adaptatif (.mpd)';
  if (type === 'yt') return 'YouTube embed — codec choisi par YouTube';
  if (type === 'dm') return 'Dailymotion embed — codec choisi par Dailymotion';
  return map[ext] || 'Inconnu / dépend de la source';
}

function getHlsCodecInfo(){
  if (!hlsI || !hlsI.levels || !hlsI.levels.length) return null;
  const idx = hlsI.currentLevel >= 0 ? hlsI.currentLevel : hlsI.loadLevel;
  const level = hlsI.levels[idx >= 0 ? idx : 0];
  if (!level) return null;
  return {
    protocole: 'HLS',
    resolution: level.width && level.height ? `${level.width}×${level.height}` : '—',
    bitrate: level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : '—',
    videoCodec: level.videoCodec || '—',
    audioCodec: level.audioCodec || '—',
    niveau: `${(idx >= 0 ? idx : 0) + 1} / ${hlsI.levels.length}`
  };
}

function getDashCodecInfo(){
  if (!dashI) return null;
  try{
    const videoQ = dashI.getQualityFor ? dashI.getQualityFor('video') : -1;
    const audioQ = dashI.getQualityFor ? dashI.getQualityFor('audio') : -1;
    const vList = dashI.getBitrateInfoListFor ? (dashI.getBitrateInfoListFor('video') || []) : [];
    const aList = dashI.getBitrateInfoListFor ? (dashI.getBitrateInfoListFor('audio') || []) : [];
    const v = vList[videoQ] || vList[vList.length - 1];
    const a = aList[audioQ] || aList[aList.length - 1];
    return {
      protocole: 'MPEG-DASH',
      resolution: v && v.width && v.height ? `${v.width}×${v.height}` : '—',
      bitrate: v && v.bitrate ? `${Math.round(v.bitrate / 1000)} kbps vidéo` : '—',
      videoCodec: v && v.codec ? v.codec : '—',
      audioCodec: a && a.codec ? a.codec : '—',
      niveau: `vidéo ${videoQ >= 0 ? videoQ + 1 : 'auto'} / ${vList.length || '—'} · audio ${audioQ >= 0 ? audioQ + 1 : 'auto'} / ${aList.length || '—'}`
    };
  } catch(e){ return null; }
}

function mediaRows(){
  const type = currentMedia.type || detect(currentMedia.url || '');
  const ext = currentMedia.ext || xext(currentMedia.url || currentMedia.name || '');
  const adaptive = type === 'hls' ? getHlsCodecInfo() : (type === 'dash' ? getDashCodecInfo() : null);
  const videoSize = vid.videoWidth && vid.videoHeight ? `${vid.videoWidth}×${vid.videoHeight}` : '—';
  const currentSrc = vid.currentSrc || vid.src || currentMedia.url || '—';
  const isAudio = type === 'audio' || AUDIO.has(ext);
  const duration = fmt(vid.duration);
  const rows = [
    ['Titre', currentMedia.name],
    ['Source', currentMedia.local ? 'Fichier local' : (currentMedia.source || 'Flux / URL')],
    ['Type détecté', type || 'direct'],
    ['Extension', ext || '—'],
    ['URL / chemin', currentSrc],
    ['Groupe', currentMedia.group || '—'],
    ['Taille fichier', fmtBytes(currentMedia.fileSize)],
    ['Modifié le', fmtDate(currentMedia.lastModified)],
    ['Durée', duration],
    ['Position', fmt(vid.currentTime)],
    ['Résolution vidéo', videoSize],
    ['Codec probable', guessCodecFromExt(ext, type)],
    ['Mode audio', isAudio ? 'Oui — visualiseur audio activé' : 'Non / vidéo'],
    ['Volume', `${Math.round((vid.volume || 0) * 100)}%${vid.muted ? ' (muet)' : ''}`],
    ['Vitesse', `×${vid.playbackRate || 1}`],
    ['État lecteur', vid.paused ? 'Pause / arrêté' : 'Lecture'],
    ['Qualité', qualityMode === 'best' ? 'Meilleure qualité disponible' : (qualityMode === 'auto' ? 'Automatique adaptatif' : 'Manuelle')]
  ];
  if (adaptive){
    rows.push(['Protocole adaptatif', adaptive.protocole]);
    rows.push(['Niveau courant', adaptive.niveau]);
    rows.push(['Résolution flux', adaptive.resolution]);
    rows.push(['Débit flux', adaptive.bitrate]);
    rows.push(['Codec vidéo flux', adaptive.videoCodec]);
    rows.push(['Codec audio flux', adaptive.audioCodec]);
  }
  return rows;
}

function ensureMediaInfoModal(){
  let modal = document.getElementById('mediaInfoModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'moverlay';
  modal.id = 'mediaInfoModal';
  modal.innerHTML = `
    <div class="modal media-info-modal">
      <div class="mtitle">Informations sur le média / codecs <span class="x" onclick="closeMediaInfo()">✖</span></div>
      <div class="mbody">
        <div id="mediaInfoBody"></div>
        <div class="hint">Les navigateurs ne donnent pas toujours les codecs exacts pour chaque fichier. L’app affiche les infos réelles disponibles et une estimation selon le conteneur.</div>
      </div>
      <div class="mfoot">
        <button class="mbtn" onclick="copyMediaInfo()">Copier</button>
        <button class="mbtn p" onclick="closeMediaInfo()">Fermer</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target.id === 'mediaInfoModal') closeMediaInfo(); });
  document.body.appendChild(modal);
  return modal;
}

function mediaInfoText(){
  return mediaRows().map(([k,v]) => `${k}: ${String(v).replace(/\s+/g,' ').trim()}`).join('\n');
}

function showMediaInfo(){
  const modal = ensureMediaInfoModal();
  const body = modal.querySelector('#mediaInfoBody');
  body.innerHTML = `<table class="media-info-table"><tbody>${mediaRows().map(([k,v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join('')}</tbody></table>`;
  modal.classList.add('on');
  osd('ℹ️ Informations média');
}

function closeMediaInfo(){
  const modal = document.getElementById('mediaInfoModal');
  if (modal) modal.classList.remove('on');
}

function copyMediaInfo(){
  const text = mediaInfoText();
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => osd('📋 Infos copiées')).catch(() => osd('❌ Copie impossible'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    osd('📋 Infos copiées');
  }
}


// ── VLC-LIKE TRACKS / SUBTITLES / QUALITY ──
function ensureOptionModal(id, title){
  let modal = document.getElementById(id);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.className = 'moverlay';
  modal.id = id;
  modal.innerHTML = `
    <div class="modal option-modal">
      <div class="mtitle">${title} <span class="x" onclick="closeOptionModal('${id}')">✖</span></div>
      <div class="mbody"><div class="optionBody"></div></div>
      <div class="mfoot">
        <button class="mbtn p" onclick="closeOptionModal('${id}')">Fermer</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target.id === id) closeOptionModal(id); });
  document.body.appendChild(modal);
  return modal;
}

function closeOptionModal(id){
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('on');
}

function optionButton(label, active, onclick, detail = ''){
  return `<button class="optrow${active ? ' active' : ''}" onclick="${onclick}">
    <span class="optcheck">${active ? '✓' : ''}</span>
    <span class="optlabel">${escHtml(label)}</span>
    ${detail ? `<span class="optdetail">${escHtml(detail)}</span>` : ''}
  </button>`;
}

function getNativeAudioTracks(){
  try{
    if (vid.audioTracks && vid.audioTracks.length) return Array.from(vid.audioTracks);
  } catch(e){}
  return [];
}

function getNativeTextTracks(){
  try{
    if (vid.textTracks && vid.textTracks.length) return Array.from(vid.textTracks);
  } catch(e){}
  return [];
}

function showAudioTrackManager(){
  const modal = ensureOptionModal('audioTrackModal', 'Piste audio');
  const body = modal.querySelector('.optionBody');
  let html = '';
  let found = false;

  if (hlsI && hlsI.audioTracks && hlsI.audioTracks.length){
    found = true;
    html += '<div class="optsection">HLS</div>';
    hlsI.audioTracks.forEach((track, i) => {
      const label = track.name || track.lang || `Piste audio ${i + 1}`;
      const detail = [track.lang, track.groupId].filter(Boolean).join(' · ');
      html += optionButton(label, hlsI.audioTrack === i, `setHlsAudioTrack(${i})`, detail);
    });
  }

  if (dashI && typeof dashI.getTracksFor === 'function'){
    try{
      const tracks = dashI.getTracksFor('audio') || [];
      const current = dashI.getCurrentTrackFor ? dashI.getCurrentTrackFor('audio') : null;
      if (tracks.length){
        found = true;
        html += '<div class="optsection">MPEG-DASH</div>';
        tracks.forEach((track, i) => {
          const label = track.lang || track.id || `Piste audio ${i + 1}`;
          const detail = [track.codec, track.roles && track.roles.join ? track.roles.join(', ') : ''].filter(Boolean).join(' · ');
          const active = current && ((current.id && current.id === track.id) || current.index === track.index);
          html += optionButton(label, !!active, `setDashAudioTrack(${i})`, detail);
        });
      }
    } catch(e){}
  }

  const nativeAudio = getNativeAudioTracks();
  if (nativeAudio.length){
    found = true;
    html += '<div class="optsection">Navigateur</div>';
    nativeAudio.forEach((track, i) => {
      const label = track.label || track.language || `Piste audio ${i + 1}`;
      html += optionButton(label, !!track.enabled, `setNativeAudioTrack(${i})`, track.language || '');
    });
  }

  if (!found){
    html = `<div class="optempty">Aucune piste audio multiple détectée.<br>Le navigateur expose parfois seulement la piste par défaut.</div>
      ${optionButton('Piste audio par défaut', true, "closeOptionModal('audioTrackModal')", 'active')}`;
  }

  body.innerHTML = html;
  modal.classList.add('on');
  osd('🎧 Pistes audio');
}

function setHlsAudioTrack(i){
  if (hlsI) hlsI.audioTrack = i;
  showAudioTrackManager();
  osd('🎧 Piste audio ' + (i + 1));
}

function setDashAudioTrack(i){
  try{
    const tracks = dashI.getTracksFor('audio') || [];
    if (tracks[i]) dashI.setCurrentTrack(tracks[i]);
  } catch(e){}
  showAudioTrackManager();
  osd('🎧 Piste audio ' + (i + 1));
}

function setNativeAudioTrack(i){
  const tracks = getNativeAudioTracks();
  tracks.forEach((track, idx) => track.enabled = idx === i);
  showAudioTrackManager();
  osd('🎧 Piste audio ' + (i + 1));
}

function showSubtitleManager(){
  const modal = ensureOptionModal('subtitleModal', 'Sous-titres');
  const body = modal.querySelector('.optionBody');
  let html = '';
  let found = false;

  html += optionButton('Désactivés', !customSubEnabled && getActiveExternalSubtitleIndex() < 0, 'disableAllSubtitles()', 'masquer tous les sous-titres');

  if (subCues.length){
    found = true;
    html += '<div class="optsection">Fichier chargé</div>';
    html += optionButton(loadedSubName || 'Sous-titres externes', customSubEnabled, 'enableCustomSubtitles()', `${subCues.length} ligne(s)`);
  }

  if (hlsI && hlsI.subtitleTracks && hlsI.subtitleTracks.length){
    found = true;
    html += '<div class="optsection">HLS</div>';
    hlsI.subtitleTracks.forEach((track, i) => {
      const label = track.name || track.lang || `Sous-titres ${i + 1}`;
      const detail = [track.lang, track.type].filter(Boolean).join(' · ');
      html += optionButton(label, hlsI.subtitleTrack === i, `setHlsSubtitleTrack(${i})`, detail);
    });
  }

  const nativeText = getNativeTextTracks();
  if (nativeText.length){
    found = true;
    html += '<div class="optsection">Navigateur</div>';
    nativeText.forEach((track, i) => {
      const label = track.label || track.language || `Sous-titres ${i + 1}`;
      html += optionButton(label, track.mode === 'showing', `setNativeSubtitleTrack(${i})`, track.language || track.kind || '');
    });
  }

  if (!found){
    html += '<div class="optempty">Aucun sous-titre chargé ou détecté.</div>';
  }

  html += `<div class="optfooterline">
    <button class="mbtn" onclick="document.getElementById('subInput').click();closeOptionModal('subtitleModal')">Charger un fichier</button>
    <button class="mbtn" onclick="clearSubtitles();showSubtitleManager()">Effacer</button>
  </div>`;

  body.innerHTML = html;
  modal.classList.add('on');
  osd('💬 Sous-titres');
}

function getActiveExternalSubtitleIndex(){
  if (hlsI && typeof hlsI.subtitleTrack === 'number' && hlsI.subtitleTrack >= 0) return hlsI.subtitleTrack;
  return -1;
}

function disableAllSubtitles(){
  customSubEnabled = false;
  document.getElementById('subs').innerHTML = '';
  if (hlsI && typeof hlsI.subtitleTrack !== 'undefined') hlsI.subtitleTrack = -1;
  getNativeTextTracks().forEach(track => track.mode = 'disabled');
  showSubtitleManager();
  osd('💬 Sous-titres désactivés');
}

function enableCustomSubtitles(){
  customSubEnabled = true;
  if (hlsI && typeof hlsI.subtitleTrack !== 'undefined') hlsI.subtitleTrack = -1;
  getNativeTextTracks().forEach(track => track.mode = 'disabled');
  showSubtitleManager();
  osd('💬 Sous-titres externes');
}

function toggleSubtitles(){
  customSubEnabled = !customSubEnabled;
  if (!customSubEnabled) document.getElementById('subs').innerHTML = '';
  osd(customSubEnabled ? '💬 Sous-titres activés' : '💬 Sous-titres désactivés');
}

function clearSubtitles(){
  subCues = [];
  loadedSubName = '';
  customSubEnabled = false;
  document.getElementById('subs').innerHTML = '';
  if (subLoop){ clearInterval(subLoop); subLoop = null; }
  osd('💬 Sous-titres effacés');
}

function setHlsSubtitleTrack(i){
  customSubEnabled = false;
  document.getElementById('subs').innerHTML = '';
  if (hlsI) hlsI.subtitleTrack = i;
  getNativeTextTracks().forEach(track => track.mode = 'disabled');
  showSubtitleManager();
  osd('💬 Sous-titres HLS ' + (i + 1));
}

function setNativeSubtitleTrack(i){
  customSubEnabled = false;
  document.getElementById('subs').innerHTML = '';
  getNativeTextTracks().forEach((track, idx) => track.mode = idx === i ? 'showing' : 'disabled');
  if (hlsI && typeof hlsI.subtitleTrack !== 'undefined') hlsI.subtitleTrack = -1;
  showSubtitleManager();
  osd('💬 Sous-titres ' + (i + 1));
}

function showQualityManager(){
  const modal = ensureOptionModal('qualityModal', 'Qualité audio / vidéo');
  const body = modal.querySelector('.optionBody');
  let html = '';
  let found = false;

  html += optionButton('Meilleure qualité disponible', qualityMode === 'best', 'setBestQuality()', 'force le niveau le plus élevé quand possible');
  html += optionButton('Automatique adaptatif', qualityMode === 'auto', 'setAutoQuality()', 'laisse le flux s’adapter à la connexion');

  if (hlsI && hlsI.levels && hlsI.levels.length){
    found = true;
    html += '<div class="optsection">HLS — niveaux vidéo</div>';
    hlsI.levels.forEach((level, i) => {
      const res = level.width && level.height ? `${level.width}×${level.height}` : (level.height ? `${level.height}p` : 'Résolution inconnue');
      const br = level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : '';
      const codecs = [level.videoCodec, level.audioCodec].filter(Boolean).join(' / ');
      const active = qualityMode === 'manual' && hlsI.currentLevel === i;
      html += optionButton(`${i + 1}. ${res}`, active, `setHlsQuality(${i})`, [br, codecs].filter(Boolean).join(' · '));
    });
  }

  if (dashI && typeof dashI.getBitrateInfoListFor === 'function'){
    try{
      const videos = dashI.getBitrateInfoListFor('video') || [];
      const audios = dashI.getBitrateInfoListFor('audio') || [];
      if (videos.length){
        found = true;
        const current = dashI.getQualityFor ? dashI.getQualityFor('video') : -1;
        html += '<div class="optsection">DASH — qualité vidéo</div>';
        videos.forEach((q, i) => {
          const res = q.width && q.height ? `${q.width}×${q.height}` : `Vidéo ${i + 1}`;
          const br = q.bitrate ? `${Math.round(q.bitrate / 1000)} kbps` : '';
          html += optionButton(`${i + 1}. ${res}`, qualityMode === 'manual' && current === i, `setDashVideoQuality(${i})`, [br, q.codec].filter(Boolean).join(' · '));
        });
      }
      if (audios.length){
        found = true;
        const currentA = dashI.getQualityFor ? dashI.getQualityFor('audio') : -1;
        html += '<div class="optsection">DASH — qualité audio</div>';
        audios.forEach((q, i) => {
          const br = q.bitrate ? `${Math.round(q.bitrate / 1000)} kbps` : `Audio ${i + 1}`;
          html += optionButton(`${i + 1}. ${br}`, qualityMode === 'manual' && currentA === i, `setDashAudioQuality(${i})`, q.codec || '');
        });
      }
    } catch(e){}
  }

  if (!found){
    html += '<div class="optempty">Ce média ne propose pas de choix de qualité exposé au navigateur. La qualité utilisée est celle du fichier ou du flux source.</div>';
  }

  body.innerHTML = html;
  modal.classList.add('on');
  osd('📶 Qualité');
}

function setBestQuality(){
  qualityMode = 'best';
  if (hlsI) chooseBestHlsLevel();
  if (dashI) chooseBestDashQuality();
  showQualityManager();
  osd('📶 Meilleure qualité');
}

function setAutoQuality(){
  qualityMode = 'auto';
  if (hlsI){
    hlsI.currentLevel = -1;
    hlsI.loadLevel = -1;
    hlsI.nextLevel = -1;
    hlsI.autoLevelCapping = -1;
  }
  if (dashI){
    try{ dashI.updateSettings({ streaming:{ abr:{ autoSwitchBitrate:{ video:true, audio:true } } } }); }catch(e){}
  }
  showQualityManager();
  osd('📶 Qualité automatique');
}

function setHlsQuality(i){
  qualityMode = 'manual';
  if (hlsI){
    hlsI.currentLevel = i;
    hlsI.loadLevel = i;
    hlsI.nextLevel = i;
  }
  showQualityManager();
  osd('📶 HLS niveau ' + (i + 1));
}

function setDashVideoQuality(i){
  qualityMode = 'manual';
  try{
    dashI.updateSettings({ streaming:{ abr:{ autoSwitchBitrate:{ video:false } } } });
    dashI.setQualityFor('video', i, true);
  } catch(e){}
  showQualityManager();
  osd('📶 DASH vidéo ' + (i + 1));
}

function setDashAudioQuality(i){
  qualityMode = 'manual';
  try{
    dashI.updateSettings({ streaming:{ abr:{ autoSwitchBitrate:{ audio:false } } } });
    dashI.setQualityFor('audio', i, true);
  } catch(e){}
  showQualityManager();
  osd('📶 DASH audio ' + (i + 1));
}

function chooseBestHlsLevel(){
  if (!hlsI || !hlsI.levels || !hlsI.levels.length) return;

  let bestIndex = 0;
  let bestScore = -1;

  hlsI.levels.forEach((level, i) => {
    const width = level.width || 0;
    const height = level.height || 0;
    const bitrate = level.bitrate || 0;
    const audioScore = level.audioCodec ? 1000000 : 0;
    const score = (width * height) + bitrate + audioScore;

    if (score > bestScore){
      bestScore = score;
      bestIndex = i;
    }
  });

  hlsI.autoLevelCapping = -1;
  hlsI.currentLevel = bestIndex;
  hlsI.loadLevel = bestIndex;
  hlsI.nextLevel = bestIndex;

  const l = hlsI.levels[bestIndex];
  const q = l.height ? `${l.height}p` : (l.bitrate ? `${Math.round(l.bitrate / 1000)} kbps` : 'max');
  stR.innerText = `Qualité HLS max — ${q}`;
}

function chooseBestDashQuality(){
  if (!dashI) return;

  try{
    const bestVideo = dashI.getBitrateInfoListFor('video') || [];
    const bestAudio = dashI.getBitrateInfoListFor('audio') || [];

    if (bestVideo.length){
      dashI.updateSettings({ streaming:{ abr:{ autoSwitchBitrate:{ video:false } } } });
      dashI.setQualityFor('video', bestVideo.length - 1, true);
    }

    if (bestAudio.length){
      dashI.updateSettings({ streaming:{ abr:{ autoSwitchBitrate:{ audio:false } } } });
      dashI.setQualityFor('audio', bestAudio.length - 1, true);
    }

    const v = bestVideo[bestVideo.length - 1];
    const a = bestAudio[bestAudio.length - 1];
    const vq = v && v.height ? `${v.height}p` : '';
    const aq = a && a.bitrate ? `${Math.round(a.bitrate / 1000)} kbps` : '';
    stR.innerText = `Qualité DASH max${vq || aq ? ' — ' + [vq, aq].filter(Boolean).join(' / ') : ''}`;
  } catch(e){}
}

function detect(url){
  const raw = String(url || '');
  const cleanUrl = raw.split('?')[0].split('#')[0].toLowerCase();
  const e = xext(cleanUrl);

  // Playlist réseau : https://iptv-org.github.io/iptv/index.m3u
  if (e === 'm3u' || e === 'pls') return 'playlist';

  // .m3u8 est souvent un flux HLS. On le garde en HLS.
  if (e === 'm3u8' || cleanUrl.includes('.m3u8') || cleanUrl.includes('/hls/')) return 'hls';
  if (e === 'mpd'  || cleanUrl.includes('.mpd')  || cleanUrl.includes('/dash/')) return 'dash';
  if (e === 'flv') return 'flv';
  if (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) return 'yt';
  if (cleanUrl.includes('dailymotion.com')) return 'dm';
  if (cleanUrl.startsWith('rtmp') || cleanUrl.startsWith('rtsp')) return 'stream';
  if (AUDIO.has(e)) return 'audio';
  if (VIDEO.has(e)) return 'direct';

  // Beaucoup de radios n'ont pas toujours .mp3/.aac dans l'URL.
  if (
    cleanUrl.includes('icecast') ||
    cleanUrl.includes('shoutcast') ||
    cleanUrl.includes('/stream') ||
    cleanUrl.includes('/live') ||
    cleanUrl.includes('radio')
  ){
    return 'audio';
  }

  return 'direct';
}

function isPlaylistUrl(url){
  return detect(url) === 'playlist';
}
// ── MENU ──
function tmenu(id){
  const el = document.getElementById(id);
  const w = el.classList.contains('open');
  cm();
  if (!w) el.classList.add('open');
}
function cm(){
  document.querySelectorAll('.mi.open').forEach(e => e.classList.remove('open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.mi')) cm();
});
function tToolbar(){
  const t = document.getElementById('toolbar');
  t.style.display = t.style.display === 'none' ? 'flex' : 'none';
}

// ── DRAG & DROP ──
const vwrap = document.getElementById('vwrap');
vwrap.addEventListener('dragover', e => {
  e.preventDefault();
  vwrap.classList.add('dov');
});
vwrap.addEventListener('dragleave', () => vwrap.classList.remove('dov'));
vwrap.addEventListener('drop', e => {
  e.preventDefault();
  vwrap.classList.remove('dov');
  handleFiles(Array.from(e.dataTransfer.files));
});

// ── FILE INPUT ──
document.getElementById('fileInput').onchange = e => {
  handleFiles(Array.from(e.target.files));
  e.target.value = '';
};
document.getElementById('subInput').onchange = async e => {
  if (e.target.files[0]) await loadSub(e.target.files[0]);
  e.target.value = '';
};


function updatePlaylistFooter(label = 'élément'){
  const selectedCount = getSelectedCount();
  const totalText = channels.length + ' ' + label + (channels.length > 1 ? 's' : '');
  document.getElementById('pfooter').innerText = selectedCount > 0
    ? `${totalText} · ${selectedCount} sélectionné(s)`
    : totalText;
  stL.innerText = selectedCount > 0
    ? `Liste — ${channels.length} élément(s), ${selectedCount} sélectionné(s)`
    : `Liste — ${channels.length} élément(s)`;
  updatePlaylistActionButtons();
}

function getSelectedCount(){
  let count = 0;
  selectedChannels.forEach(ch => {
    if (channels.includes(ch)) count++;
  });
  return count;
}

function updatePlaylistActionButtons(){
  const delBtn = document.getElementById('deleteSelectedBtn');
  const clearBtn = document.getElementById('clearPlaylistBtn');
  const hasSelected = getSelectedCount() > 0;
  if (delBtn) delBtn.disabled = !hasSelected;
  if (clearBtn) clearBtn.disabled = channels.length === 0;
}

function currentSearchText(){
  const srch = document.getElementById('srch');
  return srch ? srch.value.trim().toLowerCase() : '';
}

function refreshFiltered(){
  const q = currentSearchText();
  filtered = q ? channels.filter(c => c.name.toLowerCase().includes(q)) : [...channels];
}

function isObjectUrl(url){
  return typeof url === 'string' && url.startsWith('blob:');
}

function revokeChannelUrl(ch){
  if (ch && ch.local && isObjectUrl(ch.url)){
    try{ URL.revokeObjectURL(ch.url); }catch(e){}
  }
}

function clearPlaylistSelection(){
  selectedChannels.clear();
  renderCh();
  updatePlaylistFooter();
  osd('☑ Sélection effacée');
}

function togglePlaylistSelection(idx){
  const ch = channels[idx];
  if (!ch) return;
  if (selectedChannels.has(ch)) selectedChannels.delete(ch);
  else selectedChannels.add(ch);
  renderCh();
  updatePlaylistFooter();
}

function selectOnlyPlaylistItem(idx){
  const ch = channels[idx];
  if (!ch) return;
  selectedChannels.clear();
  selectedChannels.add(ch);
  renderCh();
  updatePlaylistFooter();
}

function removeSelectedChannels(){
  const toRemove = channels.filter(ch => selectedChannels.has(ch));
  if (!toRemove.length){
    osd('❌ Aucun élément sélectionné');
    return;
  }

  const current = chIdx >= 0 ? channels[chIdx] : null;
  const removingCurrent = current && toRemove.includes(current);

  if (removingCurrent){
    stopVideo();
  }

  toRemove.forEach(revokeChannelUrl);
  channels = channels.filter(ch => !selectedChannels.has(ch));
  selectedChannels.clear();

  if (removingCurrent){
    chIdx = -1;
  } else if (current){
    chIdx = channels.indexOf(current);
  } else {
    chIdx = -1;
  }

  refreshFiltered();
  renderCh();
  updatePlaylistFooter();
  osd(`🗑 ${toRemove.length} élément(s) supprimé(s)`);
}

function removeChannelAt(idx){
  const ch = channels[idx];
  if (!ch) return;

  if (idx === chIdx){
    stopVideo();
    chIdx = -1;
  } else if (idx < chIdx){
    chIdx--;
  }

  selectedChannels.delete(ch);
  revokeChannelUrl(ch);
  channels.splice(idx, 1);

  refreshFiltered();
  renderCh();
  updatePlaylistFooter();
  osd('🗑 Élément supprimé');
}

function clearPlaylist(){
  if (!channels.length){
    osd('❌ Liste déjà vide');
    return;
  }

  stopVideo();
  channels.forEach(revokeChannelUrl);
  channels = [];
  filtered = [];
  selectedChannels.clear();
  chIdx = -1;

  renderCh();
  updatePlaylistFooter();
  osd('🧹 Liste vidée');
}

function addMediaFilesToPlaylist(files){
  const startIndex = channels.length;

  files.forEach(f => {
    const e = xext(f.name);
    const url = URL.createObjectURL(f);

    channels.push({
      name: f.name,
      url,
      logo: '',
      group: 'Fichiers locaux',
      local: true,
      file: f,
      fileSize: f.size || 0,
      lastModified: f.lastModified || 0,
      ext: e,
      logoOk: false
    });
  });

  filtered = [...channels];
  renderCh();
  updatePlaylistFooter();
  osd(`➕ ${files.length} fichier(s) ajouté(s)`);

  return startIndex;
}

async function handleFiles(files){
  const pl = files.filter(f => LIST.has(xext(f.name)));
  const sb = files.filter(f => SUBS.has(xext(f.name)));
  const me = files.filter(f => !LIST.has(xext(f.name)) && !SUBS.has(xext(f.name)));

  for (const p of pl){
    const t = await p.text();
    xext(p.name) === 'pls' ? parsePLS(t) : parseM3U(t);
  }

  for (const s of sb){
    await loadSub(s);
  }

  if (me.length){
    const firstAddedIndex = addMediaFilesToPlaylist(me);

    if (chIdx === -1 && channels.length){
      playCh(firstAddedIndex);
    }
  }
}
// ── PLAY FILE ──
function playFile(i){
  if (i >= fQueue.length) return;
  fIdx = i;
  const f = fQueue[i], e = xext(f.name);

  stopAll();
  splash.style.display = 'none';
  hideEmbed();

  if (objUrl){
    URL.revokeObjectURL(objUrl);
    objUrl = null;
  }

  if (SUBS.has(e)){
    loadSub(f);
    return;
  }

  const url = URL.createObjectURL(f);
  objUrl = url;
  setCurrentMedia({ name:f.name, url, type:detect(url), source:'Fichier local', local:true, file:f, fileSize:f.size, lastModified:f.lastModified, ext:e });

  if (e === 'm3u8'){
    Hls.isSupported() ? hlsAtt(url) : (vid.src = url, playMediaNow());
  } else if (e === 'mpd' && typeof dashjs !== 'undefined'){
    dashAtt(url);
  } else if (e === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()){
    flvAtt(url, false);
  } else {
    vid.src = url;
    playMediaNow();
  }

  AUDIO.has(e) ? showAudio(f.name) : hideAudio();
  stL.innerText = '▶ ' + f.name;
  osd('▶ ' + f.name);
}

// ── PLAY CHANNEL ──
function playCh(idx){
  if (idx < 0 || idx >= channels.length) return;
  chIdx = idx;
  const ch = channels[idx];

  document.querySelectorAll('.crow').forEach(r => r.classList.remove('active'));
  const row = plist.querySelector(`[data-i="${idx}"]`);
  if (row){
    row.classList.add('active');
    row.scrollIntoView({ block:'nearest' });
  }

  splash.style.display = 'none';
  setCurrentMedia({ name:ch.name, url:ch.url, type:detect(ch.url), source:ch.local ? 'Fichier local' : 'Playlist / URL', group:ch.group, local:ch.local, file:ch.file, fileSize:ch.fileSize, lastModified:ch.lastModified, ext:ch.ext });
  stL.innerText = 'Chargement : ' + ch.name;
  osd('▶ ' + ch.name);

  if (ch.local){
    playLocalPlaylistItem(ch);
  } else {
    playUrlStr(ch.url, ch.name);
  }
}

function playLocalPlaylistItem(ch){
  stopAll();
  splash.style.display = 'none';
  hideEmbed();

  const e = ch.ext || xext(ch.name);
  setCurrentMedia({ name:ch.name, url:ch.url, type:detect(ch.url), source:'Fichier local', group:ch.group, local:true, file:ch.file, fileSize:ch.fileSize, lastModified:ch.lastModified, ext:e });

  if (e === 'mpd' && typeof dashjs !== 'undefined'){
    hideAudio();
    dashAtt(ch.url);
  } else if (e === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()){
    hideAudio();
    flvAtt(ch.url, false);
  } else if (e === 'm3u8'){
    hideAudio();
    Hls.isSupported() ? hlsAtt(ch.url) : (vid.src = ch.url, playMediaNow());
  } else {
    vid.src = ch.url;
    playMediaNow();

    AUDIO.has(e) ? showAudio(ch.name) : hideAudio();
  }

  stL.innerText = '▶ ' + ch.name;
  osd('▶ ' + ch.name);
}
// ── PLAY URL ──
async function playUrl(){
  const url = document.getElementById('turl').value.trim();
  if (!url) return;
  chIdx = -1;
  splash.style.display = 'none';
  hideAudio();

  if (isPlaylistUrl(url)){
    await loadNetworkPlaylist(url);
    return;
  }

  playUrlStr(url, url);
  osd('▶ ' + url);
}

function playUrlStr(url, label){
  stopAll();
  if (objUrl){
    URL.revokeObjectURL(objUrl);
    objUrl = null;
  }

  const t = detect(url);
  setCurrentMedia({ name:label, url, type:t, source:'URL directe', ext:xext(url) });

  if (t === 'yt'){
    hideAudio();
    showEmbed(ytE(url));
    stL.innerText = 'YouTube : ' + label;
    return;
  }
  if (t === 'dm'){
    hideAudio();
    showEmbed(dmE(url));
    stL.innerText = 'Dailymotion : ' + label;
    return;
  }

  hideEmbed();

  if (t === 'hls'){
    hideAudio();
    if (Hls.isSupported()) hlsAtt(url);
    else if (vid.canPlayType('application/vnd.apple.mpegurl')){
      vid.src = url;
      playMediaNow();
    }
  } else if (t === 'dash' && typeof dashjs !== 'undefined'){
    hideAudio();
    dashAtt(url);
  } else if (t === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()){
    hideAudio();
    flvAtt(url, url.includes('live'));
  } else {
    vid.src = url;
    playMediaNow();

    if (t === 'audio') showAudio(label);
    else hideAudio();
  }

  stL.innerText = '▶ ' + label;
}
// ── BACKENDS ──
function hlsAtt(url){
  hlsI = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    capLevelToPlayerSize: false,
    startLevel: -1,
    maxBufferLength: 120,
    maxMaxBufferLength: 600,
    backBufferLength: 90,
    maxBufferSize: 120 * 1000 * 1000
  });

  hlsI.loadSource(url);
  hlsI.attachMedia(vid);

  hlsI.on(Hls.Events.MANIFEST_PARSED, () => {
    if (BEST_QUALITY_MODE) chooseBestHlsLevel();
    playMediaNow();
  });

  hlsI.on(Hls.Events.LEVEL_SWITCHED, () => {
    if (!BEST_QUALITY_MODE || !hlsI || !hlsI.levels) return;
    const l = hlsI.levels[hlsI.currentLevel];
    if (l){
      const q = l.height ? `${l.height}p` : (l.bitrate ? `${Math.round(l.bitrate / 1000)} kbps` : 'max');
      stR.innerText = `Qualité HLS — ${q}`;
    }
  });

  hlsI.on(Hls.Events.ERROR, (e, d) => {
    if (d.fatal) stL.innerText = '❌ Erreur HLS';
  });
}

function dashAtt(url){
  dashI = dashjs.MediaPlayer().create();

  dashI.updateSettings({
    streaming: {
      buffer: {
        stableBufferTime: 120,
        bufferTimeAtTopQuality: 120,
        bufferTimeAtTopQualityLongForm: 180
      },
      abr: {
        autoSwitchBitrate: { audio: false, video: false },
        useDefaultABRRules: true
      }
    }
  });

  const ev = dashjs.MediaPlayer.events;
  dashI.on(ev.STREAM_INITIALIZED, () => {
    if (BEST_QUALITY_MODE) chooseBestDashQuality();
  });

  dashI.initialize(vid, url, true);
}

function flvAtt(url, live){
  flvI = flvjs.createPlayer({ type:'flv', url, isLive:live });
  flvI.attachMediaElement(vid);
  flvI.load();
  flvI.play();
}

function stopAll(){
  if (hlsI){ hlsI.destroy(); hlsI = null; }
  if (dashI){ try{ dashI.reset(); }catch(e){} dashI = null; }
  if (flvI){ try{ flvI.destroy(); }catch(e){} flvI = null; }

  vid.pause();
  vid.removeAttribute('src');
  vid.load();
}

// ── EMBED ──
function ytE(url){
  const m = url.match(/(?:v=|youtu\.be\/)([^&?/]+)/);
  return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1&rel=0&vq=hd1080` : url;
}
function dmE(url){
  const m = url.match(/video\/([^_?/]+)/);
  return m ? `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1&quality=1080` : url;
}
function showEmbed(src){
  document.getElementById('embedWrap').style.display = 'block';
  document.getElementById('embedFr').src = src;
}
function hideEmbed(){
  document.getElementById('embedWrap').style.display = 'none';
  document.getElementById('embedFr').src = '';
}

// ── AUDIO VIZ ──
function showAudio(name){
  document.getElementById('audioMode').classList.add('on');
  document.getElementById('audioTitle').innerText = name;
  startViz();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
function hideAudio(){
  document.getElementById('audioMode').classList.remove('on');
  stopViz();
}
function startViz(){
  try{
    if (!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      srcNode = audioCtx.createMediaElementSource(vid);
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    }

    const cv = document.getElementById('vizCanvas');
    const cx = cv.getContext('2d');
    const buf = new Uint8Array(analyser.frequencyBinCount);

    function draw(){
      vizAF = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(buf);
      cx.clearRect(0, 0, cv.width, cv.height);

      const bw = (cv.width / buf.length) * 2.4;
      let x = 0;

      for (let i = 0; i < buf.length; i++){
        const h = (buf[i] / 255) * cv.height;
        const g = Math.round(buf[i] / 2);
        cx.fillStyle = `rgb(255,${g},0)`;
        cx.fillRect(x, cv.height - h, bw, h);
        x += bw + 1;
      }
    }

    draw();
  } catch(e){}
}
function stopViz(){
  if (vizAF){
    cancelAnimationFrame(vizAF);
    vizAF = null;
  }
}

// ── SUBTITLES ──
async function loadSub(file){
  const txt = await file.text(), e = xext(file.name);
  subCues = [];
  loadedSubName = file.name;
  customSubEnabled = true;

  if (e === 'vtt') parseVTT(txt);
  else if (e === 'srt') parseSRT(txt);
  else if (e === 'ass' || e === 'ssa') parseASS(txt);

  osd('💬 ' + file.name);

  if (subLoop) clearInterval(subLoop);
  subLoop = setInterval(() => {
    if (!customSubEnabled){
      document.getElementById('subs').innerHTML = '';
      return;
    }
    const t = vid.currentTime;
    const c = subCues.find(q => t >= q.s && t <= q.e);
    document.getElementById('subs').innerHTML = c ? c.t.replace(/\n/g, '<br>') : '';
  }, 100);
}

function parseSRT(txt){
  txt.trim().split(/\n\s*\n/).forEach(bl => {
    const ls = bl.trim().split('\n');
    const ti = ls.find(l => l.includes('-->'));
    if (!ti) return;
    const [s, e] = ti.split('-->').map(t => srtT(t.trim()));
    subCues.push({
      s,
      e,
      t: ls.slice(ls.indexOf(ti) + 1).join('\n').replace(/<[^>]+>/g, '')
    });
  });
}

function parseVTT(txt){
  const ls = txt.split('\n');
  let i = 0;
  while (i < ls.length){
    if (ls[i].includes('-->')){
      const [s, e] = ls[i].split('-->').map(t => vttT(t.trim()));
      const tx = [];
      i++;
      while (i < ls.length && ls[i].trim() !== ''){
        tx.push(ls[i]);
        i++;
      }
      subCues.push({ s, e, t: tx.join('\n').replace(/<[^>]+>/g, '') });
    } else i++;
  }
}

function parseASS(txt){
  const ls = txt.split('\n');
  let fmt = [], inEv = false;
  ls.forEach(l => {
    if (l.startsWith('[Events]')){ inEv = true; return; }
    if (inEv && l.startsWith('Format:')) fmt = l.replace('Format:','').split(',').map(s => s.trim());
    if (inEv && l.startsWith('Dialogue:')){
      const p = l.replace('Dialogue:','').split(',');
      const si = fmt.indexOf('Start');
      const ei = fmt.indexOf('End');
      const ti = fmt.indexOf('Text');
      if (si < 0 || ei < 0 || ti < 0) return;
      const s = assT(p[si]?.trim());
      const e = assT(p[ei]?.trim());
      const t = p.slice(ti).join(',').replace(/\{[^}]+\}/g,'').replace(/\\N/g,'\n').trim();
      if (!isNaN(s) && !isNaN(e)) subCues.push({ s, e, t });
    }
  });
}

function srtT(t){
  const [h,m,s] = t.replace(',','.').split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}
function vttT(t){
  const p = t.split(':').map(parseFloat);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
function assT(t){
  if (!t) return NaN;
  const [h,m,s] = t.split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}

// ── NETWORK PLAYLISTS ──
function resolvePlaylistUrl(line, baseUrl){
  const value = String(line || '').trim();
  if (!value) return '';

  try{
    if (baseUrl) return new URL(value, baseUrl).href;
  } catch(e){}

  return value;
}

function getM3UNameFromExtinf(line){
  const comma = line.lastIndexOf(',');
  if (comma >= 0 && comma + 1 < line.length){
    return line.slice(comma + 1).trim() || 'Flux inconnu';
  }
  return 'Flux inconnu';
}

function looksLikePlayableUrl(line){
  return /^(https?|rtmp|rtsp|\/)/i.test(line) || !line.startsWith('#');
}

async function loadNetworkPlaylist(url){
  const before = channels.length;

  try{
    stL.innerText = 'Chargement playlist réseau…';
    osd('📡 Chargement playlist…');

    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const txt = await res.text();
    const lower = url.split('?')[0].toLowerCase();

    if (lower.endsWith('.pls') || /^\s*\[playlist\]/i.test(txt)){
      parsePLS(txt, { baseUrl:url });
    } else {
      parseM3U(txt, { baseUrl:url });
    }

    const added = channels.length - before;

    if (added <= 0){
      osd('❌ Aucune chaîne trouvée');
      stL.innerText = 'Playlist réseau vide ou non reconnue';
      return;
    }

    filtered = [...channels];
    renderCh();
    updatePlaylistFooter('chaîne');
    stL.innerText = `Playlist réseau — ${added} ajouté(s), ${channels.length} total`;
    osd(`📋 ${added} chaîne(s) ajoutée(s)`);
  } catch(e){
    osd('❌ Playlist impossible à charger');
    stL.innerText = 'Erreur playlist réseau : ' + e.message;
    alert(
      'Impossible de charger cette playlist.\n\n' +
      url + '\n\n' +
      'Détail : ' + e.message + '\n\n' +
      'Sur GitHub Pages, certains sites peuvent bloquer le chargement par CORS. ' +
      'Le lien IPTV-org devrait fonctionner parce qu’il est publié sur GitHub.'
    );
  }
}

// ── PARSERS ──
function parseM3U(data, options = {}){
  const lines = String(data || '').split('\n');
  let cur = {};
  let added = 0;

  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    if (line.startsWith('#EXTINF:')){
      const name  = getM3UNameFromExtinf(line);
      const logo  = (line.match(/tvg-logo="([^"]+)"/i) || [])[1] || '';
      const group = (line.match(/group-title="([^"]+)"/i) || [])[1] || '';
      const tvgId = (line.match(/tvg-id="([^"]+)"/i) || [])[1] || '';
      const tvgName = (line.match(/tvg-name="([^"]+)"/i) || [])[1] || '';
      const lang = (line.match(/tvg-language="([^"]+)"/i) || [])[1] || '';
      cur = { name, logo, group, tvgId, tvgName, lang };
      return;
    }

    if (line.startsWith('#')) return;

    if (cur.name && looksLikePlayableUrl(line)){
      const resolvedUrl = resolvePlaylistUrl(line, options.baseUrl);
      channels.push({
        ...cur,
        url: resolvedUrl,
        sourcePlaylist: options.baseUrl || '',
        ext: xext(resolvedUrl)
      });
      cur = {};
      added++;
    }
  });

  filtered = [...channels];
  renderCh();

  prepareLogos().then(() => {
    renderCh();
  });

  updatePlaylistFooter('chaîne');
  osd(`📋 ${added || channels.length} chaîne(s) chargée(s)`);
}

function parsePLS(txt, options = {}){
  let title = '';
  let added = 0;

  String(txt || '').split('\n').forEach(l => {
    l = l.trim();
    const mt = l.match(/^Title\d+=(.+)/i);
    if (mt) title = mt[1].trim();

    const mf = l.match(/^File\d+=(.+)/i);
    if (mf){
      const url = resolvePlaylistUrl(mf[1].trim(), options.baseUrl);
      channels.push({
        name:title || 'Piste',
        url,
        logo:'',
        group:'',
        sourcePlaylist: options.baseUrl || '',
        ext:xext(url),
        logoOk:false
      });
      added++;
    }
  });

  filtered = [...channels];
  renderCh();

  prepareLogos().then(() => {
    renderCh();
  });

  updatePlaylistFooter('piste');
  osd(`📋 ${added || channels.length} piste(s)`);
}
// ── LOGOS CACHE ──
const DEFAULT_LOGO = 'https://upload.wikimedia.org/wikipedia/commons/e/e8/VLC_Icon.svg';

const logoCache = JSON.parse(localStorage.getItem('logoCache') || '{}');

function saveLogoCache(){
  localStorage.setItem('logoCache', JSON.stringify(logoCache));
}

function testLogoOnce(url){
  return new Promise(resolve => {
    if (!url){
      resolve(false);
      return;
    }

    if (logoCache[url] === true){
      resolve(true);
      return;
    }

    if (logoCache[url] === false){
      resolve(false);
      return;
    }

    const img = new Image();

    img.onload = () => {
      logoCache[url] = true;
      saveLogoCache();
      resolve(true);
    };

    img.onerror = () => {
      logoCache[url] = false;
      saveLogoCache();
      resolve(false);
    };

    img.src = url;
  });
}

async function prepareLogos(list = channels){
  const items = list.filter(ch => ch.logo && ch.logoOk === undefined);

  list.forEach(ch => {
    if (!ch.logo) ch.logoOk = false;
  });

  if (!items.length) return;

  const concurrency = 16;
  let cursor = 0;
  let done = 0;

  async function worker(){
    while (cursor < items.length){
      const ch = items[cursor++];
      ch.logoOk = await testLogoOnce(ch.logo);
      done++;

      // Pour les très grosses listes comme IPTV-org, on rafraîchit par petits blocs.
      if (done % 80 === 0) renderCh();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  renderCh();
}


function renderCh(){
  plist.innerHTML = '';

  if (!filtered.length){
    plist.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">Aucun résultat</div>';
    return;
  }

  filtered.forEach(ch => {
    const idx = channels.indexOf(ch);
    const row = document.createElement('div');
    row.className = 'crow' + (idx === chIdx ? ' active' : '') + (selectedChannels.has(ch) ? ' selected' : '');
    row.dataset.i = idx;

    let logoHtml = '';

    if (ch.logo && ch.logoOk === true){
      logoHtml = `<img src="${ch.logo}" alt="">`;
    } else if (ch.logo && ch.logoOk === undefined){
      // En attendant que le test finisse
      logoHtml = `<img src="${DEFAULT_LOGO}" alt="">`;
    } else {
      // Aucun logo valide = rien
      logoHtml = `<span class="no-logo"></span>`;
    }

    row.innerHTML = `
      <input class="csel" type="checkbox" title="Sélectionner" ${selectedChannels.has(ch) ? 'checked' : ''}>
      <span class="cn">${idx + 1}</span>
      ${logoHtml}
      <span class="ct" title="${escHtml(ch.name)}">${escHtml(ch.name)}</span>
      <button class="row-del" title="Supprimer cet élément">×</button>
    `;

    row.querySelector('.csel').onclick = e => {
      e.stopPropagation();
      togglePlaylistSelection(idx);
    };

    row.querySelector('.row-del').onclick = e => {
      e.stopPropagation();
      removeChannelAt(idx);
    };

    row.onclick = e => {
      if (e.ctrlKey || e.metaKey){
        togglePlaylistSelection(idx);
      } else {
        playCh(idx);
      }
    };

    plist.appendChild(row);
  });
}

function filterCh(q){
  q = q.toLowerCase();
  filtered = q ? channels.filter(c => c.name.toLowerCase().includes(q)) : [...channels];
  renderCh();
  updatePlaylistFooter();
}

function savePlaylist(){
  if (!channels.length){
    osd('❌ Aucune playlist');
    return;
  }

  let m = '#EXTM3U\n';
  channels.forEach(c => m += `#EXTINF:-1 tvg-logo="${c.logo}" group-title="${c.group}",${c.name}\n${c.url}\n`);

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([m], { type:'text/plain' }));
  a.download = 'playlist.m3u';
  a.click();

  osd('💾 Playlist sauvegardée');
}

// ── CONTROLS ──
function tplay(){
  if (vid.paused) vid.play().then(() => { updIco(false); osd('▶ Lecture'); }).catch(() => {});
  else { vid.pause(); updIco(true); osd('⏸ Pause'); }
}

function updIco(p){
  const path = p ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
  document.getElementById('playIco').querySelector('path').setAttribute('d', path);
  document.getElementById('tbPlay').querySelector('svg path').setAttribute('d', path);
}

vid.onplay = () => updIco(false);
vid.onpause = () => updIco(true);

function stopVideo(){
  stopAll();
  hideAudio();
  hideEmbed();

  if (objUrl){
    URL.revokeObjectURL(objUrl);
    objUrl = null;
  }

  pbar.style.width = '0%';
  pth.style.left = '0%';
  td.innerText = '00:00 / 00:00';
  document.getElementById('subs').innerHTML = '';
  document.querySelectorAll('.crow').forEach(r => r.classList.remove('active'));
  chIdx = -1;
  stL.innerText = 'Arrêté';
  osd('⏹ Arrêté');
}

function prevCh(){
  if (channels.length) playCh(chIdx <= 0 ? channels.length - 1 : chIdx - 1);
  else if (fQueue.length) playFile(Math.max(0, fIdx - 1));
}

function nextCh(){
  if (channels.length){
    playCh(shuf ? Math.floor(Math.random() * channels.length) : (chIdx + 1) % channels.length);
  } else if (fQueue.length && fIdx + 1 < fQueue.length){
    playFile(fIdx + 1);
  }
}

vid.onended = () => { if (rep) vid.play(); else nextCh(); };
function setRate(r){ vid.playbackRate = r; osd('⚡ ×' + r); }

// ── VOLUME ──
function setVol(v){
  v = parseFloat(v);
  vid.volume = Math.min(v / 100, 1);
  document.getElementById('volPct').innerText = Math.round(v) + '%';
  document.getElementById('volSl').value = v;
  updVol(v);
  vosd(Math.round(v));
  if (v > 0){
    vid.muted = false;
    muted = false;
  }
}
function chVol(d){
  setVol(Math.min(150, Math.max(0, parseInt(document.getElementById('volSl').value) + d)));
}
function tMute(){
  muted = !muted;
  vid.muted = muted;
  osd(muted ? '🔇 Muet' : '🔊 Son');
  updVol(muted ? 0 : parseInt(document.getElementById('volSl').value));
}
function updVol(v){
  document.getElementById('vw1').style.display = v == 0 || muted ? 'none' : '';
  document.getElementById('vw2').style.display = v < 50 || muted ? 'none' : '';
}

// ── PANEL / FULL ──
function tPanel(){
  if (document.body.classList.contains('playlist-full')){
    document.body.classList.remove('playlist-full');
    osd('🎬 Lecteur vidéo');
    return;
  }
  document.getElementById('panel').classList.toggle('hide');
}
function togglePlaylistView(){
  const panel = document.getElementById('panel');
  document.body.classList.toggle('playlist-full');

  if (document.body.classList.contains('playlist-full')){
    panel.classList.remove('hide');
    renderCh();
    osd('📋 Playlist grand écran');
  } else {
    osd('🎬 Lecteur vidéo');
  }
}
function tFull(){
  const el = document.getElementById('vwrap');
  if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen).call(el);
  else (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen).call(document);
}
function setAsp(m){ vid.style.objectFit = m; osd('📐 ' + m); }

// ── SEEK ──
function seekStart(e){
  seekActive = true;
  doSeek(e);
}

document.getElementById('pw').addEventListener('mousedown', e => {
  seekActive = true;
  doSeek(e);
});
document.addEventListener('mouseup', () => seekActive = false);
document.addEventListener('mousemove', e => {
  if (seekActive) doSeek(e);
});

function doSeek(e){
  const r = document.getElementById('pw').getBoundingClientRect();
  const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (vid.duration && isFinite(vid.duration)) vid.currentTime = p * vid.duration;
}
function seekHov(e){
  const r = e.currentTarget.getBoundingClientRect();
  pth.style.left = (Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) + '%';
}

// ── TIME ──
vid.ontimeupdate = () => {
  const p = (vid.currentTime / vid.duration * 100) || 0;
  pbar.style.width = p + '%';
  pth.style.left = p + '%';
  td.innerText = fmt(vid.currentTime) + ' / ' + fmt(vid.duration);
};
vid.onprogress = () => {
  if (vid.buffered.length && vid.duration) pbuf.style.width = (vid.buffered.end(vid.buffered.length - 1) / vid.duration * 100) + '%';
};
vid.onloadedmetadata = () => {
  applyBestMediaQuality();
  const w = vid.videoWidth, h = vid.videoHeight;
  const audioOnly = !w && vid.duration !== undefined;

  if (w){
    stR.innerText = `Source directe — ${w}×${h}`;
  } else if (audioOnly){
    stR.innerText = 'Audio — qualité source';
  } else {
    stR.innerText = 'VLC Web v2.0';
  }
};

function fmt(s){
  if (!s || isNaN(s) || !isFinite(s)) return '00:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
  return h > 0 ? `${h}:${p2(m)}:${p2(sc)}` : `${p2(m)}:${p2(sc)}`;
}
function p2(n){ return n < 10 ? '0' + n : '' + n; }

// ── OSD ──
function osd(msg){
  osdEl.innerText = msg;
  osdEl.classList.add('on');
  clearTimeout(osdT);
  osdT = setTimeout(() => osdEl.classList.remove('on'), 2200);
}
function vosd(pct){
  vosdEl.innerText = `🔊 ${pct}%`;
  vosdEl.classList.add('on');
  clearTimeout(vosdT);
  vosdT = setTimeout(() => vosdEl.classList.remove('on'), 1500);
}

// ── SHUFFLE / REPEAT ──
function tShuf(){
  shuf = !shuf;
  document.getElementById('shufBtn').classList.toggle('active', shuf);
  osd(shuf ? '🔀 Aléatoire' : '🔀 Séquentiel');
}
function tRep(){
  rep = !rep;
  document.getElementById('repBtn').classList.toggle('active', rep);
  osd(rep ? '🔁 Répétition' : '🔁 Normal');
}

// ── RECORD ──
function tRec(){
  const btn = document.getElementById('recBtn');
  const badge = document.getElementById('recbadge');

  if (mrec && mrec.state === 'recording'){
    mrec.stop();
    btn.classList.remove('rec-on');
    badge.classList.remove('on');
    stL.innerText = 'Enregistrement sauvegardé';
    osd('⏹ Arrêté');
  } else {
    try{
      const stream = (vid.captureStream || vid.mozCaptureStream).call(vid);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      mrec = new MediaRecorder(stream, { mimeType:mime });
      rchunks = [];
      mrec.ondataavailable = e => { if (e.data.size > 0) rchunks.push(e.data); };
      mrec.onstop = () => {
        const b = new Blob(rchunks, { type:'video/webm' });
        const u = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = u;
        a.download = 'vlc_rec_' + Date.now() + '.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 10000);
      };
      mrec.start(1000);
      btn.classList.add('rec-on');
      badge.classList.add('on');
      stL.innerText = '⏺ Enregistrement…';
      osd('⏺ Démarré');
    } catch(e){
      osd('❌ ' + e.message);
    }
  }
}

// ── URL MODAL ──
function openUrlModal(){
  document.getElementById('urlModal').classList.add('on');
  setTimeout(() => document.getElementById('urlInp').focus(), 80);
}
function closeUrlModal(){
  document.getElementById('urlModal').classList.remove('on');
}
async function fromModal(){
  const url = document.getElementById('urlInp').value.trim();
  if (!url) return;
  closeUrlModal();
  document.getElementById('turl').value = url;
  chIdx = -1;
  splash.style.display = 'none';
  hideAudio();

  if (isPlaylistUrl(url)){
    await loadNetworkPlaylist(url);
    return;
  }

  playUrlStr(url, url);
  osd('▶ ' + url);
}
document.getElementById('urlInp').addEventListener('keydown', e => {
  if (e.key === 'Enter') fromModal();
  if (e.key === 'Escape') closeUrlModal();
});
document.getElementById('urlModal').addEventListener('click', e => {
  if (e.target.id === 'urlModal') closeUrlModal();
});

// ── ABOUT ──
function about(){
  alert('VLC Web Player – Maverik Ultimate  v2.1\nMode meilleure qualité activé\n\n🎬 Vidéo : MP4 · MKV · AVI · MOV · WMV · FLV · WebM · TS · MTS · M2TS · OGV · 3GP · MPEG\n🎵 Audio : MP3 · AAC · FLAC · WAV · OGG · OPUS · WMA · M4A · AIFF · AMR · MIDI\n📡 Flux  : HLS (m3u8) · DASH (mpd) · RTMP · RTSP · HTTP\n📋 Listes: M3U · M3U8 · PLS\n💬 Subs  : SRT · VTT · ASS/SSA\n📺 Embed : YouTube · Dailymotion\n\n© VideoLAN');
}

// ── KEYBOARD ──
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;

  switch(e.key){
    case ' ':
      e.preventDefault();
      tplay();
      break;
    case 'f':
    case 'F':
      tFull();
      break;
    case 'm':
    case 'M':
      tMute();
      break;
    case 's':
    case 'S':
      stopVideo();
      break;
    case 'p':
    case 'P':
      prevCh();
      break;
    case 'n':
    case 'N':
      nextCh();
      break;
    case 'l':
    case 'L':
      tPanel();
      break;
    case 'v':
    case 'V':
      togglePlaylistView();
      break;
    case 'a':
    case 'A':
      showAudioTrackManager();
      break;
    case 'u':
    case 'U':
      showSubtitleManager();
      break;
    case 'q':
    case 'Q':
      showQualityManager();
      break;
    case 'ArrowUp':
      e.preventDefault();
      chVol(5);
      break;
    case 'ArrowDown':
      e.preventDefault();
      chVol(-5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      vid.currentTime += 10;
      osd('⏩ +10s');
      break;
    case 'ArrowLeft':
      e.preventDefault();
      vid.currentTime -= 10;
      osd('⏪ -10s');
      break;
    case '=':
    case '+':
      setRate(1);
      break;
    case 'Delete':
      e.preventDefault();
      removeSelectedChannels();
      break;
    case 'Escape':
      if (getSelectedCount() > 0){
        e.preventDefault();
        clearPlaylistSelection();
      }
      break;
  }
});

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'o'){
    e.preventDefault();
    document.getElementById('fileInput').click();
  }
  if (e.ctrlKey && e.key === 'n'){
    e.preventDefault();
    openUrlModal();
  }
  if (e.ctrlKey && e.key === 's'){
    e.preventDefault();
    document.getElementById('subInput').click();
  }
  if (e.ctrlKey && (e.key === 'i' || e.key === 'I')){
    e.preventDefault();
    showMediaInfo();
  }
  if (e.ctrlKey && (e.key === 'a' || e.key === 'A')){
    e.preventDefault();
    showAudioTrackManager();
  }
  if (e.ctrlKey && (e.key === 'u' || e.key === 'U')){
    e.preventDefault();
    showSubtitleManager();
  }
  if (e.ctrlKey && (e.key === 'q' || e.key === 'Q')){
    e.preventDefault();
    showQualityManager();
  }
});