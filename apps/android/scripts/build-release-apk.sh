#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SKIP_WEB=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-web)
      SKIP_WEB=1
      ;;
    --skip-tests)
      SKIP_TESTS=1
      ;;
    -h|--help)
      echo "Usage: $0 [--skip-web] [--skip-tests]"
      echo "  Syncs dist-mobile-native, runs Android unit tests, and builds a signed Release APK."
      echo "  Signing reads apps/android/keystore.properties or VECWAY_ANDROID_* env vars."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${JAVA_HOME:-}" ]] && [[ -x /usr/libexec/java_home ]]; then
  if JDK17="$(/usr/libexec/java_home -v 17 2>/dev/null)"; then
    export JAVA_HOME="${JDK17}"
    export PATH="${JAVA_HOME}/bin:${PATH}"
  fi
fi

if [[ "${SKIP_WEB}" -eq 0 ]]; then
  "${SCRIPT_DIR}/sync-web.sh"
fi

cd "${ANDROID_DIR}"

if [[ "${SKIP_TESTS}" -eq 0 ]]; then
  echo "[build-apk] Running Android unit & security tests..."
  ./gradlew testDebugUnitTest --no-daemon --console=plain
fi

echo "[build-apk] Building Release APK..."
./gradlew assembleRelease --no-daemon --console=plain

RELEASE_DIR="${ANDROID_DIR}/app/build/outputs/apk/release"
APK_PATH="${RELEASE_DIR}/app-release.apk"
if [[ ! -f "${APK_PATH}" ]]; then
  APK_PATH="${RELEASE_DIR}/app-release-unsigned.apk"
fi

if [[ ! -f "${APK_PATH}" ]]; then
  echo "[build-apk] ERROR: Release APK not found in ${RELEASE_DIR}" >&2
  exit 1
fi

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
APKSIGNER="$(find "${SDK_ROOT}/build-tools" -maxdepth 2 -name apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -n "${APKSIGNER}" && -x "${APKSIGNER}" && "${APK_PATH}" == *"app-release.apk" ]]; then
  echo "[build-apk] Verifying APK signature via ${APKSIGNER}..."
  "${APKSIGNER}" verify --print-certs "${APK_PATH}"
fi

echo "[build-apk] Output APK: ${APK_PATH} ($(du -h "${APK_PATH}" | awk '{print $1}'))"
