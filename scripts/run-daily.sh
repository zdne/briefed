#!/bin/bash

echo "=== $(date) ==="

# Use node directly by path — nvm source can hang indefinitely under launchd
export PATH="$HOME/.nvm/versions/node/v25.5.0/bin:$PATH"

set -eo pipefail
cd /Users/z/Codebase/briefed

npm run sync
npm run digest

echo "=== Done: $(date) ==="
