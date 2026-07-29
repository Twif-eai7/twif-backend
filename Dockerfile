# Use Node.js 18 slim for smaller image size
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json package-lock.json ./

RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
RUN npm ci --only=production

# Copy the rest of the application
COPY . .

# Create a non-root user for security
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Cloud Run will set PORT env var (defaults to 8080)
# Your app should listen on process.env.PORT || 8080
EXPOSE 8080

# Start the application
CMD ["npm", "start"]