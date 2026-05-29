#!/usr/bin/env bash
# Run JARVIS as a macOS LaunchAgent: starts on login, restarts if it crashes.
#   bash scripts/install-service.sh            # install + start
#   bash scripts/install-service.sh uninstall  # stop + remove
set -e
LABEL=com.jarvis.bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Logs/jarvis-bridge.log"
GUI="gui/$(id -u)"

if [ "$1" = "uninstall" ]; then
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"; echo "uninstalled $LABEL"; exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/bridge/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict></plist>
PL

launchctl bootout "$GUI/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "$GUI" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
echo "installed $LABEL  → http://localhost:4317   (logs: $LOG)"
echo "restart after code changes:  launchctl kickstart -k $GUI/$LABEL"
