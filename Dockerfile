FROM node:20-alpine
RUN apk add --no-cache python3 make g++ git
WORKDIR /app
COPY backend/package*.json ./
COPY backend/src ./src
RUN npm ci --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
