# Use stable Node.js 20 Debian image
FROM node:20-bookworm-slim

# Set working directory
WORKDIR /app

# Install system utilities needed for native compilation and media processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Copy source code
COPY . .

# Ensure data runtime directories exist
RUN mkdir -p data/sessions data/uploads

# Expose port
EXPOSE 3000

# Environment setup
ENV NODE_ENV=production
ENV PORT=3000

# Start server directly
CMD ["node", "server.js"]

