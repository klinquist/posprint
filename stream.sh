#!/usr/bin/env bash
set -euo pipefail

# ===== Config =====
TZ_NAME="America/Los_Angeles"
CAMERA_URL="rtsp://XXXX@xxxx"
YT_RTMP="rtmp://a.rtmp.youtube.com/live2/xxxx"

# Encoding settings (1080p example; tweak as needed)
FRAMERATE=30
GOP=$((FRAMERATE * 2))       # ~2s keyframe interval for YouTube
VIDEO_BITRATE="3000k"
MAXRATE="3500k"
BUFSIZE="8000k"

while true; do
  now_ts=$(TZ="$TZ_NAME" date +%s)
  today=$(TZ="$TZ_NAME" date +%Y-%m-%d)

  start_ts=$(TZ="$TZ_NAME" date -d "$today 06:00:00" +%s)
  end_ts=$(TZ="$TZ_NAME"   date -d "$today 21:00:00" +%s)

  if (( now_ts < start_ts )); then
    # Before 6am PT -> sleep until start
    sleep_for=$(( start_ts - now_ts ))
    echo "$(date -Is) Not in window yet. Sleeping $sleep_for s until 06:00 PT…"
    sleep "$sleep_for"
    continue
  fi

  if (( now_ts >= end_ts )); then
    # After 9pm PT -> sleep until tomorrow 6am PT
    tomorrow=$(TZ="$TZ_NAME" date -d "tomorrow" +%Y-%m-%d)
    next_start=$(TZ="$TZ_NAME" date -d "$tomorrow 06:00:00" +%s)
    sleep_for=$(( next_start - now_ts ))
    echo "$(date -Is) Window ended. Sleeping $sleep_for s until next 06:00 PT…"
    sleep "$sleep_for"
    continue
  fi

  # We are inside the window. Run ffmpeg but enforce a hard stop at 21:00 PT.
  remain=$(( end_ts - now_ts ))
  echo "$(date -Is) starting ffmpeg for up to $remain seconds (until 21:00 PT)…"

  # Use 'timeout' to end ffmpeg at the cut-off time.
  timeout --signal=INT "$remain"s \
  ffmpeg \
    -loglevel info \
    -rtsp_transport tcp \
    -stimeout 5000000 \
    -thread_queue_size 512 -i "$CAMERA_URL" \
    -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
    -shortest \
    -map 0:v:0 -map 1:a:0 \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p \
    -g "$GOP" -r "$FRAMERATE" \
    -b:v "$VIDEO_BITRATE" -maxrate "$MAXRATE" -bufsize "$BUFSIZE" \
    -c:a aac -b:a 128k -ar 44100 -ac 2 \
    -f flv "$YT_RTMP" || true

  echo "$(date -Is) ffmpeg stopped (either error or reached 21:00 PT). Looping…"
  sleep 5
done
