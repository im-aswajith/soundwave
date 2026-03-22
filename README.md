<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=200&section=header&text=Soundwave&fontSize=70&fontColor=fff&animation=twinkling&fontAlignY=35&desc=Stream%20Music%20From%20YouTube%20%E2%80%94%20No%20Ads.%20No%20Accounts.%20Just%20Vibes.&descAlignY=60&descSize=16" alt="Soundwave Banner"/>

<br/>

[![Stars](https://img.shields.io/github/stars/im-aswajith/soundwave?style=for-the-badge&logo=starship&color=a78bfa&labelColor=0d0d0d)](https://github.com/im-aswajith/soundwave/stargazers)
[![Forks](https://img.shields.io/github/forks/im-aswajith/soundwave?style=for-the-badge&logo=git&color=38bdf8&labelColor=0d0d0d)](https://github.com/im-aswajith/soundwave/network)
[![Issues](https://img.shields.io/github/issues/im-aswajith/soundwave?style=for-the-badge&logo=github&color=f472b6&labelColor=0d0d0d)](https://github.com/im-aswajith/soundwave/issues)
[![Python](https://img.shields.io/badge/Python-3.9%2B-a78bfa?style=for-the-badge&logo=python&logoColor=white&labelColor=0d0d0d)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-3.x-38bdf8?style=for-the-badge&logo=flask&logoColor=white&labelColor=0d0d0d)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/badge/License-MIT-f472b6?style=for-the-badge&labelColor=0d0d0d)](LICENSE)

<br/>

```
 ♪  ♫  ♩  ♬  ♪  ♫  ♩  ♬  ♪  ♫  ♩  ♬  ♪  ♫  ♩  ♬  ♪  ♫  ♩  ♬
```

> **Soundwave** is a sleek, full-featured web music player that streams audio  
> directly from YouTube — no API keys, no login, no subscriptions. Just search  
> and play, wrapped in a gorgeous animated UI.

<br/>

[✨ Features](#-features) · [🖼️ Screenshots](#%EF%B8%8F-screenshots) · [⚡ Quick Start](#-quick-start) · [🏗️ Architecture](#%EF%B8%8F-architecture) · [🤝 Contributing](#-contributing)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🎵 Playback
- **Multi-fallback audio engine** — tries yt-dlp direct, Flask proxy, Invidious, and Piped in sequence for maximum reliability
- **Seek support** with Range request proxying
- **Shuffle & Repeat** modes
- **Prev / Next** track navigation
- **4-minute stream URL caching** for snappy replays

</td>
<td width="50%">

### 🔍 Discovery
- **Instant YouTube search** — no API key required, scrapes `ytInitialData`
- **Trending feed** on home screen
- **Global search bar** with recent history & live suggestions
- **Time-aware greeting** (Morning / Afternoon / Evening)

</td>
</tr>
<tr>
<td width="50%">

### 💜 Library
- **Liked Songs** — persisted to `localStorage`
- **Queue view** — see what's playing next
- **Sidebar library** with liked song quick-launch
- **Keyboard shortcut** `L` to like the current track instantly

</td>
<td width="50%">

### 🎨 UI / UX
- **Animated particle canvas** background with connected-dot physics
- **Floating gradient orbs** in the background scene
- **Responsive** — full mobile layout with slide-out sidebar
- **Skeleton loaders** while content fetches
- **Toast notifications** for user actions

</td>
</tr>
</table>

---

## 🖼️ Screenshots

<div align="center">

| Home — Trending Feed | Now Playing | Queue & Library |
|:---:|:---:|:---:|
| *(animated orb bg + card grid)* | *(player bar with seek + controls)* | *(sidebar + liked songs)* |

> **Live demo screenshots coming soon** — run locally and see for yourself!

</div>

---

## ⚡ Quick Start

### Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.9 + |
| pip | latest |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | latest (auto-installed) |

### 1 — Clone & Install

```bash
# Clone the repository
git clone https://github.com/im-aswajith/soundwave.git
cd soundwave

# Install dependencies
pip install -r requirements.txt
```

> `requirements.txt` contains:
> ```
> flask
> yt-dlp
> ```

### 2 — Run

```bash
python app.py
```

### 3 — Open

```
http://localhost:5000
```

That's it. No `.env` files, no API keys, no database setup. 🎉

---

## 🏗️ Architecture

```
soundwave/
│
├── app.py                  # Flask backend — search, stream, proxy
├── requirements.txt
│
├── templates/
│   └── index.html          # Single-page app shell
│
└── static/
    ├── css/
    │   └── style.css       # Full design system (orbs, player, cards)
    └── js/
        └── app.js          # State machine, audio engine, UI logic
```

### How Streaming Works

```
Browser                Flask (app.py)              YouTube / CDN
   │                        │                           │
   │  GET /api/stream/:id   │                           │
   │ ─────────────────────► │                           │
   │                        │  yt-dlp (subprocess)      │
   │                        │ ──────────────────────────►
   │                        │◄── signed CDN URL ────────│
   │◄─── { url, mime } ─────│                           │
   │                        │                           │
   │  (if CORS fails)       │                           │
   │  GET /api/proxy/:id    │                           │
   │ ─────────────────────► │  Range-aware proxy        │
   │                        │ ──────────────────────────►
   │◄═══ chunked audio ═════│◄══════ audio bytes ═══════│
```

**Fallback chain** (client-side, in order):

1. `yt-dlp` direct CDN URL
2. `/api/proxy/:id` — Flask streams bytes (fixes CORS)
3. Invidious instance A
4. Invidious instance B
5. Piped API

If every strategy fails, an error is shown. The player **never auto-skips** — user intent is always respected.

---

## 🎛️ API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves the SPA |
| `/api/search?q=...` | GET | YouTube search → JSON `{ results: [...] }` |
| `/api/trending` | GET | Top music hits → JSON `{ results: [...] }` |
| `/api/stream/:video_id` | GET | Returns `{ url, content_type }` via yt-dlp |
| `/api/proxy/:video_id` | GET | Range-aware audio proxy (CORS bypass) |

### Result object shape

```jsonc
{
  "id":        "dQw4w9WgXcQ",
  "title":     "Never Gonna Give You Up",
  "channel":   "Rick Astley",
  "duration":  "3:32",
  "views":     "1.5B views",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
  "url":       "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `→` | Next track |
| `←` | Previous track |
| `L` | Like / Unlike current track |

---

## 🔧 Configuration

Soundwave works out of the box, but you can tweak these constants in `app.py`:

```python
# Stream URL cache lifetime (seconds)
CACHE_TTL = 240      # 4 minutes

# Default search result limit
RESULT_LIMIT = 24

# Request timeout for YouTube scraping
FETCH_TIMEOUT = 12   # seconds

# yt-dlp subprocess timeout
YTDLP_TIMEOUT = 25   # seconds
```

---

## 🛠️ Tech Stack

<div align="center">

| Layer | Technology |
|-------|-----------|
| **Backend** | Python · Flask |
| **Audio Extraction** | yt-dlp |
| **Search** | YouTube `ytInitialData` scraping (no API key) |
| **Frontend** | Vanilla JS · CSS3 |
| **Fonts** | Syne · DM Sans (Google Fonts) |
| **Storage** | `localStorage` (liked songs, search history) |
| **Animation** | Canvas API (particles) · CSS keyframes (orbs) |

</div>

---

### Good first issues
- 🎨 Custom theme / color scheme support
- 📱 PWA / install-to-homescreen support
- 🌐 Additional Invidious/Piped fallback instances
- 🔊 Volume memory across sessions

---

## ⚠️ Disclaimer

Soundwave is a personal project built for educational purposes. It does not store, redistribute, or host any audio files. All audio is streamed in real time directly from YouTube's CDN via publicly available URLs extracted by yt-dlp.

Please respect YouTube's [Terms of Service](https://www.youtube.com/t/terms) and your local copyright laws.

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for details.

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=100&section=footer&animation=twinkling" alt="footer wave"/>

**Made with 💜 and a lot of music**

⭐ If Soundwave made your day better, please consider starring the repo!

[![Star History Chart](https://img.shields.io/badge/Star%20History-View%20on%20GitHub-a78bfa?style=for-the-badge&logo=github&labelColor=0d0d0d)](https://github.com/im-aswajith/soundwave)

</div>
