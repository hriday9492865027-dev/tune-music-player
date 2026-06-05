// ── Dual Audio Setup ──
let audioA = new Audio();
let audioB = new Audio();
let activeAudio = audioA;
let inactiveAudio = audioB;

// Cross-browser attribute
audioA.crossOrigin = "anonymous";
audioB.crossOrigin = "anonymous";

let tracks = [];
let currentIdx = -1;
let shuffle = false;
let repeat = false;
let repeatMode = 0;  // 0=off, 1=one, 2=all
let autoplay = false;
let muted = false;
let crossfadeDuration = 3;
let crossfadeTimer = null;
let playbackSpeed = 1.0;
let loopA = null;
let loopB = null;
let loopActive = false;
let sleepTimerSec = 0;
let sleepTimerInterval = null;
let transitionMode = 'crossfade';
let searchQuery = '';
let sortField = 'default';
let sortDirection = 'asc';
let playQueue = [];

// ── JioSaavn API Integration ──
let activeTab = 'library';
let jiosaavnTracks = [];
let jiosaavnSearchQuery = '';
let jiosaavnSearchTimeout = null;
let jiosaavnApiUrl = localStorage.getItem('jiosaavn_api_url') || 'http://127.0.0.1:5100';

function saveApiUrl(val) {
  let cleaned = val.trim();
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  jiosaavnApiUrl = cleaned || 'http://127.0.0.1:5100';
  localStorage.setItem('jiosaavn_api_url', jiosaavnApiUrl);
}

// ── Listening Stats & History ──
let stats = {
  totalListeningTime: 0,
  playCounts: {}
};
let recentlyPlayed = [];
let listeningTimer = null;

// ── Web Audio API ──
let audioCtx = null;
let sourceA, sourceB;
let gainA, gainB;
// 5 Parametric EQ filters
let eqBand60, eqBand230, eqBand910, eqBand4000, eqBand14000;
// Reverb variables
let reverbNode, reverbDry, reverbWet;
let reverbValue = 0; // percentage (0 - 100)
// Volume Normalizer compressor
let normCompressor;
let normEnabled = false;
let analyser;
let visualizerCtx;
let visualizerCanvas;
let waveformData = [];
let waveformCanvas, waveformCtx;
let particleCanvas, particleCtx;
let particles = [];

function createImpulseResponse(context, duration, decay) {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const percent = i / length;
    const decayFactor = Math.exp(-percent * decay);
    // Dynamic stereo white noise decay envelope
    left[i] = (Math.random() * 2 - 1) * decayFactor;
    right[i] = (Math.random() * 2 - 1) * decayFactor;
  }
  return impulse;
}

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  sourceA = audioCtx.createMediaElementSource(audioA);
  sourceB = audioCtx.createMediaElementSource(audioB);
  
  gainA = audioCtx.createGain();
  gainB = audioCtx.createGain();
  
  // 5 EQ bands
  eqBand60 = audioCtx.createBiquadFilter();
  eqBand60.type = 'lowshelf';
  eqBand60.frequency.value = 60;
  
  eqBand230 = audioCtx.createBiquadFilter();
  eqBand230.type = 'peaking';
  eqBand230.frequency.value = 230;
  eqBand230.Q.value = 1.0;
  
  eqBand910 = audioCtx.createBiquadFilter();
  eqBand910.type = 'peaking';
  eqBand910.frequency.value = 910;
  eqBand910.Q.value = 1.0;
  
  eqBand4000 = audioCtx.createBiquadFilter();
  eqBand4000.type = 'peaking';
  eqBand4000.frequency.value = 4000;
  eqBand4000.Q.value = 1.0;
  
  eqBand14000 = audioCtx.createBiquadFilter();
  eqBand14000.type = 'highshelf';
  eqBand14000.frequency.value = 14000;
  
  // Reverb setup
  reverbNode = audioCtx.createConvolver();
  reverbNode.buffer = createImpulseResponse(audioCtx, 1.8, 3.5);
  
  reverbDry = audioCtx.createGain();
  reverbWet = audioCtx.createGain();
  
  // Set dry/wet mix
  reverbDry.gain.value = 1.0 - (reverbValue / 100);
  reverbWet.gain.value = reverbValue / 100;
  
  // Normalization compressor setup
  normCompressor = audioCtx.createDynamicsCompressor();
  normCompressor.threshold.value = -24;
  normCompressor.knee.value = 30;
  normCompressor.ratio.value = normEnabled ? 6.0 : 1.0; // 1.0 ratio is a perfect mathematical bypass
  normCompressor.attack.value = 0.003;
  normCompressor.release.value = 0.25;
  
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  
  // Route audio signals
  sourceA.connect(gainA);
  sourceB.connect(gainB);
  
  gainA.connect(eqBand60);
  gainB.connect(eqBand60);
  
  // EQ filter cascade
  eqBand60.connect(eqBand230);
  eqBand230.connect(eqBand910);
  eqBand910.connect(eqBand4000);
  eqBand4000.connect(eqBand14000);
  
  // Parallel Dry/Wet Reverb routing
  eqBand14000.connect(reverbDry);
  eqBand14000.connect(reverbNode);
  reverbNode.connect(reverbWet);
  
  // Connect Dry & Wet back to Compressor
  reverbDry.connect(normCompressor);
  reverbWet.connect(normCompressor);
  
  // Compressor to Analyser to Destination
  normCompressor.connect(analyser);
  analyser.connect(audioCtx.destination);

  visualizerCanvas = document.getElementById('visualizer');
  if(visualizerCanvas) {
    visualizerCtx = visualizerCanvas.getContext('2d');
    visualizerCanvas.width = window.innerWidth;
    visualizerCanvas.height = window.innerHeight * 0.4;
    window.addEventListener('resize', () => {
      visualizerCanvas.width = window.innerWidth;
      visualizerCanvas.height = window.innerHeight * 0.4;
    });
    drawVisualizer();
  }

  // Init waveform canvas
  waveformCanvas = document.getElementById('waveform-canvas');
  if (waveformCanvas) {
    waveformCtx = waveformCanvas.getContext('2d');
    const rect = waveformCanvas.parentElement.getBoundingClientRect();
    waveformCanvas.width = rect.width * window.devicePixelRatio;
    waveformCanvas.height = rect.height * window.devicePixelRatio;
    waveformCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  // Init particles
  initParticles();
}

function drawVisualizer() {
  requestAnimationFrame(drawVisualizer);
  if (!analyser || !visualizerCtx) return;
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  analyser.getByteFrequencyData(dataArray);

  visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
  const barWidth = (visualizerCanvas.width / bufferLength) * 2.5;
  let barHeight;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    barHeight = dataArray[i];
    visualizerCtx.fillStyle = `rgba(232, 197, 71, ${barHeight/255})`;
    visualizerCtx.fillRect(x, visualizerCanvas.height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
}

// ── Waveform Seekbar ──
function generateWaveform(fileOrUrl) {
  if (!audioCtx || !fileOrUrl) {
    waveformData = [];
    return;
  }
  
  if (fileOrUrl instanceof File || fileOrUrl instanceof Blob) {
    const reader = new FileReader();
    reader.onload = function(e) {
      decodeAudioBuffer(e.target.result);
    };
    reader.readAsArrayBuffer(fileOrUrl);
  } else if (typeof fileOrUrl === 'string') {
    fetch(fileOrUrl)
      .then(res => {
        if (!res.ok) throw new Error("Fetch failed");
        return res.arrayBuffer();
      })
      .then(arrayBuffer => {
        decodeAudioBuffer(arrayBuffer);
      })
      .catch((err) => {
        console.warn("Failed to generate waveform for URL", err);
        waveformData = [];
      });
  }
}

function decodeAudioBuffer(arrayBuffer) {
  if (!audioCtx) return;
  audioCtx.decodeAudioData(arrayBuffer.slice(0)).then(buffer => {
    const rawData = buffer.getChannelData(0);
    const samples = 200;
    const blockSize = Math.floor(rawData.length / samples);
    const filtered = [];
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[i * blockSize + j]);
      filtered.push(sum / blockSize);
    }
    const max = Math.max(...filtered);
    waveformData = filtered.map(d => d / (max || 1));
    drawWaveform(0);
  }).catch(() => { waveformData = []; });
}

function drawWaveform(progress) {
  if (!waveformCanvas || !waveformCtx || !waveformData.length) return;
  const rect = waveformCanvas.parentElement.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  waveformCtx.clearRect(0, 0, w * window.devicePixelRatio, h * window.devicePixelRatio);
  const barCount = waveformData.length;
  const totalBarW = w / barCount;
  const barW = totalBarW * 0.7;
  const gap = totalBarW * 0.3;
  const progressX = progress * w;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8c547';

  // Shade A-B loop active range
  if (loopA !== null && loopB !== null && activeAudio.duration) {
    const xa = (loopA / activeAudio.duration) * w;
    const xb = (loopB / activeAudio.duration) * w;
    waveformCtx.fillStyle = 'rgba(232, 197, 71, 0.18)';
    waveformCtx.fillRect(xa, 0, xb - xa, h);
  }

  for (let i = 0; i < barCount; i++) {
    const x = i * totalBarW + gap / 2;
    const barH = Math.max(2, waveformData[i] * h * 0.85);
    const y = (h - barH) / 2;
    waveformCtx.fillStyle = (x + barW) < progressX ? accent : 'rgba(255,255,255,0.18)';
    waveformCtx.beginPath();
    waveformCtx.roundRect(x, y, barW, barH, 2);
    waveformCtx.fill();
  }

  // Draw A marker line
  if (loopA !== null && activeAudio.duration) {
    const xa = (loopA / activeAudio.duration) * w;
    waveformCtx.strokeStyle = accent;
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();
    waveformCtx.moveTo(xa, 0);
    waveformCtx.lineTo(xa, h);
    waveformCtx.stroke();
    
    waveformCtx.fillStyle = '#fff';
    waveformCtx.font = 'bold 9px Syne';
    waveformCtx.fillText('A', xa + 4, 12);
  }

  // Draw B marker line
  if (loopB !== null && activeAudio.duration) {
    const xb = (loopB / activeAudio.duration) * w;
    waveformCtx.strokeStyle = accent;
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();
    waveformCtx.moveTo(xb, 0);
    waveformCtx.lineTo(xb, h);
    waveformCtx.stroke();
    
    waveformCtx.fillStyle = '#fff';
    waveformCtx.font = 'bold 9px Syne';
    waveformCtx.fillText('B', xb + 4, 12);
  }
}

// ── Particle System ──
function initParticles() {
  particleCanvas = document.getElementById('particles');
  if (!particleCanvas) return;
  particleCtx = particleCanvas.getContext('2d');
  particleCanvas.width = particleCanvas.parentElement.offsetWidth;
  particleCanvas.height = particleCanvas.parentElement.offsetHeight;
  window.addEventListener('resize', () => {
    if (!particleCanvas) return;
    particleCanvas.width = particleCanvas.parentElement.offsetWidth;
    particleCanvas.height = particleCanvas.parentElement.offsetHeight;
  });
  animateParticles();
}

function animateParticles() {
  requestAnimationFrame(animateParticles);
  if (!particleCtx || !particleCanvas) return;
  particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

  let bassEnergy = 0;
  if (analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    for (let i = 0; i < 8; i++) bassEnergy += data[i];
    bassEnergy /= (8 * 255);
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8c547';
  const spawnCount = Math.floor(bassEnergy * 5);
  for (let i = 0; i < spawnCount; i++) {
    particles.push({
      x: Math.random() * particleCanvas.width,
      y: particleCanvas.height + 5,
      size: Math.random() * 3 + bassEnergy * 6,
      speedX: (Math.random() - 0.5) * 0.6,
      speedY: Math.random() * 1.5 + 0.5 + bassEnergy * 2.5,
      life: 1,
      decay: Math.random() * 0.006 + 0.003,
      color: accent
    });
  }
  if (Math.random() < 0.25) {
    particles.push({
      x: Math.random() * particleCanvas.width,
      y: particleCanvas.height + 5,
      size: Math.random() * 2 + 1,
      speedX: (Math.random() - 0.5) * 0.3,
      speedY: Math.random() * 0.6 + 0.2,
      life: 1,
      decay: Math.random() * 0.003 + 0.001,
      color: accent
    });
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.speedX;
    p.y -= p.speedY;
    p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    particleCtx.save();
    particleCtx.globalAlpha = p.life;
    particleCtx.fillStyle = p.color;
    particleCtx.beginPath();
    particleCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    particleCtx.fill();
    particleCtx.restore();
  }
  if (particles.length > 350) particles.splice(0, particles.length - 350);
}

// ── IndexedDB ──
let db;
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TunePlayerDB', 1);
    req.onupgradeneeded = e => {
      db = e.target.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(); };
    req.onerror = e => reject(e);
  });
}

const DEFAULT_SONGS = [
  { url: "Aasa Kooda.mp3", title: "Aasa Kooda", artist: "Hariharan & Shakthisree Gopalan" },
  { url: "Adele - Skyfall (Official Lyric Video) - AdeleVEVO.mp3", title: "Skyfall", artist: "Adele" },
  { url: "Angu Vaana Konilu.mp3", title: "Angu Vaana Konilu", artist: "Unknown Artist" },
  { url: "Kaanthaa.mp3", title: "Kaanthaa", artist: "Masala Coffee" },
  { url: "Mandaara - SenSongsMp3.Co.mp3", title: "Mandaara", artist: "SenSongs" },
  { url: "Nee Singham Dhaa.mp3", title: "Nee Singham Dhaa", artist: "A.R. Rahman" },
  { url: "Rasputin.mp3", title: "Rasputin", artist: "Boney M." },
  { url: "Seetha Kalyana.mp3", title: "Seetha Kalyana", artist: "Unknown Artist" },
  { url: "TheHangingTree.mp3", title: "The Hanging Tree", artist: "James Newton Howard ft. Jennifer Lawrence" },
  { url: "Vidya Vox - Be Free (Pallivaalu Bhadravattakam) ft. Vandana Iyer - Vidya Vox.mp3", title: "Be Free (Pallivaalu Bhadravattakam)", artist: "Vidya Vox ft. Vandana Iyer" },
  { url: "Way Down We Go.mp3", title: "Way Down We Go", artist: "KALEO" }
];

function loadDefaultSongs() {
  tracks = DEFAULT_SONGS.map(s => ({
    url: s.url,
    name: s.url.replace(/\.[^.]+$/, ''),
    title: s.title,
    artist: s.artist,
    album: 'Default Playlist',
    picUrl: null,
    file: null,
    duration: 0,
    lyrics: [],
    dateAdded: Date.now()
  }));

  // Fetch track durations in background
  tracks.forEach((t, i) => {
    const tmp = new Audio(t.url);
    tmp.addEventListener('loadedmetadata', () => {
      t.duration = tmp.duration;
      updateTrackItem(i);
      saveTracksToDB();
    });
  });

  renderPlaylist();
  if (tracks.length > 0 && currentIdx === -1) {
    currentIdx = 0;
    activeAudio.src = tracks[0].url;
    updateUI(0);
  }
}

function saveTracksToDB() {
  if (!db) return;
  const tx = db.transaction('tracks', 'readwrite');
  const store = tx.objectStore('tracks');
  store.clear();
  tracks.forEach((t, i) => {
    store.put({ 
      id: i, 
      url: t.url,
      file: t.file, 
      title: t.title, 
      artist: t.artist, 
      album: t.album, 
      picUrl: t.picUrl, 
      duration: t.duration, 
      lyrics: t.lyrics, 
      dateAdded: t.dateAdded || Date.now(),
      jiosaavnId: t.jiosaavnId || null
    });
  });
}

function loadTracksFromDB() {
  if (!db) return;
  const tx = db.transaction('tracks', 'readonly');
  const store = tx.objectStore('tracks');
  const req = store.getAll();
  req.onsuccess = () => {
    const saved = req.result;
    if (saved && saved.length > 0) {
      tracks = saved.map(s => {
        return {
          url: s.file ? URL.createObjectURL(s.file) : s.url,
          name: (s.file ? s.file.name : s.url).replace(/\.[^.]+$/, ''),
          title: s.title,
          artist: s.artist,
          album: s.album,
          picUrl: s.picUrl,
          file: s.file || null,
          duration: s.duration || 0,
          lyrics: s.lyrics || [],
          dateAdded: s.dateAdded || Date.now(),
          jiosaavnId: s.jiosaavnId || null
        };
      });
      renderPlaylist();
      if (currentIdx === -1) {
        currentIdx = 0;
        activeAudio.src = tracks[0].url;
        updateUI(0);
      }
    } else {
      loadDefaultSongs();
    }
  };
}

// ── ID3 Tags ──
function extractTags(f) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve({});
    window.jsmediatags.read(f, {
      onSuccess: (tag) => {
        let picUrl = null;
        const picture = tag.tags.picture;
        if (picture) {
          let base64String = "";
          for (let i = 0; i < picture.data.length; i++) {
              base64String += String.fromCharCode(picture.data[i]);
          }
          picUrl = "data:" + picture.format + ";base64," + window.btoa(base64String);
        }
        resolve({
          title: tag.tags.title,
          artist: tag.tags.artist,
          album: tag.tags.album,
          picUrl: picUrl
        });
      },
      onError: () => resolve({})
    });
  });
}

// ── File loading ──
async function addFiles(files) {
  const audioFiles = Array.from(files).filter(f => f.type.startsWith('audio/'));
  const lrcFiles = Array.from(files).filter(f => f.name.endsWith('.lrc'));
  if (!audioFiles.length && !lrcFiles.length) return;

  for (const f of audioFiles) {
    const url = URL.createObjectURL(f);
    const name = f.name.replace(/\.[^.]+$/, '');
    let title = name;
    let artist = 'Unknown Artist';
    let album = '';
    let picUrl = null;

    const tags = await extractTags(f);
    if (tags.title) title = tags.title;
    else {
      const parts = name.split(' - ');
      if (parts.length >= 2) { title = parts.slice(1).join(' - ').trim(); artist = parts[0].trim(); }
    }
    if (tags.artist) artist = tags.artist;
    if (tags.album) album = tags.album;
    if (tags.picUrl) picUrl = tags.picUrl;

    tracks.push({ url, name, title, artist, album, picUrl, file: f, duration: 0, lyrics: [], dateAdded: Date.now() });
  }

  for (const f of lrcFiles) {
    const text = await f.text();
    const parsed = parseLrc(text);
    const name = f.name.replace(/\.[^.]+$/, '');
    const track = tracks.find(t => t.name === name);
    if (track) {
      track.lyrics = parsed;
    }
  }

  // Preload durations
  tracks.forEach((t, i) => {
    if (t.duration) return;
    const tmp = new Audio(t.url);
    tmp.addEventListener('loadedmetadata', () => {
      t.duration = tmp.duration;
      updateTrackItem(i);
      saveTracksToDB();
    });
  });

  renderPlaylist();
  saveTracksToDB();
  document.getElementById('file-input').value = '';

  if (currentIdx === -1) {
    currentIdx = 0;
    activeAudio.src = tracks[0].url;
    updateUI(0);
  }
}

function parseLrc(text) {
  const lines = text.split('\n');
  const lyrics = [];
  const timeRegex = /\[(\d{2}):(\d{2}(?:\.\d{2,3})?)\]/;
  lines.forEach(line => {
    const match = timeRegex.exec(line);
    if (match) {
      const min = parseInt(match[1]);
      const sec = parseFloat(match[2]);
      const txt = line.replace(timeRegex, '').trim();
      lyrics.push({ time: min * 60 + sec, text: txt });
    }
  });
  return lyrics;
}

// ── Drag & Drop ──
let dragStartIndex;

function dragStart(e, index) {
  dragStartIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.style.opacity = '0.5';
}
function dragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function drop(e, index) {
  e.preventDefault();
  e.stopPropagation();
  const dragEndIndex = index;
  if (dragStartIndex === dragEndIndex) return;

  const item = tracks.splice(dragStartIndex, 1)[0];
  tracks.splice(dragEndIndex, 0, item);

  if (currentIdx === dragStartIndex) {
    currentIdx = dragEndIndex;
  } else if (currentIdx > dragStartIndex && currentIdx <= dragEndIndex) {
    currentIdx--;
  } else if (currentIdx < dragStartIndex && currentIdx >= dragEndIndex) {
    currentIdx++;
  }

  renderPlaylist();
  saveTracksToDB();
}
function dragEnd(e) {
  e.currentTarget.style.opacity = '1';
}

// ── Playlist render ──
function renderPlaylist() {
  const pl = document.getElementById('playlist');
  const emptyMsg = document.getElementById('empty-msg');
  if (!tracks.length) { 
    emptyMsg.style.display = 'block'; 
    pl.innerHTML = '';
    pl.appendChild(emptyMsg);
    document.getElementById('playlist-label').textContent = 'Playlist';
    return; 
  }
  emptyMsg.style.display = 'none';
  pl.innerHTML = '';

  // ── Render Up Next / Play Queue Section ──
  if (playQueue.length > 0) {
    const qHeader = document.createElement('div');
    qHeader.className = 'playlist-label queue-label';
    qHeader.innerHTML = `<span>Up Next (${playQueue.length})</span><button class="clear-queue-btn" onclick="clearQueue(event)">Clear</button>`;
    pl.appendChild(qHeader);

    playQueue.forEach((t, qi) => {
      const item = document.createElement('div');
      item.className = 'track-item queue-item';
      
      item.innerHTML = `
        <div class="ti-num">${qi + 1}</div>
        <div class="ti-art">
          ${t.picUrl ? `<img src="${t.picUrl}">` : '🎵'}
        </div>
        <div class="ti-info">
          <div class="ti-name">${t.title}</div>
          <div class="ti-artist">${t.artist}</div>
        </div>
        <div class="ti-dur">${t.duration ? fmtTime(t.duration) : '—'}</div>
        <div class="ti-actions">
          <button class="ti-action-btn del-btn" onclick="removeFromQueue(event, ${qi})" title="Remove from Queue">✕</button>
        </div>
      `;
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.ti-action-btn')) {
          const idx = tracks.indexOf(t);
          playQueue.splice(qi, 1);
          if (idx !== -1) {
            playTrack(idx);
          } else {
            playTrackDirect(t);
          }
        }
      });
      pl.appendChild(item);
    });
  }

  // ── Filter and Sort All Tracks ──
  let filtered = tracks.map((t, idx) => ({ ...t, originalIndex: idx }));

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(t => 
      t.title.toLowerCase().includes(q) || 
      t.artist.toLowerCase().includes(q) || 
      (t.album && t.album.toLowerCase().includes(q))
    );
  }

  if (sortField !== 'default') {
    filtered.sort((a, b) => {
      let valA = '', valB = '';
      if (sortField === 'title') {
        valA = a.title.toLowerCase();
        valB = b.title.toLowerCase();
      } else if (sortField === 'artist') {
        valA = a.artist.toLowerCase();
        valB = b.artist.toLowerCase();
      } else if (sortField === 'duration') {
        valA = a.duration || 0;
        valB = b.duration || 0;
      } else if (sortField === 'date') {
        valA = a.dateAdded || 0;
        valB = b.dateAdded || 0;
      }

      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }

  // Label showing count
  const plLabel = document.getElementById('playlist-label');
  if (plLabel) {
    plLabel.textContent = searchQuery ? `Found Tracks (${filtered.length})` : `All Tracks (${filtered.length})`;
  }

  if (filtered.length === 0 && searchQuery) {
    const noResults = document.createElement('div');
    noResults.className = 'empty-list';
    noResults.innerHTML = `<span class="big">🔍</span>No tracks match "${searchQuery}"`;
    pl.appendChild(noResults);
    return;
  }

  const isListDraggable = !searchQuery && sortField === 'default';

  filtered.forEach((t, i) => {
    const origIdx = t.originalIndex;
    const item = document.createElement('div');
    item.className = 'track-item' + (origIdx === currentIdx ? ' active' : '');
    item.id = 'ti-' + origIdx;
    item.draggable = isListDraggable;
    
    if (isListDraggable) {
      item.addEventListener('dragstart', (e) => dragStart(e, origIdx));
      item.addEventListener('dragover', dragOver);
      item.addEventListener('drop', (e) => drop(e, origIdx));
      item.addEventListener('dragend', dragEnd);
    }

    item.innerHTML = `
      <div class="playing-anim ${activeAudio.paused ? 'paused' : ''}">
        <div class="bar-anim" style="height:6px"></div>
        <div class="bar-anim" style="height:10px"></div>
        <div class="bar-anim" style="height:4px"></div>
      </div>
      <div class="ti-num">${origIdx + 1}</div>
      <div class="ti-art">
        ${t.picUrl ? `<img src="${t.picUrl}">` : '🎵'}
      </div>
      <div class="ti-info">
        <div class="ti-name">${t.title}</div>
        <div class="ti-artist">${t.artist}</div>
      </div>
      <div class="ti-dur">${t.duration ? fmtTime(t.duration) : '—'}</div>
      <div class="ti-actions">
        <button class="ti-action-btn" onclick="playNext(event, ${origIdx})" title="Play Next">⮑</button>
        <button class="ti-action-btn" onclick="addToQueue(event, ${origIdx})" title="Add to Queue">➕</button>
        <button class="ti-action-btn del-btn" onclick="removeTrack(event, ${origIdx})" title="Remove">✕</button>
      </div>
    `;
    item.addEventListener('click', (e) => { 
      if (!e.target.closest('.ti-action-btn')) {
        playTrack(origIdx); 
      }
    });
    pl.appendChild(item);
  });
}

function updateTrackItem(i) {
  const el = document.getElementById('ti-' + i);
  if (!el) return;
  el.querySelector('.ti-dur').textContent = tracks[i].duration ? fmtTime(tracks[i].duration) : '—';
}

function removeTrack(e, i) {
  e.stopPropagation();
  if (tracks[i].url && tracks[i].url.startsWith('blob:')) {
    URL.revokeObjectURL(tracks[i].url);
  }
  tracks.splice(i, 1);
  if (currentIdx === i) { activeAudio.pause(); currentIdx = -1; showEmpty(); }
  else if (currentIdx > i) currentIdx--;
  renderPlaylist();
  saveTracksToDB();
  if (!tracks.length) showEmpty();
}

// ── Playback & Crossfade ──
function playTrack(i, isManualSkip = true) {
  if (i < 0 || i >= tracks.length) return;
  initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  
  if (crossfadeTimer) clearInterval(crossfadeTimer);
 
  const t = tracks[i];
  currentIdx = i;

  // Swap active and inactive
  const outAudio = activeAudio;
  const outGain = activeAudio === audioA ? gainA : gainB;
  
  activeAudio = inactiveAudio;
  inactiveAudio = outAudio;
  
  const inGain = activeAudio === audioA ? gainA : gainB;

  activeAudio.src = t.url;
  activeAudio.currentTime = 0;
  activeAudio.playbackRate = playbackSpeed;
  
  const v = document.getElementById('vol-slider').value / 100;
  const isGapless = transitionMode === 'gapless';
  const fadeDur = (isManualSkip || isGapless) ? 0 : crossfadeDuration; 
  
  if (fadeDur > 0 && !outAudio.paused) {
    inGain.gain.setValueAtTime(0, audioCtx.currentTime);
    inGain.gain.linearRampToValueAtTime(v, audioCtx.currentTime + fadeDur);
    
    outGain.gain.setValueAtTime(v, audioCtx.currentTime);
    outGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + fadeDur);
    
    setTimeout(() => { outAudio.pause(); outAudio.src = ''; }, fadeDur * 1000);
  } else {
    inGain.gain.setValueAtTime(v, audioCtx.currentTime);
    outAudio.pause();
    outAudio.src = '';
  }

  activeAudio.play();
  setPlayBtn(true);
  document.getElementById('art-wrap').classList.add('playing');
  
  updateUI(i);
  startCrossfadeChecker();
  generateWaveform(t.file || t.url);
  updateMiniPlayer();
  
  // Clear active loop markers for a new track
  clearLoop();
  recordPlayEvent(t);
}

function updateUI(i) {
  const t = tracks[i];
  if(!t) return;
  document.getElementById('song-title').textContent = t.title;
  document.getElementById('song-artist').textContent = t.artist;
  document.getElementById('player-card').style.display = 'flex';
  document.getElementById('no-song').style.display = 'none';

  const artImg = document.getElementById('art-img');
  const bgArt = document.getElementById('bg-art');
  const artPlaceholder = document.getElementById('art-placeholder');
  
  if (t.picUrl) {
    artImg.src = t.picUrl;
    artImg.classList.add('show');
    artPlaceholder.style.display = 'none';
    bgArt.style.backgroundImage = `url(${t.picUrl})`;
    
    const imgForColor = new Image();
    imgForColor.crossOrigin = "Anonymous";
    imgForColor.src = t.picUrl;
    imgForColor.onload = () => {
      try {
        if(typeof ColorThief !== 'undefined') {
          const colorThief = new ColorThief();
          const color = colorThief.getColor(imgForColor);
          document.documentElement.style.setProperty('--accent', `rgb(${color[0]}, ${color[1]}, ${color[2]})`);
          document.documentElement.style.setProperty('--bg', `rgb(${Math.max(10, color[0]-40)}, ${Math.max(10, color[1]-40)}, ${Math.max(10, color[2]-40)})`);
        }
      } catch (e) { console.warn("ColorThief failed", e); }
    };
  } else {
    artImg.classList.remove('show');
    artImg.src = '';
    artPlaceholder.style.display = 'block';
    bgArt.style.backgroundImage = 'none';
    document.documentElement.style.setProperty('--accent', '#e8c547');
    document.documentElement.style.setProperty('--bg', '#121215');
  }
  refreshPlaylistView();
  if (t.lyrics && document.getElementById('lyrics-panel').style.display !== 'none') {
    renderLyrics(t.lyrics, -1);
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album || 'Tune Player',
      artwork: t.picUrl ? [{ src: t.picUrl, type: 'image/png' }] : []
    });
  }
}

function startCrossfadeChecker() {
  if (crossfadeTimer) clearInterval(crossfadeTimer);
  crossfadeTimer = setInterval(() => {
    if (activeAudio.duration && !activeAudio.paused) {
      const timeRemaining = activeAudio.duration - activeAudio.currentTime;
      const triggerTime = transitionMode === 'gapless' ? 0.08 : crossfadeDuration;
      if (timeRemaining <= triggerTime && timeRemaining > 0) {
        clearInterval(crossfadeTimer);
        // Play next automatically
        if (playQueue.length > 0) {
          const nextTrackObj = playQueue.shift();
          const idx = tracks.indexOf(nextTrackObj);
          if (idx !== -1) {
            playTrack(idx, false);
          } else {
            playTrackDirect(nextTrackObj);
          }
          refreshPlaylistView();
          return;
        }

        let next;
        if (repeatMode === 1) { next = currentIdx; }
        else if (shuffle) { next = Math.floor(Math.random() * tracks.length); }
        else { next = (currentIdx + 1) % tracks.length; }
        
        if (currentIdx < tracks.length - 1 || repeatMode > 0 || shuffle || autoplay) {
           playTrack(next, false); 
        }
      }
    }
  }, 100);
}

function showEmpty() {
  document.getElementById('player-card').style.display = 'none';
  document.getElementById('no-song').style.display = 'block';
  document.getElementById('art-wrap').classList.remove('playing');
}

function togglePlay() {
  if (!tracks.length) return;
  initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  if (currentIdx === -1) { playTrack(0); return; }
  
  if (activeAudio.paused) {
    activeAudio.play();
    setPlayBtn(true);
    document.getElementById('art-wrap').classList.add('playing');
    document.querySelectorAll('.playing-anim').forEach(a => a.classList.remove('paused'));
  } else {
    activeAudio.pause();
    setPlayBtn(false);
    document.getElementById('art-wrap').classList.remove('playing');
    document.querySelectorAll('.playing-anim').forEach(a => a.classList.add('paused'));
  }
}

function setPlayBtn(playing) {
  document.getElementById('play-btn').textContent = playing ? '⏸' : '▶';
  const mb = document.getElementById('mini-play-btn');
  if (mb) mb.textContent = playing ? '⏸' : '▶';
}

function nextTrack() {
  if (!tracks.length) return;
  
  if (playQueue.length > 0) {
    const nextTrackObj = playQueue.shift();
    const idx = tracks.indexOf(nextTrackObj);
    if (idx !== -1) {
      playTrack(idx, true);
    } else {
      playTrackDirect(nextTrackObj);
    }
    refreshPlaylistView();
    return;
  }

  let next;
  if (repeatMode === 1) { next = currentIdx; }
  else if (shuffle) { next = Math.floor(Math.random() * tracks.length); }
  else { next = (currentIdx + 1) % tracks.length; }
  playTrack(next, true);
}

function prevTrack() {
  if (!tracks.length) return;
  if (activeAudio.currentTime > 3) { activeAudio.currentTime = 0; return; }
  const prev = shuffle
    ? Math.floor(Math.random() * tracks.length)
    : (currentIdx - 1 + tracks.length) % tracks.length;
  playTrack(prev, true);
}

function toggleShuffle() {
  shuffle = !shuffle;
  document.getElementById('shuffle-btn').classList.toggle('active', shuffle);
}

function toggleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const btn = document.getElementById('repeat-btn');
  const labels = ['↻','↻¹','↻'];
  btn.textContent = labels[repeatMode];
  btn.classList.toggle('active', repeatMode > 0);
}

function toggleAutoplay() {
  autoplay = !autoplay;
  const badge = document.getElementById('auto-badge');
  badge.classList.toggle('on', autoplay);
  document.getElementById('auto-label').textContent = autoplay ? 'Autoplay on' : 'Autoplay off';
}

// ── Progress & Events ──
function bindAudioEvents(aud) {
  aud.addEventListener('timeupdate', () => {
    if (aud !== activeAudio || !aud.duration) return;
    const pct = (aud.currentTime / aud.duration) * 100;
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('cur-time').textContent = fmtTime(aud.currentTime);
    document.getElementById('dur-time').textContent = fmtTime(aud.duration);
    
    // Waveform seekbar
    if (waveformData.length) drawWaveform(pct / 100);
    
    // Mini-player progress
    const mpf = document.getElementById('mini-progress-fill');
    if (mpf) mpf.style.width = pct + '%';

    // A-B Loop boundaries checker
    if (loopActive && loopA !== null && loopB !== null) {
      if (aud.currentTime >= loopB) {
        aud.currentTime = loopA;
      }
    }
    
    if (currentIdx >= 0 && !tracks[currentIdx].duration) {
      tracks[currentIdx].duration = aud.duration;
      updateTrackItem(currentIdx);
      saveTracksToDB();
    }
     
    if (currentIdx >= 0 && tracks[currentIdx].lyrics) {
      const ly = tracks[currentIdx].lyrics;
      const isSynced = Array.isArray(ly) && ly.length > 0 && typeof ly[0] === 'object' && 'time' in ly[0];
      if (isSynced) {
        syncLyrics(aud.currentTime, ly);
      }
    }
  });

  aud.addEventListener('ended', () => {
    if (aud !== activeAudio) return; // Ignore if it's the fading out track
    setPlayBtn(false);
    document.getElementById('art-wrap').classList.remove('playing');
    if (repeatMode === 1) { playTrack(currentIdx, false); return; }
    if (repeatMode === 2 || autoplay) { nextTrack(); return; }
    if (currentIdx < tracks.length - 1) { nextTrack(); return; }
    else { refreshPlaylistView(); }
  });
}

bindAudioEvents(audioA);
bindAudioEvents(audioB);

document.getElementById('progress-bar').addEventListener('click', function(e) {
  if(!activeAudio.duration) return;
  const rect = this.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  activeAudio.currentTime = pct * activeAudio.duration;
});

// ── Volume & Settings ──
function setVolume(v) {
  const vol = v / 100;
  if(gainA && gainB) {
    if(activeAudio === audioA) gainA.gain.value = vol;
    else gainB.gain.value = vol;
  } else {
    // Before AudioContext init
    audioA.volume = vol;
    audioB.volume = vol;
  }
  
  muted = false;
  document.getElementById('vol-pct').textContent = v + '%';
  document.getElementById('vol-icon').textContent = v == 0 ? '🔇' : v < 50 ? '🔈' : '🔉';
  const slider = document.getElementById('vol-slider');
  slider.style.background = `linear-gradient(to right, #e8c547 ${v}%, #2a2a2f ${v}%)`;
}

function toggleMute() {
  muted = !muted;
  const vol = muted ? 0 : document.getElementById('vol-slider').value / 100;
  if(gainA && gainB) {
    if(activeAudio === audioA) gainA.gain.value = vol;
    else gainB.gain.value = vol;
  } else {
    activeAudio.muted = muted;
  }
  document.getElementById('vol-icon').textContent = muted ? '🔇' : '🔉';
}

function toggleSettings() {
  const panel = document.getElementById('audio-settings');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function updateCrossfade() {
  crossfadeDuration = parseInt(document.getElementById('crossfade-slider').value);
  document.getElementById('cf-val').textContent = crossfadeDuration + 's';
}

// ── EQ Controls ──
function updateEQ() {
  initAudio();
  const b60 = parseInt(document.getElementById('eq-60').value);
  const b230 = parseInt(document.getElementById('eq-230').value);
  const b910 = parseInt(document.getElementById('eq-910').value);
  const b4000 = parseInt(document.getElementById('eq-4000').value);
  const b14000 = parseInt(document.getElementById('eq-14000').value);
  
  document.getElementById('eq-val-60').textContent = b60 > 0 ? '+'+b60+'dB' : b60+'dB';
  document.getElementById('eq-val-230').textContent = b230 > 0 ? '+'+b230+'dB' : b230+'dB';
  document.getElementById('eq-val-910').textContent = b910 > 0 ? '+'+b910+'dB' : b910+'dB';
  document.getElementById('eq-val-4000').textContent = b4000 > 0 ? '+'+b4000+'dB' : b4000+'dB';
  document.getElementById('eq-val-14000').textContent = b14000 > 0 ? '+'+b14000+'dB' : b14000+'dB';

  if (eqBand60) eqBand60.gain.value = b60;
  if (eqBand230) eqBand230.gain.value = b230;
  if (eqBand910) eqBand910.gain.value = b910;
  if (eqBand4000) eqBand4000.gain.value = b4000;
  if (eqBand14000) eqBand14000.gain.value = b14000;
}

function setEQPreset(p) {
  let b60=0, b230=0, b910=0, b4000=0, b14000=0;
  if (p === 'rock') { b60=4; b230=2; b910=-1; b4000=2; b14000=4; }
  else if (p === 'pop') { b60=-1; b230=1; b910=3; b4000=1; b14000=-1; }
  else if (p === 'bass') { b60=8; b230=4; b910=-1; b4000=-2; b14000=-3; }
  else if (p === 'classical') { b60=3; b230=1; b910=-2; b4000=2; b14000=3; }
  
  document.getElementById('eq-60').value = b60;
  document.getElementById('eq-230').value = b230;
  document.getElementById('eq-910').value = b910;
  document.getElementById('eq-4000').value = b4000;
  document.getElementById('eq-14000').value = b14000;
  updateEQ();
}

function updateReverb(v) {
  initAudio();
  reverbValue = parseInt(v);
  document.getElementById('reverb-val').textContent = reverbValue + '%';
  if (reverbDry && reverbWet) {
    const wetFraction = reverbValue / 100;
    reverbDry.gain.setValueAtTime(1.0 - wetFraction, audioCtx.currentTime);
    reverbWet.gain.setValueAtTime(wetFraction, audioCtx.currentTime);
  }
}

function toggleNormalization(enabled) {
  initAudio();
  normEnabled = enabled;
  document.getElementById('norm-toggle').checked = normEnabled;
  if (normCompressor) {
    const ratioVal = normEnabled ? 6.0 : 1.0;
    normCompressor.ratio.setValueAtTime(ratioVal, audioCtx.currentTime);
  }
}

// init slider gradient
setVolume(80);

// ── Media Session API Handlers ──
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => { if (currentIdx !== -1) togglePlay(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (currentIdx !== -1) togglePlay(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
}

// ── Keyboard shortcuts ──
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '?') {
    e.preventDefault();
    toggleShortcutsOverlay();
    return;
  }
  if (e.key === 'Escape') {
    closeAllOverlays();
    return;
  }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') { activeAudio.currentTime = Math.min(activeAudio.currentTime + 5, activeAudio.duration); }
  if (e.key === 'ArrowLeft') { activeAudio.currentTime = Math.max(activeAudio.currentTime - 5, 0); }
  if (e.key === 'ArrowUp') { const v = Math.min(+document.getElementById('vol-slider').value + 5, 100); document.getElementById('vol-slider').value = v; setVolume(v); }
  if (e.key === 'ArrowDown') { const v = Math.max(+document.getElementById('vol-slider').value - 5, 0); document.getElementById('vol-slider').value = v; setVolume(v); }
  if (e.key === 'n' || e.key === 'N') nextTrack();
  if (e.key === 'p' || e.key === 'P') prevTrack();
  if (e.key === 'm' || e.key === 'M') toggleMute();
});

// ── Helpers ──
function fmtTime(s) {
  if (isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

// ── Lyrics Handlers ──
let currentLyricIdx = -1;
function syncLyrics(time, lyrics) {
  let idx = lyrics.findIndex(l => l.time > time) - 1;
  if (idx === -2) idx = lyrics.length - 1;
  if (idx >= 0 && idx !== currentLyricIdx) {
    currentLyricIdx = idx;
    renderLyrics(lyrics, idx);
  }
}

function renderLyrics(lyrics, activeIdx) {
  const panel = document.getElementById('lyrics-content');
  if (!panel) return;
  panel.innerHTML = '';
  
  if (typeof lyrics === 'string') {
    const lines = lyrics.split('\n');
    lines.forEach(line => {
      const p = document.createElement('p');
      p.className = 'lyric-line static';
      p.style.cursor = 'default';
      p.textContent = line || ' ';
      panel.appendChild(p);
    });
    return;
  }
  
  if (Array.isArray(lyrics)) {
    const isSynced = lyrics.length > 0 && typeof lyrics[0] === 'object' && 'time' in lyrics[0];
    if (!isSynced) {
      lyrics.forEach(line => {
        const p = document.createElement('p');
        p.className = 'lyric-line static';
        p.style.cursor = 'default';
        p.textContent = typeof line === 'string' ? line : JSON.stringify(line);
        panel.appendChild(p);
      });
      return;
    }
    
    lyrics.forEach((l, i) => {
      const p = document.createElement('p');
      p.className = 'lyric-line' + (i === activeIdx ? ' active' : ' muted');
      p.textContent = l.text;
      p.onclick = () => { if (activeAudio) activeAudio.currentTime = l.time; };
      panel.appendChild(p);
      if (i === activeIdx) {
        p.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
}

function toggleLyrics() {
  const panel = document.getElementById('lyrics-panel');
  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    if (currentIdx >= 0 && tracks[currentIdx].lyrics) {
      renderLyrics(tracks[currentIdx].lyrics, currentLyricIdx);
    }
  } else {
    panel.style.display = 'none';
  }
}

// ── Mini-Player ──
function updateMiniPlayer() {
  const mini = document.getElementById('mini-player');
  if (!mini) return;
  if (currentIdx < 0 || !tracks.length) { mini.classList.remove('visible'); return; }
  mini.classList.add('visible');
  const t = tracks[currentIdx];
  document.getElementById('mini-title').textContent = t.title;
  document.getElementById('mini-artist').textContent = t.artist;
  const art = document.getElementById('mini-art-img');
  if (t.picUrl) { art.src = t.picUrl; art.style.display = 'block'; }
  else { art.style.display = 'none'; }
}

// ── Playback Speed, A-B Loop, Sleep Timer, Transition Mode Helpers ──
function updateSpeed(val) {
  playbackSpeed = parseFloat(val);
  document.getElementById('speed-val').textContent = playbackSpeed.toFixed(1) + 'x';
  if (audioA) audioA.playbackRate = playbackSpeed;
  if (audioB) audioB.playbackRate = playbackSpeed;
}

function setTransitionMode(mode) {
  transitionMode = mode;
}

function setLoopA() {
  if (!activeAudio || !activeAudio.duration) return;
  loopA = activeAudio.currentTime;
  if (loopB !== null && loopA >= loopB) {
    loopB = null;
    loopActive = false;
  }
  document.getElementById('ab-btn-a').classList.add('active');
  document.getElementById('ab-btn-b').classList.remove('active');
  updateLoopUI();
}

function setLoopB() {
  if (!activeAudio || !activeAudio.duration || loopA === null) return;
  const t = activeAudio.currentTime;
  if (t > loopA) {
    loopB = t;
    loopActive = true;
    document.getElementById('ab-btn-b').classList.add('active');
    updateLoopUI();
  }
}

function clearLoop() {
  loopA = null;
  loopB = null;
  loopActive = false;
  document.getElementById('ab-btn-a').classList.remove('active');
  document.getElementById('ab-btn-b').classList.remove('active');
  updateLoopUI();
}

function updateLoopUI() {
  const statusEl = document.getElementById('ab-loop-status');
  if (loopActive && loopA !== null && loopB !== null) {
    statusEl.textContent = `Loop: ${fmtTime(loopA)} - ${fmtTime(loopB)}`;
  } else if (loopA !== null) {
    statusEl.textContent = `Loop: A = ${fmtTime(loopA)}`;
  } else {
    statusEl.textContent = 'Loop: Off';
  }
  // Force a canvas redraw to instantly display markers
  if (waveformData.length) {
    const pct = (activeAudio.currentTime / activeAudio.duration);
    drawWaveform(pct);
  }
}

function setSleepTimer(minutes) {
  const mins = parseInt(minutes);
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  
  if (mins === 0) {
    sleepTimerSec = 0;
    document.getElementById('sleep-timer-val').textContent = 'Off';
    return;
  }
  
  sleepTimerSec = mins * 60;
  updateSleepTimerDisplay();
  
  sleepTimerInterval = setInterval(() => {
    if (sleepTimerSec > 0) {
      if (activeAudio && !activeAudio.paused) {
        sleepTimerSec--;
      }
      updateSleepTimerDisplay();
    } else {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
      triggerSleepTimerEnd();
    }
  }, 1000);
}

function updateSleepTimerDisplay() {
  const m = Math.floor(sleepTimerSec / 60);
  const s = sleepTimerSec % 60;
  document.getElementById('sleep-timer-val').textContent = `${m}:${s.toString().padStart(2, '0')} left`;
}

function triggerSleepTimerEnd() {
  const volSlider = document.getElementById('vol-slider');
  const startVol = volSlider ? volSlider.value / 100 : 0.8;
  let currentFadeVol = startVol;
  const fadeSteps = 20;
  const stepTime = 100;
  
  const fadeInterval = setInterval(() => {
    currentFadeVol -= startVol / fadeSteps;
    if (currentFadeVol <= 0) {
      clearInterval(fadeInterval);
      if (activeAudio) activeAudio.pause();
      setPlayBtn(false);
      document.getElementById('art-wrap').classList.remove('playing');
      
      // Restore standard volume settings
      setVolume(startVol * 100);
      if (volSlider) volSlider.value = startVol * 100;
      document.getElementById('sleep-timer-val').textContent = 'Off';
      document.getElementById('sleep-timer').value = '0';
    } else {
      if (gainA && gainB) {
        if (activeAudio === audioA) gainA.gain.value = currentFadeVol;
        else gainB.gain.value = currentFadeVol;
      } else if (activeAudio) {
        activeAudio.volume = currentFadeVol;
      }
    }
  }, stepTime);
}

// ── Search & Filter Helpers ──
function handleSearch(val) {
  const query = val.trim();
  if (activeTab === 'library') {
    searchQuery = query;
    renderPlaylist();
  } else {
    jiosaavnSearchQuery = query;
    if (jiosaavnSearchTimeout) clearTimeout(jiosaavnSearchTimeout);
    jiosaavnSearchTimeout = setTimeout(() => {
      performJioSaavnSearch(query);
    }, 400);
  }
}

function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-library').classList.toggle('active', tab === 'library');
  document.getElementById('tab-jiosaavn').classList.toggle('active', tab === 'jiosaavn');
  
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.toggle('jiosaavn-active', tab === 'jiosaavn');
  
  const quickBar = document.getElementById('jiosaavn-quick-bar');
  if (quickBar) {
    quickBar.style.display = tab === 'jiosaavn' ? 'block' : 'none';
  }
  
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = '';
    searchQuery = '';
    jiosaavnSearchQuery = '';
    searchInput.placeholder = tab === 'library' ? 'Search title, artist, album...' : 'Search JioSaavn online...';
  }
  
  if (tab === 'library') {
    renderPlaylist();
  } else {
    jiosaavnTracks = [];
    renderJioSaavnPlaylist();
  }
}

function fetchAllSaavnSongs() {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.value = 'Trending';
  }
  jiosaavnSearchQuery = 'Trending';
  performJioSaavnSearch('Trending');
}

function refreshPlaylistView() {
  if (activeTab === 'library') {
    renderPlaylist();
  } else {
    renderJioSaavnPlaylist();
  }
}

async function performJioSaavnSearch(query) {
  if (!query) {
    jiosaavnTracks = [];
    renderJioSaavnPlaylist();
    return;
  }
  
  const pl = document.getElementById('playlist');
  pl.innerHTML = `
    <div class="empty-list">
      <span class="big spinner">⏳</span>
      <br>Searching JioSaavn...
    </div>
  `;
  
  try {
    const response = await fetch(`${jiosaavnApiUrl}/result/?query=${encodeURIComponent(query)}&lyrics=true`);
    if (!response.ok) throw new Error("JioSaavn API error");
    
    const data = await response.json();
    let results = [];
    
    if (Array.isArray(data)) {
      results = data;
    } else if (data && typeof data === 'object') {
      if (data.songs && Array.isArray(data.songs)) {
        results = data.songs;
      } else if (data.media_url || data.encrypted_media_url) {
        results = [data];
      }
    }
    
    jiosaavnTracks = results.map(item => ({
      url: item.media_url,
      name: item.song,
      title: item.song,
      artist: item.singers || 'Unknown Artist',
      album: item.album || 'JioSaavn',
      picUrl: item.image || null,
      file: null,
      duration: parseInt(item.duration) || 0,
      lyrics: item.lyrics || null,
      dateAdded: Date.now(),
      jiosaavnId: item.id
    }));
    
    renderJioSaavnPlaylist();
  } catch (error) {
    console.error("JioSaavn search failed:", error);
    pl.innerHTML = `
      <div class="empty-list">
        <span class="big">⚠️</span>
        <br>Failed to search JioSaavn.<br>Make sure the API URL is correct and online.
      </div>
    `;
  }
}

function renderJioSaavnPlaylist() {
  const pl = document.getElementById('playlist');
  const emptyMsg = document.getElementById('empty-msg');
  
  pl.innerHTML = '';
  emptyMsg.style.display = 'none';
  
  if (!jiosaavnSearchQuery) {
    const promptMsg = document.createElement('div');
    promptMsg.className = 'empty-list';
    promptMsg.innerHTML = `<span class="big">🔍</span>Search millions of songs<br>directly from JioSaavn`;
    pl.appendChild(promptMsg);
    return;
  }
  
  if (jiosaavnTracks.length === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'empty-list';
    noResults.innerHTML = `<span class="big">❔</span>No online results found for "${jiosaavnSearchQuery}"`;
    pl.appendChild(noResults);
    return;
  }
  
  jiosaavnTracks.forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'track-item jiosaavn-item';
    
    const isPlayingThis = (currentIdx >= 0 && tracks[currentIdx] && tracks[currentIdx].jiosaavnId === t.jiosaavnId);
    if (isPlayingThis) {
      item.classList.add('active');
    }
    
    item.innerHTML = `
      <div class="playing-anim ${activeAudio.paused ? 'paused' : ''}">
        <div class="bar-anim" style="height:6px"></div>
        <div class="bar-anim" style="height:10px"></div>
        <div class="bar-anim" style="height:4px"></div>
      </div>
      <div class="ti-num">${i + 1}</div>
      <div class="ti-art">
        ${t.picUrl ? `<img src="${t.picUrl}">` : '🎵'}
      </div>
      <div class="ti-info">
        <div class="ti-name">${t.title}</div>
        <div class="ti-artist">${t.artist}</div>
      </div>
      <div class="ti-dur">${t.duration ? fmtTime(t.duration) : '—'}</div>
      <div class="ti-actions" style="opacity: 1; width: 30px;">
        <button class="ti-action-btn" onclick="addJioSaavnToLibrary(event, ${i})" title="Add to Library">➕</button>
      </div>
    `;
    
    item.style.paddingRight = '16px';
    
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.ti-action-btn')) {
        playJioSaavnTrack(i);
      }
    });
    
    pl.appendChild(item);
  });
}

function playJioSaavnTrack(i) {
  const t = jiosaavnTracks[i];
  
  let existingIdx = tracks.findIndex(item => item.jiosaavnId === t.jiosaavnId || (item.title === t.title && item.artist === t.artist));
  if (existingIdx === -1) {
    tracks.push(t);
    saveTracksToDB();
    existingIdx = tracks.length - 1;
  }
  
  playTrack(existingIdx, true);
  renderJioSaavnPlaylist();
}

function addJioSaavnToLibrary(e, i) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const t = jiosaavnTracks[i];
  
  const existingIdx = tracks.findIndex(item => item.jiosaavnId === t.jiosaavnId || (item.title === t.title && item.artist === t.artist));
  if (existingIdx !== -1) {
    showNotification(`"${t.title}" is already in Library`);
    return;
  }
  
  tracks.push(t);
  saveTracksToDB();
  showNotification(`Added "${t.title}" to Library`);
  
  if (activeTab === 'library') {
    renderPlaylist();
  }
}

function handleSortField(val) {
  sortField = val;
  renderPlaylist();
}

function toggleSortDirection() {
  sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  const btn = document.getElementById('sort-dir-btn');
  if (btn) {
    btn.classList.toggle('desc', sortDirection === 'desc');
  }
  renderPlaylist();
}

// ── Queue System Helpers ──
function addToQueue(e, idx) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (idx < 0 || idx >= tracks.length) return;
  const t = tracks[idx];
  playQueue.push(t);
  refreshPlaylistView();
  showNotification(`"${t.title}" added to queue`);
}

function playNext(e, idx) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (idx < 0 || idx >= tracks.length) return;
  const t = tracks[idx];
  playQueue.unshift(t);
  refreshPlaylistView();
  showNotification(`"${t.title}" will play next`);
}

function removeFromQueue(e, qIdx) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (qIdx < 0 || qIdx >= playQueue.length) return;
  const removed = playQueue.splice(qIdx, 1)[0];
  refreshPlaylistView();
  showNotification(`Removed "${removed.title}" from queue`);
}

function clearQueue(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  playQueue = [];
  refreshPlaylistView();
  showNotification("Queue cleared");
}

// ── Toast Notification Trigger ──
let toastTimeout = null;
function showNotification(msg) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// ── Direct Playback (For off-playlist items / queue items) ──
function playTrackDirect(t) {
  initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  activeAudio.src = t.url;
  activeAudio.currentTime = 0;
  activeAudio.playbackRate = playbackSpeed;
  activeAudio.play();
  setPlayBtn(true);
  document.getElementById('art-wrap').classList.add('playing');
  
  document.getElementById('song-title').textContent = t.title;
  document.getElementById('song-artist').textContent = t.artist;
  document.getElementById('player-card').style.display = 'flex';
  document.getElementById('no-song').style.display = 'none';
  
  const artImg = document.getElementById('art-img');
  const bgArt = document.getElementById('bg-art');
  const artPlaceholder = document.getElementById('art-placeholder');
  if (t.picUrl) {
    artImg.src = t.picUrl;
    artImg.classList.add('show');
    artPlaceholder.style.display = 'none';
    bgArt.style.backgroundImage = `url(${t.picUrl})`;
  } else {
    artImg.classList.remove('show');
    artImg.src = '';
    artPlaceholder.style.display = 'block';
    bgArt.style.backgroundImage = 'none';
  }
  recordPlayEvent(t);
}

initDB().then(() => {
  loadStatsAndRecent();
  startListeningTracker();
  loadTracksFromDB();
  const apiInput = document.getElementById('api-url-input');
  if (apiInput) {
    apiInput.value = jiosaavnApiUrl;
  }
}).catch(e => console.error("IndexedDB error:", e));

// ── Listening Stats & History Helper Actions ──
function loadStatsAndRecent() {
  try {
    const savedStats = localStorage.getItem('tune_stats');
    if (savedStats) stats = JSON.parse(savedStats);
    
    const savedRecent = localStorage.getItem('tune_recent');
    if (savedRecent) recentlyPlayed = JSON.parse(savedRecent);
  } catch (e) {
    console.error("Failed to load stats/recent from localStorage:", e);
  }
}

function saveStats() {
  try {
    localStorage.setItem('tune_stats', JSON.stringify(stats));
  } catch (e) {
    console.error("Failed to save stats to localStorage:", e);
  }
}

function saveRecent() {
  try {
    localStorage.setItem('tune_recent', JSON.stringify(recentlyPlayed));
  } catch (e) {
    console.error("Failed to save recent to localStorage:", e);
  }
}

function recordPlayEvent(track) {
  if (!track || !track.title) return;
  const key = `${track.title} - ${track.artist || 'Unknown Artist'}`;
  
  // 1. Increment Play Count
  if (!stats.playCounts) stats.playCounts = {};
  if (!stats.playCounts[key]) {
    stats.playCounts[key] = 0;
  }
  stats.playCounts[key]++;
  saveStats();

  // 2. Add to Recently Played
  recentlyPlayed = recentlyPlayed.filter(r => r.title !== track.title || r.artist !== track.artist);
  recentlyPlayed.unshift({
    title: track.title,
    artist: track.artist || 'Unknown Artist',
    picUrl: track.picUrl || null,
    timestamp: Date.now()
  });
  
  if (recentlyPlayed.length > 20) {
    recentlyPlayed.pop();
  }
  saveRecent();
}

function startListeningTracker() {
  if (listeningTimer) clearInterval(listeningTimer);
  listeningTimer = setInterval(() => {
    if (activeAudio && !activeAudio.paused) {
      if (!stats.totalListeningTime) stats.totalListeningTime = 0;
      stats.totalListeningTime++;
      if (stats.totalListeningTime % 5 === 0) {
        saveStats();
      }
    }
  }, 1000);
}

function fmtListeningTime(totalSecs) {
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

function timeAgo(pastTimestamp) {
  const diffMs = Date.now() - pastTimestamp;
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 10) return "Just now";
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

function updateStatsDashboardUI() {
  document.getElementById('stat-total-time').textContent = fmtListeningTime(stats.totalListeningTime || 0);

  const topList = document.getElementById('stat-top-tracks');
  topList.innerHTML = '';
  
  const playCounts = stats.playCounts || {};
  const sortedTracks = Object.entries(playCounts)
    .map(([key, count]) => {
      const idx = key.indexOf(' - ');
      let title = key;
      let artist = 'Unknown Artist';
      if (idx !== -1) {
        title = key.substring(0, idx);
        artist = key.substring(idx + 3);
      }
      return { title, artist, count };
    })
    .sort((a, b) => b.count - a.count);

  if (sortedTracks.length === 0) {
    topList.innerHTML = '<div class="empty-stats">No play data recorded yet. Songs will appear here as you play them!</div>';
  } else {
    const maxCount = sortedTracks[0].count;
    sortedTracks.slice(0, 5).forEach((t, i) => {
      const pct = maxCount > 0 ? (t.count / maxCount) * 100 : 0;
      const row = document.createElement('div');
      row.className = 'top-track-item';
      row.innerHTML = `
        <div class="tt-rank">#${i + 1}</div>
        <div class="tt-info">
          <div class="tt-title">${t.title}</div>
          <div class="tt-artist">${t.artist}</div>
        </div>
        <div class="tt-bar-wrapper">
          <div class="tt-bar-bg">
            <div class="tt-bar-fill" style="width: ${pct}%"></div>
          </div>
          <div class="tt-count">${t.count}x</div>
        </div>
      `;
      topList.appendChild(row);
    });
  }

  const recentList = document.getElementById('stat-recent-list');
  recentList.innerHTML = '';

  if (recentlyPlayed.length === 0) {
    recentList.innerHTML = '<div class="empty-stats">Your playback history is empty. Start listening to populate!</div>';
  } else {
    recentlyPlayed.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `
        <div class="recent-art">
          ${t.picUrl ? `<img src="${t.picUrl}">` : '🎵'}
        </div>
        <div class="recent-info">
          <div class="recent-title">${t.title}</div>
          <div class="recent-artist">${t.artist}</div>
        </div>
        <div class="recent-time">${timeAgo(t.timestamp)}</div>
      `;
      recentList.appendChild(item);
    });
  }
}

function toggleStatsDashboard() {
  const overlay = document.getElementById('stats-overlay');
  if (!overlay) return;
  if (overlay.style.display === 'none') {
    updateStatsDashboardUI();
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

function resetStatsData() {
  if (confirm("Are you sure you want to reset all listening history and statistics?")) {
    stats = { totalListeningTime: 0, playCounts: {} };
    recentlyPlayed = [];
    saveStats();
    saveRecent();
    updateStatsDashboardUI();
    showNotification("Listening activity reset successfully");
  }
}

// ── Overlays and Modals Helpers ──
function toggleShortcutsOverlay() {
  const overlay = document.getElementById('shortcuts-overlay');
  if (!overlay) return;
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
}

function handleShortcutsOverlayClick(e) {
  if (e.target.id === 'shortcuts-overlay') {
    toggleShortcutsOverlay();
  }
}

function closeAllOverlays() {
  const shortcuts = document.getElementById('shortcuts-overlay');
  if (shortcuts) shortcuts.style.display = 'none';
  
  const statsDashboard = document.getElementById('stats-overlay');
  if (statsDashboard) statsDashboard.style.display = 'none';

  const settings = document.querySelector('.audio-settings');
  if (settings && settings.style.display !== 'none') {
    settings.style.display = 'none';
  }
}

// ── Playlist Export & Import Functions ──
function exportPlaylist() {
  if (!tracks.length) {
    showNotification("Playlist is empty. Nothing to export!");
    return;
  }
  
  // Package playlist metadata safely
  const exportData = tracks.map(t => ({
    title: t.title,
    artist: t.artist || 'Unknown Artist',
    album: t.album || '',
    duration: t.duration || 0,
    lyrics: t.lyrics || [],
    dateAdded: t.dateAdded || Date.now()
  }));

  try {
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tune_playlist_export.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification("Playlist backup exported successfully");
  } catch (err) {
    console.error("Export error:", err);
    showNotification("Failed to export playlist backup");
  }
}

async function importPlaylist(files) {
  if (!files || !files.length) return;
  const file = files[0];
  if (!file.name.endsWith('.json')) {
    showNotification("Please select a valid .json playlist backup file");
    return;
  }

  try {
    const text = await file.text();
    const backupData = JSON.parse(text);
    
    if (!Array.isArray(backupData)) {
      showNotification("Invalid backup format: expected a JSON list");
      return;
    }

    if (!tracks.length) {
      showNotification("Imported metadata. Please drag/add audio files to start playback!");
    }

    let matchCount = 0;
    backupData.forEach(backupItem => {
      if (!backupItem.title) return;
      
      // Match track inside our active list (fuzzy title matches or filename base matches)
      const matchedTrack = tracks.find(t => 
        t.title.toLowerCase().trim() === backupItem.title.toLowerCase().trim() ||
        t.name.toLowerCase().trim() === backupItem.title.toLowerCase().trim()
      );
      
      if (matchedTrack) {
        matchedTrack.title = backupItem.title;
        matchedTrack.artist = backupItem.artist || matchedTrack.artist;
        matchedTrack.album = backupItem.album || matchedTrack.album;
        matchedTrack.lyrics = backupItem.lyrics || matchedTrack.lyrics;
        matchedTrack.duration = backupItem.duration || matchedTrack.duration;
        matchCount++;
      }
    });

    if (matchCount > 0) {
      renderPlaylist();
      saveTracksToDB();
      if (currentIdx !== -1) updateUI(currentIdx);
      showNotification(`Restored metadata for ${matchCount} matching tracks!`);
    } else {
      showNotification("Imported! Add matching audio files to apply this metadata.");
    }
  } catch (err) {
    console.error("Import error:", err);
    showNotification("Failed to parse playlist file");
  } finally {
    document.getElementById('import-input').value = '';
  }
}

// ── Full-Screen Drag & Drop Zone ──
let dragCounter = 0;

window.addEventListener('dragenter', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    dragCounter++;
    if (dragCounter === 1) {
      document.getElementById('drag-drop-zone').classList.add('active');
    }
  }
});

window.addEventListener('dragover', e => {
  e.preventDefault();
});

window.addEventListener('dragleave', e => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    dragCounter--;
    if (dragCounter === 0) {
      document.getElementById('drag-drop-zone').classList.remove('active');
    }
  }
});

window.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('drag-drop-zone').classList.remove('active');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    addFiles(e.dataTransfer.files);
  }
});
