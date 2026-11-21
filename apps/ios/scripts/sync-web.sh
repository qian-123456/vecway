#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${IOS_DIR}/../.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist-mobile-native"
TARGET_DIR="${IOS_DIR}/Vecway/Resources/WebBundle"

SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    -h|--help)
      echo "Usage: $0 [--skip-build]"
      echo "  Builds dist-mobile-native via pnpm build:mobile:native and syncs it into apps/ios/Vecway/Resources/WebBundle."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  echo "[sync-web] Running pnpm build:mobile:native in ${REPO_ROOT}..."
  (cd "${REPO_ROOT}" && pnpm build:mobile:native)
fi

if [[ ! -f "${DIST_DIR}/index.html" ]]; then
  echo "[sync-web] ERROR: ${DIST_DIR}/index.html not found. Run pnpm build:mobile:native first." >&2
  exit 1
fi

echo "[sync-web] Syncing ${DIST_DIR} -> ${TARGET_DIR}..."
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"
cp -R "${DIST_DIR}/." "${TARGET_DIR}/"
touch "${TARGET_DIR}/.keep"

echo "[sync-web] Sync complete: $(find "${TARGET_DIR}" -type f ! -name '.keep' | wc -l | tr -d ' ') files copied."
