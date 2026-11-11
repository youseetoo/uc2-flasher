# Build from the ImSwitch repo root (the canbus package is shared with ImSwitch):
#   docker build -f docker/uc2-flasher/Dockerfile -t uc2-flasher .
FROM python:3.12-slim
WORKDIR /app
COPY docker/uc2-flasher/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY imswitch/imcontrol/model/canbus ./canbus
COPY docker/uc2-flasher/server.py .
COPY docker/uc2-flasher/static ./static
ENV PORT=8004 PYTHONUNBUFFERED=1
EXPOSE 8004
CMD ["python", "server.py"]
