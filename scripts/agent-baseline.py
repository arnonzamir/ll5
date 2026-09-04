#!/usr/bin/env python3
"""Aggregation logic for scripts/agent-baseline.sh.

Two sub-commands, both pure (no network):

  queries --since D --until D --user U
      prints the JSON array of {name, path, body} Elasticsearch requests the
      driver ships into the awareness container, plus the SQL the driver runs
      in the postgres container (with --sql).

  render  --since D --until D --user U --es es.json --pg pg.txt [--baseline MD]
      turns the raw responses into the Markdown baseline document with the same
      rows as docs/reviews/2026-09-04/agent-baseline.md and a final
      "Delta vs frozen baseline" section.

Window semantics: --since/--until are inclusive calendar days (UTC), matching
the frozen table ("2026-08-21 -> 2026-09-04 (15 days)").
"""
import argparse
import datetime as dt
import json
import re
import statistics
import sys

HOUSEKEEPING = [
    "list_narratives", "write_journal", "recall_lessons", "list_narrative_work",
    "list_reconcile_work", "resolve_journal", "recall_everything", "read_journal",
    "list_lessons",
]
RITUALS = [("Morning brief", "morning brief"), ("evening close", "evening close"),
           ("nightly consolidation", "consolidation")]
TOP_TOOLS = 10


# --------------------------------------------------------------------------- window
def parse_day(s):
    return dt.date.fromisoformat(s)


def window(since, until):
    a = parse_day(since)
    b = parse_day(until)
    if b < a:
        sys.exit(f"--until {until} is before --since {since}")
    return a, b, (b - a).days + 1


def rng(field, a, b):
    return {"range": {field: {"gte": f"{a.isoformat()}T00:00:00Z",
                              "lt": f"{(b + dt.timedelta(days=1)).isoformat()}T00:00:00Z"}}}


def hist(field):
    return {"date_histogram": {"field": field, "calendar_interval": "day",
                               "min_doc_count": 0, "time_zone": "UTC"}}


# --------------------------------------------------------------------------- queries
def build_queries(since, until, user):
    a, b, _ = window(since, until)
    uid = {"term": {"user_id": user}}
    uid_kw = {"term": {"user_id.keyword": user}}

    def q(name, index, body):
        body.setdefault("track_total_hits", True)  # hits.total is capped at 10,000 otherwise
        return {"name": name, "path": f"/{index}/_search", "body": body}

    def filt(time_field, *extra, user_clause=uid):
        return {"bool": {"filter": [user_clause, rng(time_field, a, b), *extra]}}

    J, E, A, C, T, S, O, N = ("ll5_agent_journal", "ll5_eval_moments", "ll5_audit_log",
                              "ll5_chat_messages", "ll5_turn_costs", "ll5_session_history",
                              "ll5_knowledge_observations", "ll5_knowledge_narratives")
    trailing = max(a, b - dt.timedelta(days=6))  # last 7 days of the window (frozen row used 7d)

    queries = [
        # chat: every non-system message in the window, oldest first
        q("chat", C, {"size": 10000, "sort": [{"created_at": "asc"}],
                      "_source": ["role", "channel", "direction", "created_at"],
                      "query": filt("created_at", {"terms": {"role": ["user", "assistant"]}},
                                    {"bool": {"must_not": {"term": {"channel": "system"}}}})}),
        # rituals: day-histogram per phrase
        *[q(f"ritual:{key}", J, {"size": 0, "query": filt("created_at", {"match_phrase": {"content": phrase}}),
                                 "aggs": {"days": hist("created_at")}}) for key, phrase in RITUALS],
        # eval moments
        q("eval", E, {"size": 0, "query": filt("timestamp"), "aggs": {
            "decision": {"terms": {"field": "decision", "size": 10}},
            "claimed": {"terms": {"field": "decision_claimed", "size": 10},
                        "aggs": {"actual": {"terms": {"field": "decision", "size": 10}}}},
            "mismatch": {"filter": {"term": {"decision_mismatch": True}},
                         "aggs": {"claimed": {"terms": {"field": "decision_claimed", "size": 10},
                                              "aggs": {"actual": {"terms": {"field": "decision", "size": 10}}}}}},
            "ping_now": {"filter": {"term": {"decision": "ping_now"}},
                         "aggs": {"zero_grounding": {"filter": {"term": {"grounding_calls": 0}}}}},
            "close_sum": {"sum": {"field": "close_count"}},
            "pencil_sum": {"sum": {"field": "pencil_count"}},
        }}),
        # durable knowledge + all tool calls (audit log)
        q("audit", A, {"size": 0, "query": filt("timestamp"), "aggs": {
            "tools": {"terms": {"field": "tool_name", "size": 200}},
            "note_observation_days": {"filter": {"term": {"tool_name": "note_observation"}},
                                      "aggs": {"days": hist("timestamp")}},
            "consolidate_days": {"filter": {"terms": {"tool_name": ["consolidate_narrative"]}},
                                 "aggs": {"days": hist("timestamp")}},
        }}),
        q("observations", O, {"size": 0, "query": filt("created_at"), "aggs": {"days": hist("created_at")}}),
        # narratives: current state (not windowed)
        q("narratives", N, {"size": 0, "query": {"bool": {"filter": [uid]}},
                            "aggs": {"status": {"terms": {"field": "status", "size": 10}},
                                     "consolidated_days": {"filter": rng("last_consolidated_at", a, b)}}}),
        # journal
        q("journal", J, {"size": 0, "query": filt("created_at"), "aggs": {
            "freshness": {"filter": {"term": {"topic.keyword": "Narrative freshness"}}},
            "context_open": {"filter": {"bool": {"filter": [{"term": {"type": "context"}}, {"term": {"status": "open"}}]}}},
            "context_open_7d": {"filter": {"bool": {"filter": [{"term": {"type": "context"}}, {"term": {"status": "open"}},
                                                               rng("created_at", trailing, b)]}}},
            "restart_days": {"filter": {"term": {"topic.keyword": "session-restart"}},
                             "aggs": {"days": hist("created_at")}},
        }}),
        q("tally", J, {"size": 200, "sort": [{"created_at": "asc"}], "_source": ["created_at", "content"],
                       "query": filt("created_at", {"match_phrase": {"content": "CONSOLIDATE-TALLY"}})}),
        # turn costs
        q("costs", T, {"size": 0, "query": filt("timestamp", user_clause=uid_kw), "aggs": {
            "cost": {"sum": {"field": "cost_usd"}},
            "cached_pct": {"percentiles": {"field": "cached_tokens", "percents": [50]}},
            "cached_max": {"max": {"field": "cached_tokens"}},
            "last": {"max": {"field": "timestamp"}},
        }}),
        # session history
        q("sessions", S, {"size": 0, "query": filt("indexed_at", user_clause=uid_kw), "aggs": {
            "sessions": {"cardinality": {"field": "session_id"}},
            "newest": {"max": {"field": "indexed_at"}},
        }}),
        q("sessions_all", S, {"size": 0, "query": {"bool": {"filter": [uid_kw]}},
                              "aggs": {"newest": {"max": {"field": "indexed_at"}}}}),
    ]
    return queries


def build_sql(since, until, user):
    a, b, _ = window(since, until)
    lo, hi = f"{a.isoformat()}T00:00:00Z", f"{(b + dt.timedelta(days=1)).isoformat()}T00:00:00Z"
    u = user.replace("'", "''")
    return "\n".join([
        "\\pset format unaligned", "\\pset fieldsep '|'", "\\pset tuples_only on",
        f"select 'open', count(*) from gtd_horizons where user_id='{u}' and horizon=0 and status='active';",
        f"select 'overdue', count(*) from gtd_horizons where user_id='{u}' and horizon=0 and status='active' and due_date < current_date;",
        f"select 'inbox:'||status, count(*) from gtd_inbox where user_id='{u}' group by status;",
        f"select 'habit:'||coalesce(outcome,'pending'), count(*) from gtd_habit_log where user_id='{u}' and created_at >= '{lo}' and created_at < '{hi}' group by outcome;",
    ]) + "\n"


# --------------------------------------------------------------------------- helpers
def n(x):
    return f"{int(round(x)):,}"


def pct(part, whole):
    return "n/a" if not whole else f"{100.0 * part / whole:.1f}%"


def buckets(agg, key="key"):
    return {bk[key]: bk["doc_count"] for bk in agg.get("buckets", [])}


def day_buckets(agg):
    return {bk["key_as_string"][:10]: bk["doc_count"] for bk in agg.get("buckets", [])}


def guard(es, name):
    r = es.get(name)
    if r is None:
        sys.exit(f"missing ES response: {name}")
    if "error" in r:
        sys.exit(f"ES error in {name}: {json.dumps(r['error'])[:400]}")
    return r


def parse_ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def nearest_rank(count, p):
    """Nearest-rank percentile index: ceil(p*n)-th smallest, 0-based."""
    return max(0, min(count - 1, -(-int(p * count * 1000) // 1000) - 1))


def fmt_secs(s):
    return f"{s:.0f} s" if s < 600 else f"{s / 60:.0f} min"


def days_with_hits(d):
    return sum(1 for v in d.values() if v > 0)


def parse_tally(text):
    """'CONSOLIDATE-TALLY observations:12 lessons=3 ...' -> {'observations': 12, ...}"""
    out = {}
    tail = text.split("CONSOLIDATE-TALLY", 1)[1]
    for k, v in re.findall(r"([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(-?\d+)", tail):
        out[k] = out.get(k, 0) + int(v)
    return out


# --------------------------------------------------------------------------- render
def compute(since, until, user, es, pg_text):
    a, b, ndays = window(since, until)
    rows = []  # (area, measurement, issue)

    # --- chat
    hits = [h["_source"] for h in guard(es, "chat")["hits"]["hits"]]
    users = [h for h in hits if h["role"] == "user"]
    assistants = [h for h in hits if h["role"] == "assistant"]
    latencies, answered = [], 0
    for i, h in enumerate(hits):
        if h["role"] != "user":
            continue
        nxt = next((x for x in hits[i + 1:] if x["role"] == "assistant"), None)
        if nxt:
            answered += 1
            latencies.append((parse_ts(nxt["created_at"]) - parse_ts(h["created_at"])).total_seconds())
    if latencies:
        ls = sorted(latencies)
        p50, p90, mx = statistics.median(ls), ls[nearest_rank(len(ls), 0.9)], ls[-1]
        lat = f"Latency p50 {fmt_secs(p50)} / p90 {fmt_secs(p90)} / max {fmt_secs(mx)}"
    else:
        lat = "Latency n/a"
    ratio = f"{len(assistants) / len(users):.1f}:1" if users else "n/a"
    rows.append(("Chat", f"{len(users)} user messages, {answered} answered. {lat}. "
                         f"{len(assistants)} assistant outbound ({ratio} agent:user)", "—"))

    # --- rituals
    parts = []
    for key, _ in RITUALS:
        d = day_buckets(guard(es, f"ritual:{key}")["aggregations"]["days"])
        parts.append(f"{key} {days_with_hits(d)}/{ndays} days" if key == RITUALS[0][0]
                     else f"{key} {days_with_hits(d)}/{ndays}")
    rows.append(("Rituals", ", ".join(parts), "—"))

    # --- eval moments
    ev = guard(es, "eval")
    total = ev["hits"]["total"]["value"]
    ag = ev["aggregations"]
    dec = buckets(ag["decision"])
    mism = ag["mismatch"]["doc_count"]
    rows.append(("Eval moments", f"{n(total)} — suppress {n(dec.get('suppress', 0))} / ping_now {n(dec.get('ping_now', 0))} / "
                                 f"ping_later {n(dec.get('ping_later', 0))}; mismatch {n(mism)} ({pct(mism, total)})", "ISS-001"))
    shape = {}
    for ck in ag["mismatch"]["claimed"]["buckets"]:
        for ak in ck["actual"]["buckets"]:
            shape[(ck["key"], ak["key"])] = ak["doc_count"]
    claimed = {ck["key"]: ck["doc_count"] for ck in ag["claimed"]["buckets"]}
    hollow = shape.get(("ping_later", "suppress"), 0)
    claimed_later = claimed.get("ping_later", 0)
    rows.append(("Mismatch shape", f"claimed `suppress` → actual `ping_now` {shape.get(('suppress', 'ping_now'), 0)}; "
                                   f"claimed `ping_later` → actual `suppress` {hollow} "
                                   f"({pct(hollow, claimed_later).rstrip('%')}% of {claimed_later} claimed ping_laters hollow)",
                 "ISS-001, 004"))
    pn = ag["ping_now"]["doc_count"]
    zg = ag["ping_now"]["zero_grounding"]["doc_count"]
    rows.append(("Grounding", f"{zg}/{pn} ping_now with `grounding_calls:0` ({pct(zg, pn)})", "ISS-001"))
    rows.append(("Follow-through", f"`close_count` sum {n(ag['close_sum']['value'])}, `pencil_count` sum {n(ag['pencil_sum']['value'])}",
                 "ISS-004"))

    # --- durable knowledge / tool calls
    au = guard(es, "audit")
    tools = buckets(au["aggregations"]["tools"])
    obs_days = day_buckets(au["aggregations"]["note_observation_days"]["days"])
    zero_days = [d for d, v in obs_days.items() if v == 0]
    obs_idx = guard(es, "observations")["hits"]["total"]["value"]
    per_day = ", ".join(f"{d[5:]}:{v}" for d, v in sorted(obs_days.items()))
    rows.append(("Durable knowledge", f"`note_observation` {tools.get('note_observation', 0)} "
                                      f"({len(zero_days)} zero-days of {ndays}), `upsert_fact` {tools.get('upsert_fact', 0)}, "
                                      f"`upsert_person` {tools.get('upsert_person', 0)}; observations index +{n(obs_idx)}; "
                                      f"note_observation/day: {per_day}", "ISS-002"))

    # --- narratives
    na = guard(es, "narratives")["aggregations"]
    st = buckets(na["status"])
    cons_days = day_buckets(au["aggregations"]["consolidate_days"]["days"])
    fired = [d[5:] for d, v in sorted(cons_days.items()) if v > 0]
    rows.append(("Narratives", f"{st.get('active', 0)} active / {st.get('dormant', 0)} dormant / {st.get('closed', 0)} closed; "
                               f"`consolidate_narrative` {tools.get('consolidate_narrative', 0)} calls on {len(fired)} days "
                               f"({', '.join(fired) or 'none'}); `last_consolidated_at` in window {na['consolidated_days']['doc_count']}",
                 "ISS-003"))

    # --- journal
    jo = guard(es, "journal")
    jag = jo["aggregations"]
    restart_days = day_buckets(jag["restart_days"]["days"])
    restart_str = ", ".join(f"{d[5:]}:{v}" for d, v in sorted(restart_days.items()) if v > 0) or "none"
    rows.append(("Journal", f"{n(jo['hits']['total']['value'])} entries; {n(jag['freshness']['doc_count'])} \"Narrative freshness\" heartbeat; "
                            f"{n(jag['context_open']['doc_count'])} `context` still `open` in the window "
                            f"({n(jag['context_open_7d']['doc_count'])} in the last 7 days)", "ISS-011"))
    rows.append(("Session restarts (journal)", f"`session-restart` entries/day: {restart_str} "
                                               f"(total {sum(restart_days.values())})", "ISS-016"))
    tal = guard(es, "tally")["hits"]["hits"]
    sums = {}
    for h in tal:
        for k, v in parse_tally(h["_source"]["content"]).items():
            sums[k] = sums.get(k, 0) + v
    tally_str = (f"{len(tal)} lines; " + ", ".join(f"{k} {v}" for k, v in sorted(sums.items()))) if tal else "0 lines found"
    rows.append(("CONSOLIDATE-TALLY", tally_str, "ISS-002"))

    # --- tool calls
    total_calls = au["hits"]["total"]["value"]
    hk = sum(tools.get(t, 0) for t in HOUSEKEEPING)
    top = sorted(tools.items(), key=lambda kv: -kv[1])[:TOP_TOOLS]
    rows.append(("Tool calls (audit_log)", f"{n(total_calls)} total; {n(hk)} housekeeping ({pct(hk, total_calls)}) — "
                                           + " / ".join(f"{t} {n(c)}" for t, c in top), "ISS-010"))

    # --- turn costs
    co = guard(es, "costs")
    cag = co["aggregations"]
    docs = co["hits"]["total"]["value"]
    if docs:
        med = cag["cached_pct"]["values"]["50.0"]
        rows.append(("Cost telemetry", f"`ll5_turn_costs` {n(docs)} docs, sum cost_usd ${cag['cost']['value']:.2f}, "
                                       f"median cached_tokens {n(med)}, max {n(cag['cached_max']['value'])}; "
                                       f"last doc {cag['last']['value_as_string']}", "ISS-006"))
    else:
        rows.append(("Cost telemetry", "`ll5_turn_costs` 0 docs in the window", "ISS-006"))

    # --- session history
    se = guard(es, "sessions")["aggregations"]
    newest = guard(es, "sessions_all")["aggregations"]["newest"].get("value_as_string")
    if newest:
        age = dt.datetime.now(dt.timezone.utc) - parse_ts(newest)
        age_s = f"{age.total_seconds() / 3600:.1f} h ago"
    else:
        age_s = "never"
    rows.append(("Session record", f"`ll5_session_history` {se['sessions']['value']} distinct session_ids indexed in the window; "
                                   f"newest indexed_at {newest or 'n/a'} ({age_s})", "ISS-014"))
    rows.append(("Spill files", "(check inside the container: `ls ~/.claude/projects/*/<session>/tool-results/`)", "ISS-018, 019"))

    # --- GTD
    pg = {}
    for line in pg_text.splitlines():
        if "|" in line:
            k, v = line.rsplit("|", 1)
            try:
                pg[k.strip()] = int(v)
            except ValueError:
                pass
    inbox = {k[6:]: v for k, v in pg.items() if k.startswith("inbox:")}
    habits = {k[6:]: v for k, v in pg.items() if k.startswith("habit:")}
    hs = sum(habits.values())
    rows.append(("GTD", f"{pg.get('open', '?')} open actions / {pg.get('overdue', '?')} overdue; inbox "
                        + " / ".join(f"{v} {k}" for k, v in sorted(inbox.items())) + f"; {hs} habit outcomes ("
                        + " / ".join(f"{v} {k}" for k, v in sorted(habits.items(), key=lambda kv: -kv[1])) + ")", "—"))
    return rows


def parse_frozen(path):
    rows = {}
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return rows
    for line in text.splitlines():
        m = re.match(r"^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|$", line)
        if m and m.group(1) not in ("Area", "KPI") and not m.group(1).startswith("-"):
            rows.setdefault(m.group(1), m.group(2))
    return rows


def render(since, until, user, es, pg_text, baseline_path):
    a, b, ndays = window(since, until)
    rows = compute(since, until, user, es, pg_text)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    out = [f"# Agent baseline — {a} → {b} ({ndays} day{'s' if ndays != 1 else ''})", "",
           f"Re-measure generated {now} by `scripts/agent-baseline.sh --since {a} --until {b}` for user `{user}`. "
           f"Same rows as the frozen control `docs/reviews/2026-09-04/agent-baseline.md`; issues are in `docs/ISSUES.md`.", "",
           "## Numbers", "", "| Area | Measurement | Issue |", "|---|---|---|"]
    out += [f"| {area} | {meas} | {iss} |" for area, meas, iss in rows]
    frozen = parse_frozen(baseline_path) if baseline_path else {}
    out += ["", "## Delta vs frozen baseline", ""]
    if frozen:
        out += [f"Frozen: `{baseline_path}`. Rows compared where the Area label matches.", "",
                "| Area | Frozen (before) | Now (after) |", "|---|---|---|"]
        for area, meas, _ in rows:
            if area in frozen:
                out.append(f"| {area} | {frozen[area]} | {meas} |")
        missing = [area for area, _, _ in rows if area not in frozen]
        if missing:
            out += ["", "New rows without a frozen counterpart: " + ", ".join(f"`{m}`" for m in missing) + "."]
    else:
        out.append(f"(frozen baseline not found at `{baseline_path}`)")
    out += ["", "## Method", "",
            "Read-only, from a laptop. Elasticsearch is internal-only on the box, so every query runs inside the "
            "awareness container over SSH using its `ELASTICSEARCH_URL` (a node helper derives the Basic-auth header "
            "from the URL credentials; nothing secret leaves the box or is printed). One batched request list per run. "
            "Aggregations: `date_histogram` per day (UTC) and `terms`/`filter` aggs on the fields named in the frozen "
            "Method section; reply latency is the user→next-assistant gap over non-system `ll5_chat_messages`; "
            "rituals are day-counts of journal entries whose content matches the phrase. GTD via `psql` in the "
            "postgres container. Spill files are not visible from ES — check inside the agent container.", ""]
    return "\n".join(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("queries", "render"):
        s = sub.add_parser(name)
        s.add_argument("--since", required=True)
        s.add_argument("--until", required=True)
        s.add_argument("--user", required=True)
        if name == "queries":
            s.add_argument("--sql", action="store_true", help="print the postgres SQL instead of the ES queries")
        else:
            s.add_argument("--es", required=True, help="JSON map produced by the in-container helper")
            s.add_argument("--pg", required=True, help="psql output (name|count lines)")
            s.add_argument("--baseline", default="docs/reviews/2026-09-04/agent-baseline.md")
    args = p.parse_args()
    if args.cmd == "queries":
        if args.sql:
            sys.stdout.write(build_sql(args.since, args.until, args.user))
        else:
            json.dump(build_queries(args.since, args.until, args.user), sys.stdout)
        return
    es = json.load(open(args.es, encoding="utf-8"))
    pg_text = open(args.pg, encoding="utf-8").read()
    sys.stdout.write(render(args.since, args.until, args.user, es, pg_text, args.baseline) + "\n")


if __name__ == "__main__":
    main()
