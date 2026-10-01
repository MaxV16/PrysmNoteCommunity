FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY apps/backend/pyproject.toml .
COPY apps/backend/app/ ./app/
# The pyproject maps the top-level `ee` package to `../../ee` (relative to the
# project root), so the editable install expects it one level above /app. Place
# it there; dev compose still mounts the live ./ee tree at /app/ee for reloads.
RUN pip install --no-cache-dir -e .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--workers", "1", "--limit-max-requests", "10000", "--timeout-keep-alive", "30", "--backlog", "2048"]
