#!/usr/bin/env bash
#===============================================================================
# deploy.sh - SukCommerce Server-Side Deployment Script
#
# Run this script on the production server to deploy the latest code.
#
# Usage: ./scripts/deploy.sh [options]
#
# Options:
#   -e, --env FILE       Environment file path (default: .env)
#   -t, --tag TAG        Docker image tag to deploy (default: latest)
#   -b, --branch BRANCH  Git branch to pull (default: main)
#   -s, --skip-health    Skip health check after deployment
#   -h, --help           Show this help message
#
# Examples:
#   ./scripts/deploy.sh                      # Deploy latest from main
#   ./scripts/deploy.sh -t v1.2.3            # Deploy specific tag
#   ./scripts/deploy.sh -e .env.production   # Use custom env file
#===============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_PATH="${PROJECT_ROOT}"
ENV_FILE="${PROJECT_ROOT}/.env"
TAG="latest"
BRANCH="main"
SKIP_HEALTH_CHECK=false
HEALTH_CHECK_TIMEOUT=120

# Services to health-check (in order)
declare -a SERVICES=(
    "gateway"
    "user-service"
    "product-service"
    "order-service"
    "payment-service"
    "notification-service"
)

# Service health check endpoints
declare -A HEALTH_ENDPOINTS=(
    ["gateway"]="http://localhost:3000/health"
    ["user-service"]="http://localhost:3001/health"
    ["product-service"]="http://localhost:3002/health"
    ["order-service"]="http://localhost:3003/health"
    ["payment-service"]="http://localhost:3004/health"
    ["notification-service"]="http://localhost:3005/health"
)

# --- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# --- Helper Functions --------------------------------------------------------
log_info() {
    echo -e "${BLUE}[INFO]${NC}  $*"
}

log_ok() {
    echo -e "${GREEN}[OK]${NC}    $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC}  $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

log_step() {
    echo ""
    echo -e "${BOLD}${CYAN}====> $*${NC}"
}

show_help() {
    sed -n '/^# Usage:/,/^#---/p' "$0" | sed 's/^# //; s/^#//'
}

# --- Parse Arguments ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--env)
            ENV_FILE="$2"
            shift 2
            ;;
        -t|--tag)
            TAG="$2"
            shift 2
            ;;
        -b|--branch)
            BRANCH="$2"
            shift 2
            ;;
        -s|--skip-health)
            SKIP_HEALTH_CHECK=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# --- Pre-flight Checks -------------------------------------------------------
log_step "Pre-flight Checks"

# Check we're in a git repo
if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
    log_error "Not a git repository: ${PROJECT_ROOT}"
    exit 1
fi

# Check docker and docker-compose
if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    log_error "Docker Compose is not installed"
    exit 1
fi

# Determine docker compose command
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

log_info "Using: ${DOCKER_COMPOSE}"
log_ok "Pre-flight checks passed"

# --- Backup ------------------------------------------------------------------
log_step "Creating Backup"
cd "${PROJECT_ROOT}"

BACKUP_DIR="backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"
cp docker-compose.yml "${BACKUP_DIR}/" 2>/dev/null || true
cp .env "${BACKUP_DIR}/" 2>/dev/null || true
${DOCKER_COMPOSE} ps > "${BACKUP_DIR}/services.txt" 2>/dev/null || true

echo "Backup created at: ${BACKUP_DIR}"
log_ok "Backup complete"

# --- Git Pull ----------------------------------------------------------------
log_step "Pulling Latest Code (branch: ${BRANCH})"
cd "${PROJECT_ROOT}"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "${CURRENT_BRANCH}" != "${BRANCH}" ]]; then
    log_warn "Current branch is '${CURRENT_BRANCH}', switching to '${BRANCH}'"
    git checkout "${BRANCH}"
fi

git fetch origin "${BRANCH}"
OLD_COMMIT=$(git rev-parse HEAD)
git reset --hard "origin/${BRANCH}"
NEW_COMMIT=$(git rev-parse HEAD)

if [[ "${OLD_COMMIT}" == "${NEW_COMMIT}" ]]; then
    log_info "No code changes detected (commit: ${NEW_COMMIT:0:7})"
else
    log_info "Updated from ${OLD_COMMIT:0:7} to ${NEW_COMMIT:0:7}"
    echo "  $(git log --oneline "${OLD_COMMIT}..${NEW_COMMIT}" | wc -l) new commit(s)"
fi
log_ok "Code updated"

# --- Pull Docker Images ------------------------------------------------------
log_step "Pulling Docker Images (tag: ${TAG})"
cd "${PROJECT_ROOT}"

if [[ -f "${ENV_FILE}" ]]; then
    export $(grep -v '^#' "${ENV_FILE}" | xargs 2>/dev/null || true)
fi

export TAG="${TAG}"
${DOCKER_COMPOSE} pull

log_ok "Images pulled"

# --- Deploy ------------------------------------------------------------------
log_step "Deploying Services"
cd "${PROJECT_ROOT}"

log_info "Stopping current services..."
${DOCKER_COMPOSE} down --timeout 30

log_info "Cleaning up old resources..."
docker system prune -f --volumes

echo ""
echo "Starting services with TAG=${TAG}..."
${DOCKER_COMPOSE} up -d --remove-orphans

echo ""
${DOCKER_COMPOSE} ps

log_ok "Services deployed"

# --- Health Check ------------------------------------------------------------
if [[ "${SKIP_HEALTH_CHECK}" == true ]]; then
    log_warn "Health check skipped (--skip-health flag)"
else
    log_step "Running Health Checks (timeout: ${HEALTH_CHECK_TIMEOUT}s)"
    echo ""

    # Wait for services to start
    log_info "Waiting 10 seconds for services to initialize..."
    sleep 10

    # Check container status
    log_info "Checking container status..."
    ${DOCKER_COMPOSE} ps
    echo ""

    # Check container health
    ALL_HEALTHY=true
    ELAPSED=0

    while [[ ${ELAPSED} -lt ${HEALTH_CHECK_TIMEOUT} ]]; do
        ALL_HEALTHY=true

        for svc in "${SERVICES[@]}"; do
            CONTAINER=$(${DOCKER_COMPOSE} ps -q "${svc}" 2>/dev/null || true)

            if [[ -z "${CONTAINER}" ]]; then
                echo -e "  ${RED}  ${svc}: container not found${NC}"
                ALL_HEALTHY=false
                continue
            fi

            RUNNING=$(docker inspect --format='{{.State.Running}}' "${CONTAINER}" 2>/dev/null || echo "false")
            HEALTH_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${CONTAINER}" 2>/dev/null || echo "none")

            if [[ "${RUNNING}" != "true" ]]; then
                echo -e "  ${RED}  ${svc}: NOT RUNNING${NC}"
                ALL_HEALTHY=false
            elif [[ "${HEALTH_STATUS}" == "healthy" ]]; then
                echo -e "  ${GREEN}  ${svc}: healthy${NC}"
            elif [[ "${HEALTH_STATUS}" == "none" ]]; then
                echo -e "  ${YELLOW}  ${svc}: running (no health check configured)${NC}"
            else
                echo -e "  ${YELLOW}  ${svc}: ${HEALTH_STATUS}${NC}"
                ALL_HEALTHY=false
            fi
        done

        echo ""

        if [[ "${ALL_HEALTHY}" == true ]]; then
            log_ok "All containers are healthy!"
            break
        fi

        sleep 5
        ELAPSED=$((ELAPSED + 5))
        log_info "Waiting... (${ELAPSED}/${HEALTH_CHECK_TIMEOUT}s)"
        echo ""
    done

    if [[ "${ALL_HEALTHY}" != true ]]; then
        log_error "Health check timed out!"
        log_error "Some containers may not be healthy."
        ${DOCKER_COMPOSE} logs --tail=30
        exit 1
    fi

    # Check HTTP health endpoints
    echo ""
    log_step "Checking HTTP Health Endpoints"

    ALL_HTTP_OK=true
    for svc in "${SERVICES[@]}"; do
        endpoint="${HEALTH_ENDPOINTS[$svc]:-}"
        if [[ -z "${endpoint}" ]]; then
            echo -e "  ${YELLOW}  ${svc}: no endpoint configured${NC}"
            continue
        fi

        log_info "Checking ${svc}: ${endpoint}"
        HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "${endpoint}" 2>/dev/null || echo "000")

        if [[ "${HTTP_CODE}" == "200" ]]; then
            echo -e "  ${GREEN}  ${svc}: HTTP ${HTTP_CODE} OK${NC}"
        else
            echo -e "  ${RED}  ${svc}: HTTP ${HTTP_CODE} FAIL${NC}"
            ALL_HTTP_OK=false
        fi
    done

    if [[ "${ALL_HTTP_OK}" != true ]]; then
        log_error "Some HTTP health checks failed!"
        exit 1
    fi

    log_ok "All HTTP health checks passed!"
fi

# --- Cleanup -----------------------------------------------------------------
log_step "Post-Deploy Cleanup"

docker system prune -f

echo ""
log_info "Disk usage after cleanup:"
docker system df

# --- Summary -----------------------------------------------------------------
echo ""
echo "============================================================================="
echo -e "${GREEN}${BOLD}  SukCommerce Deployment Complete${NC}"
echo "============================================================================="
echo "  Environment:    ${ENV_FILE}"
echo "  Tag:            ${TAG}"
echo "  Branch:         ${BRANCH}"
echo "  Commit:         ${NEW_COMMIT:0:7}"
echo "  Path:           ${DEPLOY_PATH}"
echo "  Time:           $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================================="
echo ""
${DOCKER_COMPOSE} ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
