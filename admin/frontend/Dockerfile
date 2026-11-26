FROM nginxinc/nginx-unprivileged:1.27-alpine

ENV BACKEND_UPSTREAM=backend-service:3001
ENV NGINX_ENVSUBST_FILTER=BACKEND_UPSTREAM

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY index.html styles.css app.js /usr/share/nginx/html/

EXPOSE 8080
