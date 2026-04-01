FROM nginx:stable-alpine

RUN rm /etc/nginx/conf.d/default.conf || true

COPY map-tiles-frontend/nginx_global.conf /etc/nginx/nginx.conf
COPY map-tiles-frontend/nginx-http-noncache.conf /etc/nginx/conf.d/00-map-tiles-http.conf
COPY map-tiles-frontend/nginx-noncache.conf      /etc/nginx/conf.d/map-tiles-frontend.conf
COPY map-tiles-frontend/frontend/       /usr/share/nginx/html/

RUN set -eux; \
    mkdir -p \
      /var/cache/nginx/client_temp \
      /var/cache/nginx/proxy_temp \
      /var/cache/nginx/fastcgi_temp \
      /var/cache/nginx/uwsgi_temp \
      /var/cache/nginx/scgi_temp \
      /var/log/nginx \
      /var/run \
      /run; \
    chown -R 10000:10000 \
      /var/cache/nginx \
      /var/log/nginx \
      /var/run \
      /run \
      /usr/share/nginx/html

USER 10000

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]