# syntax=docker/dockerfile:1
# UC2 flasher: the web flasher page + server/server.py, for boards on this machine's USB.
#   docker build -t uc2-flasher .
FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The firmware logic is ImSwitch's canbus package (no ImSwitch imports), taken from GitHub
ARG IMSWITCH_REF=master
ADD --keep-git-dir=false https://github.com/openUC2/ImSwitch.git#${IMSWITCH_REF}:imswitch/imcontrol/model/canbus /app/canbus

COPY index.html /app/web/
COPY css /app/web/css
COPY js /app/web/js
COPY IMAGES /app/web/IMAGES
COPY server/vendor_assets.py server/server.py /app/
RUN python vendor_assets.py /app/web

ENV PORT=8004 WEB_DIR=/app/web PYTHONUNBUFFERED=1
EXPOSE 8004
CMD ["python", "server.py"]
