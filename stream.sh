#!/usr/bin/env bash
set -euo pipefail

CAMERA_URL="rtsp://xxx:xxx@xxx"
YT_RTMP="rtmp://a.rtmp.youtube.com/live2/xxxx"

while true; do
  echo "$(date -Is) starting ffmpeg…"
  ffmpeg \
    -loglevel info \
    -rtsp_transport tcp \
    -stimeout 5000000 \
    -thread_queue_size 512 -i "$CAMERA_URL" \
    -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -shortest \
    -map 0:v:0 -map 1:a:0 \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -g 60 -r 30 \
    -b:v 1000k -maxrate 1200k -bufsize 2400k \
    -c:a aac -b:a 128k -ar 44100 -ac 2 \
    -f flv "$YT_RTMP" || true

  echo "$(date -Is) ffmpeg exited; restarting in 5s…"
  sleep 5
done
