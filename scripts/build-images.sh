#!/usr/bin/env bash
#===============================================================================
# build-images.sh - Build all SukCommerce Docker images locally
#
# Usage: ./scripts/build-images.sh [tag]
#   tag  - Image tag (default: latest)
#
# Examples:
#   ./scripts/build-images.sh           # Build with tag "latest"
#   ./scripts/build-images.sh v1.2.3    # Build with tag "v1.2.3"
#   ./scripts/build-images.sh $(git rev-parse --short HEAD)  # Build with commit SHA
#===============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NAMESPACE="sukcommerce"

# --- Parse Arguments ---------------------------------------------------------
TAG="${1:-latest}"

echo "============================================================================="
echo "  SukCommerce - Local Docker Image Builder"
echo "============================================================================="
echo "  Project root: ${PROJECT_ROOT}"
echo "  Image tag:    ${TAG}"
echo "  Namespace:    ${NAMESPACE}"
echo "============================================================================="

# --- Detect Available Services ----------------------------------------------
SERVICES_DIR="${PROJECT_ROOT}/services"
if [[ ! -d "${SERVICES_DIR}" ]]; then
    echo "Error: services directory not found at ${SERVICES_DIR}"
    exit 1
fi

# Build list of services that have Dockerfiles
declare -a SERVICES=()
for dockerfile in "${SERVICES_DIR}"/*/Dockerfile; do
    if [[ -f "${dockerfile}" ]]; then
        service_name="$(basename "$(dirname "${dockerfile}")")"
        SERVICES+=("${service_name}")
    fi
done

if [[ ${#SERVICES[@]} -eq 0 ]]; then
    echo "Error: No Dockerfiles found in ${SERVICES_DIR}/*/"
    exit 1
fi

echo ""
echo "Found ${#SERVICES[@]} service(s) to build:"
printf '  - %s\n' "${SERVICES[@]}"
echo ""

# --- Build Images -----------------------------------------------------------
FAILED=0
declare -a BUILT_IMAGES=()

for service in "${SERVICES[@]}"; do
    SERVICE_DIR="${SERVICES_DIR}/${service}"
    IMAGE_NAME="${NAMESPACE}/${service}"

    echo "-----------------------------------------------------------------------------"
    echo "  Building: ${IMAGE_NAME}:${TAG}"
    echo "  Context:  ${SERVICE_DIR}"
    echo "-----------------------------------------------------------------------------"

    if docker build \
        --file "${SERVICE_DIR}/Dockerfile" \
        --tag "${IMAGE_NAME}:${TAG}" \
        --tag "${IMAGE_NAME}:latest" \
        --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --build-arg "VCS_REF=$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')" \
        --build-arg "VERSION=${TAG}" \
        "${SERVICE_DIR}"; then

        echo "  [OK] ${IMAGE_NAME}:${TAG}"
        BUILT_IMAGES+=("${IMAGE_NAME}:${TAG}")
    else
        echo "  [FAILED] ${IMAGE_NAME}:${TAG}"
        FAILED=$((FAILED + 1))
    fi
    echo ""
done

# --- Summary ----------------------------------------------------------------
echo "============================================================================="
echo "  Build Summary"
echo "============================================================================="
echo "  Total:    ${#SERVICES[@]}"
echo "  Succeed:  $((${#SERVICES[@]} - FAILED))"
echo "  Failed:   ${FAILED}"
echo "============================================================================="

if [[ ${FAILED} -gt 0 ]]; then
    echo ""
    echo "  WARNING: ${FAILED} image(s) failed to build!"
    echo "============================================================================="
    exit 1
fi

echo ""
echo "  Built images:"
for img in "${BUILT_IMAGES[@]}"; do
    echo "    - ${img}"
done
echo "============================================================================="
echo ""
