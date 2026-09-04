// agent-baseline-esq.js — runs INSIDE the awareness container (shipped there
// base64-encoded by scripts/agent-baseline.sh). Reads a JSON array of
// {name, path, body} from the file named in argv[2], executes each request
// against ELASTICSEARCH_URL with an explicit Basic-auth header (Node fetch
// ignores inline URL credentials — see the 2026-06-13 ES-auth incident), and
// prints {name: parsedResponse} as one JSON document on stdout.
// Credentials never leave the container; only response bodies are printed.
const fs = require('fs');
const base = process.env.ELASTICSEARCH_URL;
if (!base) { console.error('ERR ELASTICSEARCH_URL unset'); process.exit(2); }
const u = new URL(base);
const auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');
const origin = u.protocol + '//' + u.host;
const queries = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const out = {};
  for (const q of queries) {
    const r = await fetch(origin + q.path, {
      method: q.body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: q.body ? JSON.stringify(q.body) : undefined,
    });
    const text = await r.text();
    try { out[q.name] = JSON.parse(text); } catch { out[q.name] = { _raw: text, _status: r.status }; }
  }
  process.stdout.write(JSON.stringify(out));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
