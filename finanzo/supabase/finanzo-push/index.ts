// Finanzo – Mitteilungen verschicken (Supabase Edge Function „finanzo-push“)
//
// Die Funktion speichert nichts und kennt kein Passwort. Die Datenbank ruft sie jede Minute auf
// und sagt ihr, welche Mitteilungen raus müssen. Sie verschlüsselt jede Mitteilung (Web Push,
// RFC 8291 + VAPID) und gibt sie an Apple, Google, Mozilla oder Microsoft weiter.
//
// Aktionen (POST, JSON):
//   {"action":"keys"}                                → neues Schlüsselpaar (die Datenbank merkt es sich)
//   {"action":"send","jwk":{…},"messages":[…]}        → Mitteilungen verschicken
// GET zeigt nur {"ok":true}, damit man im Browser sehen kann, dass die Funktion läuft.

const SB_URL = 'https://tmdagajpcdpeurqpmdih.supabase.co';
const SB_KEY = 'sb_publishable_axlpCxXqN9xRxIck6pZSyg_LrlvVdGy'; // öffentlicher Schlüssel, steht auch in der App
const CONTACT = 'https://enricomtz.github.io/finanzo/';
const TTL = 12 * 3600; // so lange versucht der Dienst zuzustellen, wenn das Handy aus ist

type Jwk = { kty?: string; crv?: string; x: string; y: string; d: string };
type Msg = { endpoint: string; p256dh: string; auth: string; title?: string; body?: string; tag?: string; url?: string };

const enc = new TextEncoder();

export function b64u(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s: string): Uint8Array {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// Inhalt verschlüsseln (RFC 8291, „aes128gcm“). salt und asPair nur für Tests.
export async function encrypt(plain: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)), asPair?: CryptoKeyPair): Promise<Uint8Array> {
  const pair = asPair ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, pair.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, ct);
}

const publicOf = (jwk: Jwk) => b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y)));

// Anmeldung beim Zustelldienst (VAPID, RFC 8292)
export async function vapid(endpoint: string, jwk: Jwk): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 6 * 3600, sub: CONTACT })));
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicOf(jwk)}`;
}

// Nur an echte Zustelldienste schicken
const HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com'];
const okHost = (h: string) => HOSTS.includes(h) || h.endsWith('.push.apple.com') || h.endsWith('.notify.windows.com') || h.endsWith('.push.services.mozilla.com');

async function sendOne(m: Msg, jwk: Jwk): Promise<number> {
  let url: URL;
  try { url = new URL(m.endpoint); } catch { return 400; }
  if (url.protocol !== 'https:' || !okHost(url.hostname)) return 400;
  try {
    const payload = enc.encode(JSON.stringify({ title: String(m.title || 'Finanzo'), body: String(m.body || ''), tag: m.tag || '', url: m.url || '' }));
    const body = await encrypt(payload, unb64u(m.p256dh), unb64u(m.auth));
    const res = await fetch(m.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapid(m.endpoint, jwk),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL),
        Urgency: 'high',
      },
      body,
    });
    try { await res.body?.cancel(); } catch { /* egal */ }
    return res.status;
  } catch {
    return 0; // Netzwerkfehler: beim nächsten Mal klappt es vielleicht
  }
}

// Nur die eigene Datenbank darf verschicken: ihr öffentlicher Schlüssel muss passen
let known = '';
async function trusted(jwk: Jwk): Promise<boolean> {
  let mine = '';
  try { mine = publicOf(jwk); } catch { return false; }
  if (known && mine === known) return true;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/push_public_key`, {
      method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!r.ok) return false;
    const k = await r.json();
    known = typeof k === 'string' ? k : '';
  } catch { return false; }
  return !!known && mine === known;
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

export async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: true, name: 'finanzo-push' });
  let b: { action?: string; jwk?: Jwk; messages?: Msg[] };
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (b.action === 'keys') {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const j = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
    const jwk: Jwk = { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d! };
    return json({ publicKey: publicOf(jwk), jwk });
  }
  if (b.action === 'send') {
    if (!b.jwk || !(await trusted(b.jwk))) return json({ error: 'unknown key' }, 403);
    const list = Array.isArray(b.messages) ? b.messages.slice(0, 500) : [];
    const results = await Promise.all(list.map(async (m) => ({ endpoint: m && m.endpoint, status: m ? await sendOne(m, b.jwk!) : 400 })));
    return json({ results });
  }
  return json({ error: 'unknown action' }, 400);
}

Deno.serve(handle);
