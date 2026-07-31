#!/bin/bash

echo "=== $(date) ==="

# Use node directly by path — nvm source can hang indefinitely under launchd
export PATH="$HOME/.nvm/versions/node/v25.5.0/bin:$PATH"

set -eo pipefail
cd /Users/z/Codebase/briefed

# sync exits non-zero if any individual collector fails (e.g. an expired
# Gmail token), even when others succeed. Don't let that block digest —
# capture the status and keep going; the failure is already visible in
# sync's own output above.
sync_status=0
npm run sync || sync_status=$?
if [ "$sync_status" -ne 0 ]; then
  echo "WARNING: sync exited with status $sync_status — continuing to digest anyway"
fi

npm run digest

echo "=== Done: $(date) ==="
exit "$sync_status"
