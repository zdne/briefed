#!/bin/bash
set -e

. /Users/z/.nvm/nvm.sh
cd /Users/z/Codebase/briefed

echo "=== $(date) ==="
npm run sync
npm run digest -- --canonical-only
