# syntax=docker/dockerfile:1
# The browser add-on as a separate container (docs/addons.md). Built by `aigentron addon enable browser` on a Docker
# install and by the `browser` compose profile. The SAME installer as the bare-metal path runs inside debian:12 —
# `bare.sh build` = packages + the aigentron-browser user + noVNC/websockify (pinned, sha256-verified) + Chromium,
# minus systemd/state.json; entrypoint.sh then runs the same components through browser-run.sh under a tiny supervisor.
#
#   docker build -t aigentron-browser -f infra/addons/browser/docker/Dockerfile infra/addons/browser
#   --build-arg BROWSER=chrome|chromium|playwright   (default: the distro's chromium; chrome is x86_64 only)
FROM debian:12
ARG BROWSER=
ARG DEBIAN_FRONTEND=noninteractive
COPY addon.json bare.sh browser-run.sh cdp-proxy.py /opt/aigentron/addon-src/
RUN BROWSER="$BROWSER" bash /opt/aigentron/addon-src/bare.sh build \
  && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
COPY docker/entrypoint.sh /opt/aigentron/browser/bin/entrypoint.sh
RUN chmod 755 /opt/aigentron/browser/bin/entrypoint.sh
ENV AGENT_CDP=on
# The profile lives here (a named volume keeps it across container re-creates / image updates).
VOLUME /var/lib/aigentron-browser
# view (noVNC, HTTP + WebSocket) and CDP — reachable on the internal Docker network only; nothing is published by default.
EXPOSE 6080 9222
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:6080/ || exit 1
ENTRYPOINT ["/opt/aigentron/browser/bin/entrypoint.sh"]
