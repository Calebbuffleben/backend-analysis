# Use Node.js 18 (LTS) as base image
FROM node:18-alpine AS base

# Install pnpm globally
RUN npm install -g pnpm@10.18.2

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy Prisma schema
COPY prisma ./prisma

# Generate Prisma client
RUN pnpm prisma:generate

# Copy source code
COPY . .

# Build the application
RUN pnpm build

# Production stage
FROM node:18-alpine AS production

# Install pnpm globally
RUN npm install -g pnpm@10.18.2

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --prod --frozen-lockfile

# Install Prisma CLI globally for migrations (needed for migrate deploy)
RUN npm install -g prisma@^5.20.0

# Copy Prisma schema
COPY --from=base /app/prisma ./prisma

# Generate Prisma client in production stage (needed for runtime)
RUN pnpm prisma:generate

# Copy built application
COPY --from=base /app/dist ./dist

# Create storage directories
RUN mkdir -p storage/egress/audio storage/egress/video storage/pipeline-logs

# Expose port (Railway will set PORT env var)
EXPOSE 3001

# Health check (Railway also has its own health checks)
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3001) + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
# Note: Railway will provide DATABASE_URL and PORT via environment variables
# We run migrations on startup and then start the server
CMD ["sh", "-c", "prisma migrate deploy && pnpm start:prod"]

