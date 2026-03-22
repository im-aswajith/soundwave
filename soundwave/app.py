from flask import Flask, render_template, jsonify, request, Response
import urllib.request
import urllib.parse
import json
import re
import subprocess
import threading
import time

app = Flask(__name__)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

_stream_cache = {}
_cache_lock = threading.Lock()


def fetch_url(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=12) as r:
        return r.read().decode('utf-8', errors='replace')


def extract_yt_initial_data(html):
    for pat in [
        r'var ytInitialData\s*=\s*({.+?});\s*</script>',
        r'ytInitialData\s*=\s*({.+?});\s*(?:var |window\[)',
    ]:
        m = re.search(pat, html, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:
                pass
    return None


def parse_videos_from_data(data, limit=24):
    videos = []
    try:
        contents = (
            data['contents']
            ['twoColumnSearchResultsRenderer']
            ['primaryContents']
            ['sectionListRenderer']
            ['contents']
        )
    except (KeyError, TypeError):
        return videos

    for section in contents:
        items = section.get('itemSectionRenderer', {}).get('contents', [])
        for item in items:
            vr = item.get('videoRenderer')
            if not vr:
                continue
            try:
                vid_id  = vr['videoId']
                title   = vr['title']['runs'][0]['text']
                channel = (vr.get('ownerText') or vr.get('shortBylineText') or {}) \
                            .get('runs', [{}])[0].get('text', 'Unknown')
                duration = vr.get('lengthText', {}).get('simpleText', '')
                views    = vr.get('viewCountText', {}).get('simpleText', '')

                is_live = vr.get('badges') and any(
                    b.get('metadataBadgeRenderer', {}).get('label') in ('LIVE', 'Live')
                    for b in vr.get('badges', [])
                )
                if is_live:
                    continue

                videos.append({
                    'id':        vid_id,
                    'title':     title,
                    'channel':   channel,
                    'duration':  duration,
                    'views':     views,
                    'thumbnail': f'https://i.ytimg.com/vi/{vid_id}/mqdefault.jpg',
                    'url':       f'https://www.youtube.com/watch?v={vid_id}',
                })
                if len(videos) >= limit:
                    break
            except (KeyError, IndexError, TypeError):
                continue
        if len(videos) >= limit:
            break
    return videos


def search_youtube(query, limit=24):
    q = urllib.parse.quote(query)
    url = f'https://www.youtube.com/results?search_query={q}&sp=EgIQAQ%3D%3D'
    try:
        html = fetch_url(url)
        data = extract_yt_initial_data(html)
        if data:
            return parse_videos_from_data(data, limit)
    except Exception as e:
        print(f'Search error: {e}')
    return []


def get_audio_stream_info(video_id):
    """
    Use yt-dlp to extract the best audio stream URL AND its content-type.
    Returns (url, content_type, error).
    Tries multiple format selectors as fallbacks.
    Results are cached for 4 minutes.
    """
    yt_url = f'https://www.youtube.com/watch?v={video_id}'

    with _cache_lock:
        cached = _stream_cache.get(video_id)
        if cached and cached.get('expires', 0) > time.time():
            return cached['url'], cached.get('content_type', 'audio/webm'), None

    format_selectors = [
        'bestaudio[ext=webm]',
        'bestaudio[ext=m4a]',
        'bestaudio[ext=opus]',
        'bestaudio',
        'worst[ext=mp4]',   # last resort: video with audio
        'worst',
    ]

    last_err = 'yt-dlp: no format worked'

    for fmt in format_selectors:
        try:
            result = subprocess.run(
                [
                    'yt-dlp',
                    '--no-playlist',
                    '--format', fmt,
                    '--print', '%(url)s\t%(ext)s',
                    '--no-warnings',
                    '--no-check-certificates',
                    yt_url,
                ],
                capture_output=True,
                text=True,
                timeout=25,
            )

            if result.returncode != 0:
                last_err = (result.stderr.strip() or f'yt-dlp exited {result.returncode}')[:200]
                continue

            line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ''
            if not line or '\t' not in line:
                last_err = f'Unexpected yt-dlp output for format {fmt}'
                continue

            stream_url, ext = line.split('\t', 1)
            ext = ext.strip().lower()

            mime_map = {
                'webm': 'audio/webm',
                'm4a':  'audio/mp4',
                'mp4':  'video/mp4',
                'opus': 'audio/ogg',
                'ogg':  'audio/ogg',
                'mp3':  'audio/mpeg',
            }
            content_type = mime_map.get(ext, 'audio/webm')

            with _cache_lock:
                _stream_cache[video_id] = {
                    'url': stream_url,
                    'content_type': content_type,
                    'expires': time.time() + 240,
                }

            return stream_url, content_type, None

        except FileNotFoundError:
            return None, None, 'yt-dlp is not installed on the server (pip install yt-dlp)'
        except subprocess.TimeoutExpired:
            last_err = f'yt-dlp timed out on format {fmt}'
            continue
        except Exception as e:
            last_err = str(e)
            continue

    return None, None, last_err


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/search')
def search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'error': 'No query', 'results': []})
    return jsonify({'results': search_youtube(q), 'query': q})


@app.route('/api/trending')
def trending():
    results = search_youtube('top music hits 2025', limit=24)
    return jsonify({'results': results})


@app.route('/api/stream/<video_id>')
def stream_info(video_id):
    """Returns JSON with direct stream URL from yt-dlp."""
    if not re.match(r'^[A-Za-z0-9_-]{11}$', video_id):
        return jsonify({'error': 'Invalid video ID'}), 400
    url, content_type, err = get_audio_stream_info(video_id)
    if err:
        return jsonify({'error': err}), 502
    return jsonify({'url': url, 'content_type': content_type, 'video_id': video_id})


@app.route('/api/proxy/<video_id>')
def proxy_audio(video_id):
    """
    Streams audio bytes through Flask — fixes CORS issues with signed YouTube CDN URLs.
    Supports Range requests for seeking.
    """
    if not re.match(r'^[A-Za-z0-9_-]{11}$', video_id):
        return jsonify({'error': 'Invalid video ID'}), 400

    stream_url, content_type, err = get_audio_stream_info(video_id)
    if err:
        return jsonify({'error': err}), 502

    range_header = request.headers.get('Range')
    req_headers = dict(HEADERS)
    if range_header:
        req_headers['Range'] = range_header

    try:
        upstream_req = urllib.request.Request(stream_url, headers=req_headers)
        upstream = urllib.request.urlopen(upstream_req, timeout=30)
        status = upstream.status
        resp_content_type = upstream.headers.get('Content-Type', content_type)
        content_range     = upstream.headers.get('Content-Range')
        content_length    = upstream.headers.get('Content-Length')

        def generate():
            try:
                while True:
                    chunk = upstream.read(65536)
                    if not chunk:
                        break
                    yield chunk
            finally:
                upstream.close()

        resp_headers = {
            'Content-Type':  resp_content_type,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
        }
        if content_range:
            resp_headers['Content-Range'] = content_range
        if content_length:
            resp_headers['Content-Length'] = content_length

        return Response(generate(), status=status, headers=resp_headers)

    except urllib.error.HTTPError as e:
        # Cached URL may have expired — clear cache and return error so client retries
        with _cache_lock:
            _stream_cache.pop(video_id, None)
        return jsonify({'error': f'Upstream HTTP {e.code}'}), 502
    except Exception as e:
        return jsonify({'error': str(e)}), 502


if __name__ == '__main__':
    app.run(debug=True, port=5000)
