# Runbook: GHCR pull `denied` — the shared host credential

**TL;DR:** all Coolify apps on the host share **one** `/root/.docker/config.json`. If anything writes an *ephemeral* token into it (notably GitHub Actions' `secrets.GITHUB_TOKEN`, which is a `ghs_` token that expires in ~1 hour), every other app's next image pull fails with `Error response from daemon: denied`. The durable fix is to make sure **only a non-expiring `read:packages` PAT** is ever written there.

## Symptom

- A Coolify deploy (ll5-agent / ll5-run, claude-box, or the ll5 main stack) fails with:
  ```
  <service> Pulling
  <service> Error denied
  Error response from daemon: denied
  exit status 1
  ```
- Already-running containers keep working (they use cached images), so the breakage is invisible until the *next* fresh pull — which makes it look intermittent/random.
- It **recurs** after every manual fix. That recurrence is the signature of this bug (vs. a one-off expired PAT).

## Root cause

1. The host has a single shared Docker auth file: `/root/.docker/config.json`. Coolify's `docker compose pull` reads it as-is.
2. Multiple deploy paths write to it. The dangerous writer is any CI step that SSHes to the host and runs `docker login ghcr.io` with **`secrets.GITHUB_TOKEN`** — that's a GitHub Actions installation token (`ghs_…`, ~426 chars) with a **1-hour lifetime**.
3. So each such deploy overwrites the shared credential with a token that dies an hour later. The next app to pull after expiry gets `denied`.
4. Manual `docker login` with a real PAT works — but only until the next offending deploy clobbers the file again. Hence the recurrence.

Historical instance: `ll5/.github/workflows/build-and-push.yml` "Deploy to server" step used `GHCR_TOKEN: secrets.GITHUB_TOKEN`. Fixed 2026-05-22 (commit 493bbc9) to `secrets.GHCR_READ_PAT`. `ll5-run`'s workflow was already clean (its deploy job only calls the Coolify deploy API; it does not log in on the host).

## Durable fix (already applied — keep it this way)

Every CI step that logs into GHCR **on the host** must use the non-expiring PAT, never `GITHUB_TOKEN`:

```yaml
      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        env:
          GHCR_TOKEN: ${{ secrets.GHCR_READ_PAT }}   # NOT secrets.GITHUB_TOKEN
        with:
          script: |
            echo "$GHCR_TOKEN" | docker login ghcr.io -u arnonzamir --password-stdin
```

`secrets.GITHUB_TOKEN` is fine for the **in-runner** `docker/login-action` push step (it never touches the host) — only the host SSH login is the problem.

### The PAT itself

- Must be a classic PAT scoped **`read:packages`** with **No expiration**. `read:packages` covers all of the user's private packages, so one PAT serves every current and future image.
- Stored as the GitHub Actions secret **`GHCR_READ_PAT`** in the `ll5` repo (and any other repo whose CI logs into the host).
- If it's ever (re)created with an expiry, this whole outage returns the day it lapses. Verify it shows "Never" in GitHub → Settings → Developer settings → Tokens.

## Emergency recovery (host is `denied` right now)

```bash
ssh -i ~/.ssh/id_ed25519 root@95.216.23.208
printf '%s' '<non-expiring read:packages PAT>' | docker login ghcr.io -u arnonzamir --password-stdin
docker pull ghcr.io/arnonzamir/ll5-agent:latest   # confirm it works
```

Then re-trigger the failed deploy (Coolify UI, or `GET /api/v1/deploy?uuid=<app-uuid>&force=true` with the Coolify API token). After the durable fix this should be needed rarely — only if a not-yet-fixed CI path clobbers the file.

## Diagnostics

Identify what kind of token is currently on the host (do **not** print the secret):

```bash
python3 -c "
import json,base64
d=json.load(open('/root/.docker/config.json'))
tok=base64.b64decode(d['auths']['ghcr.io']['auth']).decode().split(':',1)[1]
print('prefix=', tok[:4], ' len=', len(tok))
"
# ghp_ / github_pat_  => a PAT (good).   ghs_ (len ~426) => ephemeral Actions/App token (bad: will expire).
```

Test whether a PAT can pull before logging in with it:

```bash
BASIC=$(printf 'arnonzamir:%s' "$PAT" | base64 -w0)
curl -s -H "Authorization: Basic $BASIC" \
  "https://ghcr.io/token?scope=repository:arnonzamir/ll5-agent:pull&service=ghcr.io" \
  | python3 -c "import sys,json;print('ok' if json.load(sys.stdin).get('token') else 'FAIL')"
```

## Related

- `docs/HANDOFF.md` → CI/Deploy section (GHCR credential note).
- Separate but adjacent Coolify gotcha: persistent storage must use the Storages feature; `-v` in `custom_docker_run_options` is silently stripped.
