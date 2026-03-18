# Multi-stage build for minimal image size
FROM python:3.12-slim AS builder

WORKDIR /build

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Final stage
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /root/.local /root/.local

# Copy application
COPY app.py .

# Create data directory
RUN mkdir -p /data

# Make sure scripts in .local are usable
ENV PATH=/root/.local/bin:$PATH

# Expose port
EXPOSE 8844

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request, os; urllib.request.urlopen('http://localhost:' + os.environ.get('PORT', '8844') + '/health')" || exit 1

# Run the application
CMD ["python", "-u", "app.py"]
