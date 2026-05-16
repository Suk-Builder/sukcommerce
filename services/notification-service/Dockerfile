FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=3005
ENV SMTP_PORT=587
ENV RABBITMQ_URL=amqp://rabbitmq:5672
ENV SERVICE_NAME=notification-service

EXPOSE 3005 3006

CMD ["node", "index.js"]
