const base = process.env.ELASTICSEARCH_URL;
const u = new URL(base);
const auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');
const origin = u.protocol + '//' + u.host;
const path = process.argv[2];
const body = process.argv[3];
(async () => {
  const r = await fetch(origin + path, {
    method: process.env.METHOD || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', authorization: auth },
    body: body || undefined,
  });
  console.log(await r.text());
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
