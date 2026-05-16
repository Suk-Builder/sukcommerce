FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force

COPY index.js ./

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node-fetch')('http://localhost:3000/health').then(r => {if(!r.ok) throw new Error('unhealthy')})" || exit 1

CMD ["node", "index.js"]
