FROM maptiler/tileserver-gl:v5.6.0-pre.4

USER root

COPY map-tiles-tileserver/tileserver-config.yml /usr/src/app/config.json

RUN chown node:node /usr/src/app/config.json && \
    printf '%s\n' \
'#!/bin/sh' \
'set -eu' \
'if ! command -v -- "$1" >/dev/null 2>&1; then' \
'  if [ -e /tmp/.X99-lock ]; then' \
'    rm -f /tmp/.X99-lock' \
'  fi' \
'  export DISPLAY=:99' \
'  Xvfb "${DISPLAY}" -nolisten unix &' \
'  exec node /usr/src/app/src/main.js "$@"' \
'fi' \
'exec "$@"' \
> /usr/local/bin/entrypoint && chmod +x /usr/local/bin/entrypoint && chown node:node /usr/local/bin/entrypoint

USER node

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["entrypoint", "--config", "/usr/src/app/config.json", "--port", "8080", "--verbose"]
