---
name: doc-audit
description: Audit living docs against actual codebase — find stale counts, outdated status, missing features
---

# Documentation Audit

Verify that PROGRESS.md, HANDOFF.md, FILE_TREE.md, ROADMAP.md, and memory files match reality. Run this at the end of a session or when things feel stale.

## Step 1: Count verification

Run these commands and compare against any numbers still in docs:

```bash
# MCP tools per package
for pkg in personal-knowledge gtd awareness google messaging health; do
  echo "$pkg: $(grep -r 'server\.tool(' packages/$pkg/src/tools/ | wc -l | tr -d ' ')"
done

# Channel MCP tools
grep "name: '" ~/workspace/ll5-run/channel/ll5-channel.mjs | wc -l

# Dashboard pages
find packages/dashboard/src/app -name "page.tsx" | wc -l

# Gateway schedulers
ls packages/gateway/src/scheduler/*.ts | wc -l

# Skills
ls ~/workspace/ll5-run/.claude/skills/*.md | wc -l

# Gateway migrations
ls packages/gateway/src/migrations/*.sql | wc -l
```

If PROGRESS.md has a "Last audited" line, update the date and numbers.

## Step 2: Service status

Check what's actually running vs what docs say:

```bash
ssh -i ~/.ssh/id_ed25519 root@95.216.23.208 "docker ps --format '{{.Names}} | {{.Status}}' | grep -E 'll5|gateway|dashboard|postgres|elastic' | sort"
```

Compare against PROGRESS.md service table. Flag any discrepancies.

## Step 3: ROADMAP.md status check

For each item in ROADMAP.md marked as not done:
- Grep the codebase for key terms. Is it actually built?
- If built, mark it done with date.

For each item marked done:
- Verify it's also in PROGRESS.md "Done" table.

## Step 4: Memory files

Read `~/.claude/projects/-Users-arnon-workspace-ll5/memory/MEMORY.md`. For each entry:
- If marked "DONE" — is it really done? Spot check.
- If marked as roadmap — is it still accurate?
- If description says "not yet started" — check if it was built since.

Flag stale entries. Update or remove them.

## Step 5: HANDOFF.md freshness

Scan HANDOFF.md for:
- Services listed as "not deployed" that are actually live
- Missing new features (compare recent git log against what's documented)
- Stale "Key Lessons Learned" that are no longer relevant

## Step 6: Report

Summarize findings:
- What was stale and fixed
- What's still accurate
- Any new features that need documentation

Don't create new design docs unless asked — just fix the living docs.
