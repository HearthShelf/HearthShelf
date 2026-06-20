FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
# Node runtime for the QuestGiver backend service (the only server beyond nginx).
RUN apk add --no-cache nodejs

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/templates/default.conf.template
COPY nginx/abs_proxy.conf /etc/nginx/templates/abs_proxy.conf.template
COPY nginx/upgrade-map.conf /etc/nginx/templates/upgrade-map.conf
# QuestGiver backend (no npm deps - pure Node built-ins).
COPY server/ /app/server/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
