# Use official Node.js LTS Debian-slim image
FROM node:20-bullseye-slim

# Install system dependencies required for native modules and media handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for Docker layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source code
COPY . .

# Ensure data directories exist
RUN mkdir -p data/sessions data/uploads

# Expose default port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start command
CMD ["npm", "start"]
