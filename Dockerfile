FROM node:20-alpine

# Build-Dependencies für better-sqlite3
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy backend
COPY backend/package*.json ./
COPY backend/src ./src

# Install dependencies (builds better-sqlite3 from source)
RUN npm ci --omit=dev

# Set environment
ENV NODE_ENV=production

# Expose port
EXPOSE ${PORT:-3000}

# Start server
CMD ["npm", "start"]

