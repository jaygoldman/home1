#!/usr/bin/env bash
# imessage-push.sh — send an iMessage via the Messages app on macOS
#
# Usage: IMESSAGE_RECIPIENT=<phone or Apple ID email> imessage-push.sh "message body"
#
# Called by server/alerts.js to text the operator when poem generation is down
# (e.g. the Claude CLI's login expired) and again when it recovers. The
# recipient comes from Settings → Alerts; there is deliberately no default.
# Requires Messages signed in to iMessage on this Mac.
#
# Robust against special characters in the message body because we use
# osascript's `on run argv` pattern (no shell interpolation into AppleScript).

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: IMESSAGE_RECIPIENT=<addr> $0 \"message body\"" >&2
  exit 2
fi

MESSAGE="$1"
RECIPIENT="${IMESSAGE_RECIPIENT:?IMESSAGE_RECIPIENT is required}"

# Pass recipient and message as argv to AppleScript. This avoids every
# shell-to-AppleScript quoting pitfall: no nested escaping, no injection.
osascript - "$RECIPIENT" "$MESSAGE" <<'APPLESCRIPT'
on run argv
    set theRecipient to item 1 of argv
    set theMessage to item 2 of argv
    tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy theRecipient of targetService
        send theMessage to targetBuddy
    end tell
end run
APPLESCRIPT
