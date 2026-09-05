#!/usr/bin/env node
// compose-lint — the env each MCP's code reads must be present in its compose
// service (DECISION-029, 2026-09-05). Born from ISS-028: the messaging service
// had no ELASTICSEARCH_URL, so initAudit('') silently disabled its audit rows
// and nothing noticed for months. Runs in CI before any build.
//
// Rule: for every compose service whose image is ghcr.io/arnonzamir/ll5-<pkg>,
// every REQUIRED_ENV name that appears as `process.env.<NAME>` in packages/<pkg>/src
// (or in packages/shared/src when the package imports the module that reads it)
// must be a key under that service's `environment:`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPOSE = path.join(ROOT, 'docker/docker-compose.prod.yml');

// Env vars whose absence is silent at runtime (the code degrades instead of failing).
const REQUIRED_ENV = ['ELASTICSEARCH_URL', 'DATABASE_URL', 'AUTH_SECRET', 'ENCRYPTION_KEY'];
// Shared modules that read an env var on behalf of the importing package.
const SHARED_READERS = { ELASTICSEARCH_URL: ['initAudit', 'initAppLog'] };

/** Minimal parser for our compose file: service -> { image, env: Set } (2-space map form). */
function parseCompose(text) {
  const services = {};
  let inServices = false, svc = null, inEnv = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) { inServices = line.startsWith('services:'); svc = null; continue; }
    if (!inServices) continue;
    if (indent === 2 && line.trim().endsWith(':')) { svc = line.trim().slice(0, -1); services[svc] = { image: null, env: new Set() }; inEnv = false; continue; }
    if (!svc) continue;
    if (indent === 4) {
      inEnv = line.trim() === 'environment:';
      const m = line.trim().match(/^image:\s*(\S+)/);
      if (m) services[svc].image = m[1];
      continue;
    }
    if (inEnv && indent === 6) {
      const m = line.trim().match(/^([A-Z0-9_]+):/) ?? line.trim().match(/^-\s*([A-Z0-9_]+)=/);
      if (m) services[svc].env.add(m[1]);
    }
  }
  return services;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === 'node_modules' || f === '__tests__' || f === 'dist') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(f) && !/\.test\./.test(f)) out.push(p);
  }
  return out;
}

function envUsedBy(pkg) {
  const src = path.join(ROOT, 'packages', pkg, 'src');
  let files;
  try { files = walk(src); } catch { return new Set(); }
  const code = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const used = new Set();
  for (const name of REQUIRED_ENV) {
    if (code.includes(`process.env.${name}`)) used.add(name);
    for (const fn of SHARED_READERS[name] ?? []) if (code.includes(`${fn}(`)) used.add(name);
  }
  return used;
}

const services = parseCompose(readFileSync(COMPOSE, 'utf8'));
const problems = [];
let checked = 0;
for (const [name, s] of Object.entries(services)) {
  const m = s.image?.match(/ghcr\.io\/arnonzamir\/ll5-([a-z0-9-]+)/);
  if (!m) continue;
  const pkg = m[1];
  const used = envUsedBy(pkg);
  if (!used.size) continue;
  checked++;
  for (const v of used) if (!s.env.has(v)) problems.push(`service "${name}" (packages/${pkg}) reads ${v} but compose does not set it`);
}
if (!checked) { console.error('compose-lint: no ll5 services matched — parser or layout changed?'); process.exit(2); }
if (problems.length) {
  console.error(`compose-lint: ${problems.length} problem(s)\n  - ` + problems.join('\n  - '));
  process.exit(1);
}
console.log(`compose-lint: ${checked} services OK (${REQUIRED_ENV.join(', ')})`);
