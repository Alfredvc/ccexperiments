# Stage 1: build native modules (node-pty needs python3, make, g++)
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install

# Stage 2: runtime
FROM node:22-slim

# Pinned Claude Code version. Bump intentionally; never float.
# All findings in README must cite a specific version (this one or a documented prior).
ARG CC_VERSION=2.1.132
ENV CC_VERSION=${CC_VERSION}

# Install claude CLI via the official native script (recommended path).
# Native install drops the binary at /root/.local/bin/claude.
# `bash -s <ver>` pins to a specific version per https://claude.ai/install.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash -s "${CC_VERSION}"
ENV PATH=/root/.local/bin:${PATH}

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY lib/ ./lib/
COPY tests/ ./tests/

# Isolated workspace for claude sessions (no project .claude/ dir)
RUN mkdir -p /workspace

# ~/.claude.json (note: NOT inside ~/.claude/) tells claude onboarding is done.
# Without this file claude ignores ~/.claude/.credentials.json and prompts for login.
RUN echo '{"hasCompletedOnboarding":true,"installMethod":"native","projects":{"/workspace":{"hasTrustDialogAccepted":true}}}' > /root/.claude.json

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "tests/clear-command-clears-cache.js"]
