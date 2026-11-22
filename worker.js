/*
 * Cloudflare Worker: простой CORS-прокси для импорта чартов по ссылке.
 * Deploy: fnf2osu-fetch (https://fnf2osu-fetch.<account>.workers.dev)
 * Секретов и биндингов нет.
 */
const ALLOW = [
  'gamebanana.com', 'www.gamebanana.com', 'api.gamebanana.com',
  'github.com', 'api.github.com', 'raw.githubusercontent.com',
  'gist.githubusercontent.com', 'codeload.github.com'
];
const ALLOW_SUFFIX = ['.gamebanana.com', '.githubusercontent.com'];

function allowed(host) {
  const h = host.toLowerCase();
  return ALLOW.includes(h) || ALLOW_SUFFIX.some(s => h.endsWith(s));
}

const OK_ORIGINS = [
  'https://fnf2osu-converter.pages.dev',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  'null'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Disposition'
};

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!OK_ORIGINS.includes(origin)) return new Response('Origin not allowed', { status: 403, headers: CORS });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400, headers: CORS });

    let dest;
    try { dest = new URL(target); } catch (e) { return new Response('Bad url', { status: 400, headers: CORS }); }
    if (dest.protocol !== 'http:' && dest.protocol !== 'https:') return new Response('Bad scheme', { status: 400, headers: CORS });
    if (!allowed(dest.hostname)) return new Response('Host not allowed', { status: 403, headers: CORS });

    try {
      const res = await fetch(dest.toString(), {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'Accept': '*/*'
        }
      });
      const headers = new Headers(CORS);
      const ct = res.headers.get('Content-Type');
      if (ct) headers.set('Content-Type', ct);
      const cd = res.headers.get('Content-Disposition');
      if (cd) headers.set('Content-Disposition', cd);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      return new Response('Fetch failed: ' + (e && e.message || e), { status: 502, headers: CORS });
    }
  }
};
