// ASO Doctor API: runs free on Cloudflare Pages Functions. No keys needed.
const H = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; ASODoctor/1.0)', 'accept-language': 'en-US,en;q=0.9' };
const get = (u, extra = {}, ttl = 3600) =>
  fetch(u, { headers: { ...UA, ...extra }, cf: { cacheTtl: ttl, cacheEverything: true } });
const cc2 = (c) => (/^[a-z]{2}$/i.test(c || '') ? c.toLowerCase() : 'us');
const dec = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parseRef(q) {
  q = (q || '').trim();
  let m = q.match(/apps\.apple\.com\/(?:([a-z]{2})\/)?app\/(?:[^\/?#]*\/)?id(\d+)/i) || q.match(/apps\.apple\.com\/(?:([a-z]{2})\/)?app\/id(\d+)/i);
  if (m) return { store: 'ios', id: m[2], cc: m[1] };
  m = q.match(/^id?(\d{6,})$/i);
  if (m) return { store: 'ios', id: m[1] };
  m = q.match(/play\.google\.com\/store\/apps\/details\?[^\s]*?id=([A-Za-z0-9_.]+)/);
  if (m) return { store: 'play', pkg: m[1] };
  if (/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(q)) return { store: 'play', pkg: q };
  return { store: 'search', term: q };
}

function normIos(r, subtitle) {
  return {
    store: 'ios', id: String(r.trackId), name: r.trackName || '', subtitle: subtitle || '',
    developer: r.artistName || r.sellerName || '', category: r.primaryGenreName || '',
    description: r.description || '', icon: r.artworkUrl512 || r.artworkUrl100 || '',
    screenshots: [...(r.screenshotUrls || [])], ipadShots: (r.ipadScreenshotUrls || []).length,
    rating: r.averageUserRating ? +r.averageUserRating.toFixed(2) : 0, ratingCount: r.userRatingCount || 0,
    ratingCurrent: r.averageUserRatingForCurrentVersion ? +r.averageUserRatingForCurrentVersion.toFixed(2) : null,
    ratingCountCurrent: r.userRatingCountForCurrentVersion || 0,
    version: r.version || '', updated: r.currentVersionReleaseDate || '', released: r.releaseDate || '',
    releaseNotes: r.releaseNotes || '', languages: (r.languageCodesISO2A || []).length,
    price: r.price || 0, url: r.trackViewUrl || '', genres: r.genres || [],
  };
}

async function iosApp(id, cc) {
  const r = await get(`https://itunes.apple.com/lookup?id=${id}&country=${cc}`);
  const j = await r.json();
  if (!j.results || !j.results.length) throw new Error('App not found in this country store.');
  let subtitle = '';
  try { // iTunes API has no subtitle, so read it from the public app page (best effort)
    const p = await (await get(`https://apps.apple.com/${cc}/app/id${id}`)).text();
    const m = p.match(/product-header__subtitle[^>]*>\s*([^<]+?)\s*</) || p.match(/"subtitle":"([^"]+)"/);
    if (m) subtitle = dec(m[1]).trim();
  } catch (e) {}
  return normIos(j.results[0], subtitle);
}

async function playApp(pkg, cc) {
  const r = await get(`https://play.google.com/store/apps/details?id=${pkg}&hl=en&gl=${cc}`);
  if (r.status === 404) throw new Error('Package not found on Google Play.');
  const h = await r.text();
  let ld = {};
  const m = h.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { ld = JSON.parse(m[1]); } catch (e) {} }
  const shots = new Set();
  for (const x of h.matchAll(/<img[^>]+alt="Screenshot image"[^>]*?(?:src|data-src)="(https:\/\/play-lh\.googleusercontent\.com\/[^"\s]+)"/g)) shots.add(x[1]);
  const og = (h.match(/<meta property="og:title" content="([^"]+)"/) || [])[1];
  const ar = ld.aggregateRating || {};
  return {
    store: 'play', id: pkg, name: dec(ld.name || (og || '').replace(/ - Apps on Google Play$/, '')),
    subtitle: '', developer: dec((ld.author && ld.author.name) || ''), category: dec(ld.applicationCategory || ''),
    description: dec(ld.description || ''), icon: ld.image || '', screenshots: [...shots],
    ipadShots: 0, rating: +parseFloat(ar.ratingValue || 0).toFixed(2), ratingCount: +(ar.ratingCount || ar.reviewCount || 0),
    ratingCurrent: null, version: '', updated: '', releaseNotes: '', languages: 0, price: 0,
    url: `https://play.google.com/store/apps/details?id=${pkg}`, genres: [],
    note: 'Google Play data is best effort: update date, languages and short description are not available.',
  };
}

async function search(term, cc, limit = 12) {
  const r = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${cc}&entity=software&limit=${limit}`, {}, 1800);
  const j = await r.json();
  return (j.results || []).map((x) => normIos(x, ''));
}

async function suggest(term, cc, store) {
  if (store === 'play') {
    const r = await get(`https://market.android.com/suggest/SuggRequest?json=1&c=3&query=${encodeURIComponent(term)}&hl=en&gl=${cc}`, {}, 86400);
    const j = JSON.parse(await r.text());
    return j.filter((x) => x.s).map((x) => x.s);
  }
  const r = await get(`https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=${encodeURIComponent(term)}`,
    { 'X-Apple-Store-Front': '143441-1,29' }, 86400);
  const x = await r.text();
  return [...x.matchAll(/<key>term<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => dec(m[1]));
}

async function reviews(id, cc) {
  const r = await get(`https://itunes.apple.com/${cc}/rss/customerreviews/page=1/id=${id}/sortby=mostrecent/json`, {}, 1800);
  const j = await r.json();
  const e = (j.feed && j.feed.entry) || [];
  return (Array.isArray(e) ? e : [e]).filter((x) => x['im:rating']).map((x) => ({
    rating: +x['im:rating'].label, title: x.title.label, text: x.content.label,
    author: x.author.name.label, version: x['im:version'] ? x['im:version'].label : '',
  }));
}

async function rank(id, term, cc) {
  const r = await get(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${cc}&entity=software&limit=200`, {}, 3600);
  const j = await r.json();
  const i = (j.results || []).findIndex((x) => String(x.trackId) === String(id));
  return i < 0 ? null : i + 1;
}

async function onRequest({ request }) {
  const u = new URL(request.url);
  const p = u.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const q = u.searchParams, cc = cc2(q.get('cc'));
  try {
    if (p === 'app') {
      const ref = parseRef(q.get('q'));
      if (ref.store === 'ios') return J(await iosApp(ref.id, cc2(ref.cc || cc)));
      if (ref.store === 'play') return J(await playApp(ref.pkg, cc));
      if (!ref.term) return J({ error: 'Paste an app link or type an app name.' }, 400);
      const c = await search(ref.term, cc, 6);
      return J({ candidates: c.map((a) => ({ id: a.id, name: a.name, developer: a.developer, icon: a.icon, rating: a.rating, ratingCount: a.ratingCount })) });
    }
    if (p === 'search') return J({ results: await search(q.get('term') || '', cc, +q.get('limit') || 12) });
    if (p === 'suggest') return J({ terms: await suggest(q.get('term') || '', cc, q.get('store')) });
    if (p === 'reviews') return J({ reviews: await reviews(q.get('id'), cc) });
    if (p === 'rank') return J({ rank: await rank(q.get('id'), q.get('term') || '', cc) });
    return J({ error: 'Unknown endpoint' }, 404);
  } catch (e) {
    return J({ error: e.message || 'Upstream error' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p.startsWith('/api/')) return onRequest({ request });
    return env.ASSETS.fetch(request);
  },
};
