FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/index.html web/vite.config.ts web/tsconfig.json ./
COPY web/src ./src
COPY web/public ./public
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY api/app ./app
COPY --from=web /web/dist /app/ui
RUN mkdir -p /data
ENV PYTHONUNBUFFERED=1
ENV GAUGES_UI_DIR=/app/ui
ENV DATA_DIR=/data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8090'), timeout=3)"
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8090}"]
