/* ============================
   SOUNDWAVE — APP.JS v4.1
   yt-dlp audio backend + native <audio>
   Multi-fallback playback — never auto-skips
   ============================ */

// ========================
// STATE
// ========================
const State = {
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  isRepeat: false,
  isMuted: false,
  volume: 0.8,
  likedSongs: JSON.parse(localStorage.getItem('likedSongs') || '[]'),
  duration: 0,
  seekTimer: null,
  loadingVideoId: null,   // prevent race conditions
};

// ========================
// DOM REFS
// ========================
const $ = id => document.getElementById(id);

const D = {
  playerThumb:         $('playerThumb'),
  playerThumbWrap:     $('playerThumbWrap'),
  playerTitle:         $('playerTitle'),
  playerChannel:       $('playerChannel'),
  playerLikeBtn:       $('playerLikeBtn'),
  playBtn:             $('playBtn'),
  prevBtn:             $('prevBtn'),
  nextBtn:             $('nextBtn'),
  shuffleBtn:          $('shuffleBtn'),
  repeatBtn:           $('repeatBtn'),
  seekBar:             $('seekBar'),
  seekProgress:        $('seekProgress'),
  seekThumb:           $('seekThumb'),
  currentTime:         $('currentTime'),
  totalTime:           $('totalTime'),
  volBar:              $('volBar'),
  volProgress:         $('volProgress'),
  volThumb:            $('volThumb'),
  volBtn:              $('volBtn'),
  npTitle:             $('npTitle'),
  npChannel:           $('npChannel'),
  npThumb:             $('npThumb'),
  npDisc:              $('npDisc'),
  npGlow:              $('npGlow'),
  npLikeBtn:           $('npLikeBtn'),
  npYtBtn:             $('npYtBtn'),
  npErrorBanner:       $('npErrorBanner'),
  npErrorMsg:          $('npErrorMsg'),
  npSkipBtn:           $('npSkipBtn'),
  overlay:             $('nowPlayingOverlay'),
  closeBtn:            $('closePlayerBtn'),
  openNpBtn:           $('openNpBtn'),
  searchInput:         $('searchInput'),
  searchSpinner:       $('searchSpinner'),
  searchClear:         $('searchClear'),
  searchResults:       $('searchResults'),
  trendingGrid:        $('trendingGrid'),
  trendingLoader:      $('trendingLoader'),
  likedGrid:           $('likedGrid'),
  likedCount:          $('likedCount'),
  likedList:           $('likedList'),
  queueList:           $('queueList'),
  timeGreeting:        $('timeGreeting'),
  sidebar:             $('sidebar'),
  sidebarOverlay:      $('sidebarOverlay'),
  mobileMenuBtn:       $('mobileMenuBtn'),
  mobileSearchIconBtn: $('mobileSearchIconBtn'),
  audioPlayer:         $('audioPlayer'),
  audioLoading:        $('audioLoading'),
};

// ========================
// NATIVE AUDIO SETUP
// ========================
const audio = D.audioPlayer;
audio.volume = State.volume;
audio.crossOrigin = 'anonymous';   // needed for CORS on direct CDN URLs

audio.addEventListener('play', () => {
  State.isPlaying = true;
  setPlayPauseIcon(true);
  D.npDisc.classList.add('playing');
  setAudioLoading(false);
  hideError();
  startSeekTimer();
});

audio.addEventListener('pause', () => {
  State.isPlaying = false;
  setPlayPauseIcon(false);
  D.npDisc.classList.remove('playing');
  stopSeekTimer();
});

audio.addEventListener('ended', () => {
  D.npDisc.classList.remove('playing');
  stopSeekTimer();
  if (State.isRepeat) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else {
    playNext();
  }
});

audio.addEventListener('loadedmetadata', () => {
  State.duration = audio.duration;
  D.totalTime.textContent = formatTime(State.duration);
});

audio.addEventListener('timeupdate', () => {
  if (!seekDragging) {
    updateTimeUI(audio.currentTime, audio.duration || State.duration);
  }
});

audio.addEventListener('waiting', () => {
  setAudioLoading(true);
});

audio.addEventListener('canplay', () => {
  setAudioLoading(false);
});

// Audio error → try next fallback, never auto-skip
audio.addEventListener('error', async (e) => {
  const code = audio.error ? audio.error.code : '?';
  console.warn('Audio element error code:', code, e);
  const video = State.queue[State.currentIndex];
  if (!video || State.loadingVideoId !== video.id) return; // stale event
  await tryNextFallback(video);
});

function setAudioLoading(loading) {
  if (D.audioLoading) D.audioLoading.style.display = loading ? 'flex' : 'none';
}

// ========================
// MULTI-FALLBACK PLAYBACK
// ========================
// Each track gets tried with these strategies in order.
// We NEVER auto-skip to the next track — if all fail, we show an error
// and wait for the user to manually skip.

const _fallbackState = {};  // video_id -> { strategyIndex, tried }

function resetFallbacks(videoId) {
  _fallbackState[videoId] = { strategyIndex: 0 };
}

// Build list of sources to try for a given video
function getFallbackSources(video) {
  const id = video.id;
  return [
    // 1. yt-dlp direct URL (from /api/stream)
    async () => {
      const res = await fetch(`/api/stream/${id}`);
      if (!res.ok) throw new Error(`Stream API ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return { src: data.url, label: 'yt-dlp direct' };
    },
    // 2. yt-dlp proxied through Flask (/api/proxy) — solves CORS
    async () => {
      // Just verify the proxy endpoint works (it'll stream)
      return { src: `/api/proxy/${id}`, label: 'yt-dlp proxy' };
    },
    // 3. Invidious instance (open-source YouTube frontend with audio API)
    async () => {
      const inv = 'https://invidious.io.lol';
      const res = await fetch(`${inv}/api/v1/videos/${id}?fields=adaptiveFormats`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Invidious ${res.status}`);
      const data = await res.json();
      const formats = (data.adaptiveFormats || []).filter(f => f.type && f.type.startsWith('audio/'));
      formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!formats.length) throw new Error('No audio formats from Invidious');
      return { src: formats[0].url, label: 'Invidious' };
    },
    // 4. Second Invidious instance
    async () => {
      const inv = 'https://vid.puffyan.us';
      const res = await fetch(`${inv}/api/v1/videos/${id}?fields=adaptiveFormats`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Invidious2 ${res.status}`);
      const data = await res.json();
      const formats = (data.adaptiveFormats || []).filter(f => f.type && f.type.startsWith('audio/'));
      formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!formats.length) throw new Error('No audio formats from Invidious2');
      return { src: formats[0].url, label: 'Invidious2' };
    },
    // 5. Piped API (another YouTube proxy)
    async () => {
      const res = await fetch(`https://pipedapi.kavin.rocks/streams/${id}`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Piped ${res.status}`);
      const data = await res.json();
      const streams = (data.audioStreams || []);
      streams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (!streams.length) throw new Error('No audio streams from Piped');
      return { src: streams[0].url, label: 'Piped' };
    },
  ];
}

async function tryNextFallback(video) {
  const state = _fallbackState[video.id];
  if (!state) return;

  const sources = getFallbackSources(video);

  while (state.strategyIndex < sources.length) {
    const idx = state.strategyIndex;
    state.strategyIndex++;

    const tryLabel = `strategy ${idx + 1}/${sources.length}`;
    showError(`⏳ Trying ${tryLabel}…`);
    setAudioLoading(true);

    try {
      const result = await sources[idx]();
      if (!result || !result.src) throw new Error('No src returned');

      console.log(`[Soundwave] Trying ${result.label}:`, result.src.slice(0, 80));

      // Set new source without triggering another error listener cycle
      audio.pause();
      audio.removeAttribute('src');
      audio.load();

      await new Promise((resolve, reject) => {
        const onCanPlay = () => { cleanup(); resolve(); };
        const onError   = () => { cleanup(); reject(new Error(`audio error on ${result.label}`)); };
        function cleanup() {
          audio.removeEventListener('canplay', onCanPlay);
          audio.removeEventListener('error', onError);
        }
        audio.addEventListener('canplay', onCanPlay, { once: true });
        audio.addEventListener('error',   onError,   { once: true });

        audio.src = result.src;
        audio.volume = State.isMuted ? 0 : State.volume;
        audio.load();
      });

      // Source loaded! Play it.
      hideError();
      setAudioLoading(false);
      const playPromise = audio.play();
      if (playPromise) playPromise.catch(err => {
        // Autoplay blocked — show a "tap to play" hint
        console.warn('Autoplay blocked:', err);
        setPlayPauseIcon(false);
        showError('▶ Tap Play to start');
      });
      return; // success — stop trying fallbacks

    } catch (err) {
      console.warn(`[Soundwave] ${tryLabel} failed:`, err.message);
      // continue loop to next strategy
    }
  }

  // All strategies exhausted — show error but DO NOT skip
  setAudioLoading(false);
  showError('⚠️ Could not load audio. Check server / yt-dlp install. Press ▶ to retry or ⏭ to skip.');
}

// ========================
// PLAYBACK ENTRY POINT
// ========================
async function playVideo(video) {
  if (!video) return;

  State.currentIndex = State.queue.findIndex(v => v.id === video.id);
  if (State.currentIndex === -1) {
    State.queue.unshift(video);
    State.currentIndex = 0;
  }

  State.loadingVideoId = video.id;

  updatePlayerUI(video);
  openOverlay();
  hideError();
  setAudioLoading(true);

  // Stop current audio cleanly
  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  resetFallbacks(video.id);
  await tryNextFallback(video);

  D.npYtBtn.href = `https://www.youtube.com/watch?v=${video.id}`;
  updateQueueUI();
  updateTopbarMini(video);
}

function reloadCurrent() {
  const cur = State.queue[State.currentIndex];
  if (cur) {
    resetFallbacks(cur.id);  // start from strategy 1 again
    playVideo(cur);
  }
}

function playNext() {
  if (State.queue.length === 0) return;
  let next;
  if (State.isShuffle) {
    next = Math.floor(Math.random() * State.queue.length);
  } else {
    next = State.currentIndex + 1;
    if (next >= State.queue.length) next = 0;
  }
  State.currentIndex = next;
  playVideo(State.queue[next]);
}

function playPrev() {
  if (State.queue.length === 0) return;
  if (audio.currentTime > 5) { audio.currentTime = 0; return; }
  let prev = State.currentIndex - 1;
  if (prev < 0) prev = State.queue.length - 1;
  State.currentIndex = prev;
  playVideo(State.queue[prev]);
}

// ========================
// PLAY / PAUSE TOGGLE
// ========================
function togglePlay() {
  if (State.currentIndex < 0) return;
  if (!audio.src) {
    // Retry loading current track
    reloadCurrent();
    return;
  }
  if (State.isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(() => reloadCurrent());
  }
}

function setPlayPauseIcon(playing) {
  D.playBtn.querySelector('.icon-play').style.display  = playing ? 'none'  : 'block';
  D.playBtn.querySelector('.icon-pause').style.display = playing ? 'block' : 'none';
}

// ========================
// SHUFFLE / REPEAT
// ========================
function toggleShuffle() {
  State.isShuffle = !State.isShuffle;
  D.shuffleBtn.classList.toggle('active', State.isShuffle);
  showToast(State.isShuffle ? '🔀 Shuffle on' : '🔀 Shuffle off');
}
function toggleRepeat() {
  State.isRepeat = !State.isRepeat;
  D.repeatBtn.classList.toggle('active', State.isRepeat);
  showToast(State.isRepeat ? '🔁 Repeat on' : '🔁 Repeat off');
}

// ========================
// SEEK TIMER
// ========================
function startSeekTimer() {
  stopSeekTimer();
  State.seekTimer = setInterval(() => {
    if (!State.isPlaying) return;
    updateTimeUI(audio.currentTime, audio.duration || State.duration);
  }, 500);
}
function stopSeekTimer() {
  clearInterval(State.seekTimer);
  State.seekTimer = null;
}

// ========================
// TIME UI
// ========================
function formatTime(s) {
  s = Math.floor(s || 0);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

function updateTimeUI(current, total) {
  const pct = total > 0 ? Math.min((current/total)*100, 100) : 0;
  D.seekProgress.style.width = `${pct}%`;
  D.seekThumb.style.left = `${pct}%`;
  D.currentTime.textContent = formatTime(current);
  D.totalTime.textContent = formatTime(total);
}

// ========================
// SEEK
// ========================
let seekDragging = false;

D.seekBar.addEventListener('mousedown', e => { seekDragging = true; doSeek(e); });
document.addEventListener('mousemove', e => { if (seekDragging) doSeek(e); });
document.addEventListener('mouseup', e => { if (seekDragging) { seekDragging = false; commitSeek(e); } });
D.seekBar.addEventListener('touchstart', e => { seekDragging = true; doSeekTouch(e); }, {passive:true});
document.addEventListener('touchmove', e => { if (seekDragging) doSeekTouch(e); }, {passive:true});
document.addEventListener('touchend', () => { seekDragging = false; });

function doSeek(e) {
  const r = D.seekBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  updateTimeUI(pct * (audio.duration || 0), audio.duration || 0);
}
function doSeekTouch(e) {
  const r = D.seekBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.touches[0].clientX - r.left) / r.width));
  updateTimeUI(pct * (audio.duration || 0), audio.duration || 0);
}
function commitSeek(e) {
  const r = D.seekBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (isFinite(audio.duration)) audio.currentTime = pct * audio.duration;
}

// ========================
// VOLUME
// ========================
let volDragging = false;
D.volBar.addEventListener('mousedown', e => { volDragging = true; setVol(e); });
document.addEventListener('mousemove', e => { if (volDragging) setVol(e); });
document.addEventListener('mouseup', () => { volDragging = false; });

function setVol(e) {
  const r = D.volBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  State.volume = pct;
  State.isMuted = false;
  D.volProgress.style.width = `${pct*100}%`;
  D.volThumb.style.left = `${pct*100}%`;
  D.volBtn.querySelector('.icon-vol').style.display  = 'block';
  D.volBtn.querySelector('.icon-mute').style.display = 'none';
  audio.volume = pct;
}

D.volBtn.addEventListener('click', () => {
  State.isMuted = !State.isMuted;
  D.volBtn.querySelector('.icon-vol').style.display  = State.isMuted ? 'none'  : 'block';
  D.volBtn.querySelector('.icon-mute').style.display = State.isMuted ? 'block' : 'none';
  audio.volume = State.isMuted ? 0 : State.volume;
});

// ========================
// NOW PLAYING OVERLAY
// ========================
function openOverlay()  { D.overlay.classList.add('active'); }
function closeOverlay() { D.overlay.classList.remove('active'); }
D.closeBtn.addEventListener('click', closeOverlay);
D.openNpBtn.addEventListener('click', openOverlay);
D.overlay.addEventListener('click', e => { if (e.target === D.overlay) closeOverlay(); });
D.playerThumbWrap.addEventListener('click', () => { if (State.currentIndex >= 0) openOverlay(); });

function showError(msg) {
  D.npErrorBanner.style.display = 'flex';
  D.npErrorMsg.textContent = msg;
}
function hideError() {
  D.npErrorBanner.style.display = 'none';
}
// Skip button: user-initiated skip only
D.npSkipBtn.addEventListener('click', () => { hideError(); playNext(); });

// ========================
// PLAYER UI
// ========================
function updatePlayerUI(video) {
  D.playerThumb.src           = video.thumbnail;
  D.playerTitle.textContent   = video.title;
  D.playerChannel.textContent = video.channel || '—';
  D.npTitle.textContent       = video.title;
  D.npChannel.textContent     = video.channel || '—';
  D.npThumb.src               = video.thumbnail;
  updateLikeButtonUI(video);
}

function updateLikeButtonUI(video) {
  const liked = video.id && State.likedSongs.some(s => s.id === video.id);
  D.playerLikeBtn.classList.toggle('liked', liked);
  D.npLikeBtn.classList.toggle('liked', liked);
}

// ========================
// CONTROLS
// ========================
D.playBtn.addEventListener('click', togglePlay);
D.prevBtn.addEventListener('click', playPrev);
D.nextBtn.addEventListener('click', playNext);
D.shuffleBtn.addEventListener('click', toggleShuffle);
D.repeatBtn.addEventListener('click', toggleRepeat);
D.playerLikeBtn.addEventListener('click', () => { const c=State.queue[State.currentIndex]; if(c) toggleLike(c); });
D.npLikeBtn.addEventListener('click',     () => { const c=State.queue[State.currentIndex]; if(c) toggleLike(c); });

// ========================
// LIKES
// ========================
function toggleLike(video) {
  const idx = State.likedSongs.findIndex(s => s.id === video.id);
  if (idx === -1) { State.likedSongs.push(video); showToast('💜 Added to Liked Songs'); }
  else            { State.likedSongs.splice(idx, 1); showToast('💔 Removed from Liked Songs'); }
  localStorage.setItem('likedSongs', JSON.stringify(State.likedSongs));
  updateLikeButtonUI(video);
  document.querySelectorAll(`.card-like-btn[data-id="${video.id}"]`).forEach(btn => {
    btn.classList.toggle('liked', idx === -1);
    btn.querySelector('svg').style.fill   = idx === -1 ? 'var(--a3)' : 'none';
    btn.querySelector('svg').style.stroke = 'var(--a3)';
  });
  renderLikedSection();
  renderLikedSidebar();
}

function renderLikedSection() {
  D.likedCount.textContent = `${State.likedSongs.length} song${State.likedSongs.length !== 1 ? 's' : ''}`;
  const grid = D.likedGrid;
  if (State.likedSongs.length === 0) {
    grid.innerHTML = '<div class="empty-liked"><p>💜 Songs you like will appear here</p></div>';
    return;
  }
  grid.innerHTML = '';
  State.likedSongs.forEach((v,i) => grid.appendChild(buildCard(v, i)));
}

function renderLikedSidebar() {
  const list = D.likedList;
  if (State.likedSongs.length === 0) {
    list.innerHTML = `<div class="empty-library">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
      <p>Like songs to see them here</p>
    </div>`;
    return;
  }
  list.innerHTML = '';
  State.likedSongs.slice().reverse().forEach(v => {
    const item = document.createElement('div');
    item.className = 'liked-item-sidebar';
    item.innerHTML = `
      <img src="${v.thumbnail}" alt="" onerror="this.src='https://i.ytimg.com/vi/${v.id}/default.jpg'">
      <div><div class="li-title">${esc(v.title)}</div><div class="li-channel">${esc(v.channel||'—')}</div></div>
    `;
    item.addEventListener('click', () => { State.queue = [...State.likedSongs]; playVideo(v); });
    list.appendChild(item);
  });
}

// ========================
// QUEUE UI
// ========================
function updateQueueUI() {
  const list = D.queueList;
  if (State.queue.length === 0) {
    list.innerHTML = '<div class="empty-queue"><p>🎵 Play something to build your queue</p></div>';
    return;
  }
  list.innerHTML = '';
  State.queue.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = `queue-item${i === State.currentIndex ? ' active-queue' : ''}`;
    item.innerHTML = `
      <img src="${v.thumbnail}" alt="" onerror="this.src='https://i.ytimg.com/vi/${v.id}/default.jpg'">
      <div class="queue-item-info">
        <div class="queue-item-title">${esc(v.title)}</div>
        <div class="queue-item-channel">${esc(v.channel||'—')}</div>
      </div>
      <div class="queue-item-duration">${v.duration||''}</div>
    `;
    item.addEventListener('click', () => { State.currentIndex = i; playVideo(v); });
    list.appendChild(item);
  });
}

// ========================
// TOPBAR MINI
// ========================
function updateTopbarMini(video) {
  const mini = $('topbarMini');
  if (!mini) return;
  mini.style.display = 'flex';
  $('topbarThumb').src = video.thumbnail;
  $('topbarTitle').textContent = video.title;
}
$('topbarMini') && $('topbarMini').addEventListener('click', openOverlay);

// ========================
// PARTICLES
// ========================
function initParticles() {
  const canvas = $('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  const particles = Array.from({ length: 55 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
    r: Math.random() * 1.8 + 0.4,
    color: ['#a78bfa','#38bdf8','#f472b6','#34d399'][Math.floor(Math.random()*4)],
    alpha: Math.random() * 0.5 + 0.1,
  }));
  (function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = p.color; ctx.globalAlpha = p.alpha; ctx.fill();
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
    });
    for (let i = 0; i < particles.length; i++)
      for (let j = i+1; j < particles.length; j++) {
        const dx = particles[i].x-particles[j].x, dy = particles[i].y-particles[j].y;
        const d = Math.sqrt(dx*dx+dy*dy);
        if (d < 90) {
          ctx.beginPath(); ctx.moveTo(particles[i].x,particles[i].y); ctx.lineTo(particles[j].x,particles[j].y);
          ctx.strokeStyle='#a78bfa'; ctx.globalAlpha=(1-d/90)*0.07; ctx.lineWidth=0.5; ctx.stroke();
        }
      }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  })();
}

// ========================
// CARD BUILDER
// ========================
function buildCard(video, index) {
  const liked = State.likedSongs.some(s => s.id === video.id);
  const div = document.createElement('div');
  div.className = 'music-card';
  div.dataset.id = video.id;
  div.style.animationDelay = `${Math.min(index * 0.04, 0.6)}s`;
  div.innerHTML = `
    <div class="card-thumb-wrap">
      <img class="card-thumb" src="${video.thumbnail}" alt="${esc(video.title)}" loading="lazy"
           onerror="this.src='https://i.ytimg.com/vi/${video.id}/default.jpg'">
      <div class="card-overlay">
        <button class="card-play-btn" aria-label="Play">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      <button class="card-like-btn ${liked?'liked':''}" data-id="${video.id}" aria-label="Like">
        <svg viewBox="0 0 24 24" fill="${liked?'var(--a3)':'none'}" stroke="var(--a3)" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
      </button>
    </div>
    <div class="card-body">
      <div class="card-title">${esc(video.title)}</div>
      <div class="card-channel">${esc(video.channel||'—')}</div>
      <div class="card-duration">${video.duration||''}</div>
    </div>
  `;
  div.addEventListener('click', () => playVideo(video));
  div.querySelector('.card-play-btn').addEventListener('click', e => { e.stopPropagation(); playVideo(video); });
  div.querySelector('.card-like-btn').addEventListener('click', e => { e.stopPropagation(); toggleLike(video); });
  return div;
}

function buildSkeletons(container, n=12) {
  container.innerHTML = '';
  for (let i=0; i<n; i++) {
    const d = document.createElement('div');
    d.className = 'skeleton-card';
    d.innerHTML = '<div class="skeleton-thumb"></div><div class="skeleton-body"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>';
    container.appendChild(d);
  }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ========================
// TRENDING
// ========================
async function loadTrending() {
  buildSkeletons(D.trendingGrid);
  try {
    const res = await fetch('/api/trending');
    const data = await res.json();
    renderCards(D.trendingGrid, data.results);
    if (data.results.length > 0) State.queue = data.results;
    updateQueueUI();
  } catch(e) {
    D.trendingGrid.innerHTML = '<p style="color:var(--tx3);padding:20px">Failed to load. Try searching instead.</p>';
  } finally {
    D.trendingLoader.style.display = 'none';
  }
}

function renderCards(container, videos) {
  container.innerHTML = '';
  if (!videos || videos.length === 0) {
    container.innerHTML = '<p style="color:var(--tx3);padding:20px">No results found.</p>';
    return;
  }
  videos.forEach((v,i) => container.appendChild(buildCard(v,i)));
}

// ========================
// IN-PAGE SEARCH
// ========================
let searchDebounce;
D.searchInput.addEventListener('input', () => {
  const q = D.searchInput.value.trim();
  D.searchClear.style.display = q ? 'block' : 'none';
  clearTimeout(searchDebounce);
  if (!q) {
    D.searchResults.innerHTML = '<div class="search-placeholder"><div class="placeholder-icon">🎧</div><p>Search for anything</p></div>';
    return;
  }
  searchDebounce = setTimeout(() => doSearch(q), 500);
});
D.searchInput.addEventListener('keydown', e => { if (e.key==='Enter' && D.searchInput.value.trim()) doSearch(D.searchInput.value.trim()); });
D.searchClear.addEventListener('click', () => {
  D.searchInput.value = ''; D.searchClear.style.display = 'none';
  D.searchResults.innerHTML = '<div class="search-placeholder"><div class="placeholder-icon">🎧</div><p>Search for anything</p></div>';
  D.searchInput.focus();
});

async function doSearch(q) {
  D.searchSpinner.classList.add('active');
  buildSkeletons(D.searchResults);
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    D.searchResults.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'search-results-header';
    hdr.textContent = `Results for "${data.query}" — ${data.results.length} found`;
    D.searchResults.appendChild(hdr);
    const grid = document.createElement('div');
    grid.className = 'cards-grid';
    D.searchResults.appendChild(grid);
    renderCards(grid, data.results);
    if (data.results.length > 0) { State.queue = data.results; updateQueueUI(); }
  } catch(e) {
    D.searchResults.innerHTML = '<p style="color:var(--tx3);padding:20px">Search failed. Try again.</p>';
  } finally {
    D.searchSpinner.classList.remove('active');
  }
}

// ========================
// GLOBAL SEARCH BAR
// ========================
const G = {
  input:       $('globalSearchInput'),
  dropdown:    $('gsbDropdown'),
  spinner:     $('gsbSpinner'),
  clearBtn:    $('gsbClear'),
  recentSec:   $('gsbRecent'),
  recentList:  $('gsbRecentList'),
  clearRecent: $('gsbClearRecent'),
  sugSec:      $('gsbSuggestions'),
  sugList:     $('gsbSuggestionsList'),
  prevSec:     $('gsbPreview'),
  prevList:    $('gsbPreviewList'),
  seeAll:      $('gsbSeeAll'),
  backdrop:    $('gsbBackdrop'),
};
let recentSearches = JSON.parse(localStorage.getItem('recentSearches')||'[]');
let gsbDebounce;
const SUGGESTIONS = ['Top hits 2025','Chill lo-fi beats','Pop music','Hip hop classics','Rock anthems','Indie folk','Electronic dance','Jazz relaxing','K-pop hits','Acoustic covers','R&B soul','Latin hits','Workout music','Study music'];

function gsbOpen()  { G.dropdown.classList.add('open'); G.backdrop.classList.add('active'); renderGsbRecent(); }
function gsbClose() { G.dropdown.classList.remove('open'); G.backdrop.classList.remove('active'); if (G.input) G.input.blur(); }

function renderGsbRecent() {
  if (!G.recentList) return;
  G.recentList.innerHTML = '';
  if (!recentSearches.length) { G.recentList.innerHTML = '<div class="gsb-no-recent">No recent searches</div>'; return; }
  recentSearches.slice(0,6).forEach(q => {
    const item = document.createElement('div');
    item.className = 'gsb-recent-item';
    item.innerHTML = `
      <div class="gsb-recent-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
      <span class="gsb-recent-text">${esc(q)}</span>
      <button class="gsb-recent-remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    `;
    item.addEventListener('click', e => {
      if (e.target.closest('.gsb-recent-remove')) {
        recentSearches = recentSearches.filter(s=>s!==q);
        localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        renderGsbRecent(); return;
      }
      runGsbSearch(q);
    });
    G.recentList.appendChild(item);
  });
}

function showGsbSuggestions(q) {
  if (!G.sugList) return;
  const matches = SUGGESTIONS.filter(s => s.toLowerCase().includes(q.toLowerCase())).slice(0,4);
  const extras  = [`${q} official`,`${q} live`,`${q} mix`].slice(0, 4-matches.length);
  const all     = [...new Set([...matches,...extras])].slice(0,5);
  G.sugList.innerHTML = '';
  all.forEach(s => {
    const item = document.createElement('div');
    item.className = 'gsb-suggestion-item';
    const safe_q = q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const hl = esc(s).replace(new RegExp(`(${safe_q})`, 'gi'), '<strong>$1</strong>');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>${hl}</span>`;
    item.addEventListener('click', () => runGsbSearch(s));
    G.sugList.appendChild(item);
  });
  G.sugSec.style.display = 'block';
}

async function runGsbSearch(q) {
  if (!q.trim()) return;
  recentSearches = [q, ...recentSearches.filter(s=>s!==q)].slice(0,10);
  localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
  switchSection('search');
  document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('active'));
  const sb = document.querySelector('.mn-btn[data-section="search"]');
  if (sb) sb.classList.add('active');
  D.searchInput.value = q;
  D.searchClear.style.display = 'block';
  if (G.input) G.input.value = q;
  gsbClose();
  doSearch(q);
}

if (G.input) {
  G.input.addEventListener('focus', () => { gsbOpen(); if (!G.input.value.trim()) { G.sugSec.style.display='none'; G.prevSec.style.display='none'; } });
  G.input.addEventListener('input', () => {
    const q = G.input.value.trim();
    G.clearBtn.classList.toggle('visible', q.length > 0);
    if (!q) { G.sugSec.style.display='none'; G.prevSec.style.display='none'; G.recentSec.style.display='block'; renderGsbRecent(); clearTimeout(gsbDebounce); return; }
    G.recentSec.style.display='none'; showGsbSuggestions(q);
    clearTimeout(gsbDebounce);
    gsbDebounce = setTimeout(async () => {
      G.spinner.classList.add('active');
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.results && data.results.length > 0) {
          G.prevList.innerHTML = '';
          data.results.slice(0,4).forEach(v => {
            const item = document.createElement('div');
            item.className = 'gsb-preview-result';
            item.innerHTML = `
              <img class="gsb-preview-thumb" src="${v.thumbnail}" alt="" onerror="this.src='https://i.ytimg.com/vi/${v.id}/default.jpg'">
              <div class="gsb-preview-info"><div class="gsb-preview-title">${esc(v.title)}</div><div class="gsb-preview-channel">${esc(v.channel||'—')}</div></div>
              <span class="gsb-preview-duration">${v.duration||''}</span>
              <button class="gsb-preview-play" aria-label="Play"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
            `;
            item.addEventListener('click', () => { State.queue = data.results; playVideo(v); gsbClose(); });
            G.prevList.appendChild(item);
          });
          G.prevSec.style.display = 'block';
        }
      } catch(e) {} finally { G.spinner.classList.remove('active'); }
    }, 650);
  });
  G.input.addEventListener('keydown', e => {
    if (e.key==='Enter' && G.input.value.trim()) runGsbSearch(G.input.value.trim());
    if (e.key==='Escape') gsbClose();
  });
  G.clearBtn.addEventListener('click', () => { G.input.value=''; G.clearBtn.classList.remove('visible'); G.sugSec.style.display='none'; G.prevSec.style.display='none'; G.recentSec.style.display='block'; renderGsbRecent(); G.input.focus(); });
  G.clearRecent.addEventListener('click', () => { recentSearches=[]; localStorage.setItem('recentSearches','[]'); renderGsbRecent(); });
  G.seeAll.addEventListener('click', () => { if (G.input.value.trim()) runGsbSearch(G.input.value.trim()); });
}
G.backdrop && G.backdrop.addEventListener('click', gsbClose);

// ========================
// GREETING & NAV
// ========================
function setGreeting() {
  const h = new Date().getHours();
  D.timeGreeting.textContent = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); switchSection(item.dataset.section); closeSidebar(); });
  });
  document.querySelectorAll('.mn-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchSection(btn.dataset.section);
    });
  });
}

function switchSection(name) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-section="${name}"]`);
  if (navItem) navItem.classList.add('active');
  const sec = $(`${name}Section`);
  if (sec) sec.classList.add('active');
}

function openSidebar()  { D.sidebar.classList.add('open'); D.sidebarOverlay.classList.add('active'); }
function closeSidebar() { D.sidebar.classList.remove('open'); D.sidebarOverlay.classList.remove('active'); }
D.mobileMenuBtn.addEventListener('click', openSidebar);
D.sidebarOverlay.addEventListener('click', closeSidebar);
D.mobileSearchIconBtn.addEventListener('click', () => {
  switchSection('search');
  document.querySelectorAll('.mn-btn').forEach(b => b.classList.remove('active'));
  const sb = document.querySelector('.mn-btn[data-section="search"]');
  if (sb) sb.classList.add('active');
  setTimeout(() => D.searchInput && D.searchInput.focus(), 300);
});

// ========================
// KEYBOARD SHORTCUTS
// ========================
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '/') { e.preventDefault(); if (G.input) { G.input.focus(); gsbOpen(); } }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') playNext();
  if (e.code === 'ArrowLeft')  playPrev();
  if (e.key === 'l' || e.key === 'L') { const c=State.queue[State.currentIndex]; if(c) toggleLike(c); }
  if (e.key === 'Escape') { closeOverlay(); gsbClose(); }
});

// ========================
// TOAST
// ========================
function showToast(msg) {
  let c = document.querySelector('.toast-container');
  if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ========================
// INIT
// ========================
function init() {
  setGreeting();
  initParticles();
  initNav();
  loadTrending();
  renderLikedSection();
  renderLikedSidebar();
  renderGsbRecent();
  D.volProgress.style.width = `${State.volume*100}%`;
  D.volThumb.style.left = `${State.volume*100}%`;
}

init();
