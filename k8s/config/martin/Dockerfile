FROM ghcr.io/maplibre/martin:1.4.0

USER root

RUN mkdir -p /etc/martin && chown -R 10000:10000 /etc/martin

COPY map-tiles-martin/martin-config.yml /etc/martin/martin-config.yml

RUN chown 10000:10000 /etc/martin/martin-config.yml

USER 10000

CMD ["--config", "/etc/martin/martin-config.yml"]
