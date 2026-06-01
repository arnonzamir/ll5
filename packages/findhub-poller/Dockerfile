# LL5 findhub-poller — Python sidecar wrapping GoogleFindMyTools.
#
# GoogleFindMyTools is installed from git (not on PyPI). Pin the commit via the
# FINDMY_REF build arg for reproducibility — the upstream API is experimental.
FROM python:3.12-slim AS runtime

# Build-time pin. Override with --build-arg FINDMY_REF=<sha>.
# Pinned to the commit the local auth (secrets.json) was generated against.
ARG FINDMY_REF=d46e952

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # GoogleFindMyTools is importable from the repo root we clone it into.
    PYTHONPATH=/opt/GoogleFindMyTools

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Clone + install upstream deps. Auth is done OFFLINE (secrets.json mounted),
# so no Chrome/Chromium is installed here — the container never authenticates.
RUN git clone https://github.com/leonboe1/GoogleFindMyTools.git /opt/GoogleFindMyTools \
    && cd /opt/GoogleFindMyTools \
    && git checkout "$FINDMY_REF" \
    && pip install --no-cache-dir -r requirements.txt

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY poller.py findhub_client.py ./

# Auth/secrets.json is provided at runtime (mount or copy into this path).
# GoogleFindMyTools reads it relative to its own dir.
VOLUME ["/opt/GoogleFindMyTools/Auth"]

# Non-root.
RUN useradd -m -u 10001 poller && chown -R poller:poller /app /opt/GoogleFindMyTools
USER poller

CMD ["python", "poller.py"]
