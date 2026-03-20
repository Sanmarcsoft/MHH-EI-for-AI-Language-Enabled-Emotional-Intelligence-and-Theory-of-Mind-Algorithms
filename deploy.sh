#!/usr/bin/env bash
# deploy.sh — Full deployment pipeline for the LivePortrait Avatar System
#
# Prerequisites:
#   - Scaleway credentials: SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID, SCW_DEFAULT_ORGANIZATION_ID
#   - Nix installed with flakes enabled
#   - skopeo installed (comes with nix develop shell)
#   - Scaleway Container Registry credentials (for docker login)
#
# Usage:
#   ./deploy.sh              # Deploy everything (build + push + infra)
#   ./deploy.sh build        # Build OCI image only
#   ./deploy.sh push         # Push to Scaleway registry only
#   ./deploy.sh infra        # Deploy Pulumi infra only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="rg.fr-par.scw.cloud/sanmarcsoft"
IMAGE_NAME="liveportrait-api"
TAG="${IMAGE_TAG:-testing}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ── Build OCI image ─────────────────────────────────────────────────────────

build_image() {
    log "Building OCI image for x86_64-linux..."
    cd "$SCRIPT_DIR/liveportrait-api"

    nix build .#packages.x86_64-linux.oci-image \
        --out-link result \
        --print-build-logs

    if [ ! -L result ]; then
        err "Build failed — no result link"
        exit 1
    fi

    log "Image built: $(ls -lh result | awk '{print $5}')"
    log "Image path: $(readlink -f result)"
}

# ── Push to Scaleway registry ────────────────────────────────────────────────

push_image() {
    log "Pushing to ${REGISTRY}/${IMAGE_NAME}:${TAG}..."
    cd "$SCRIPT_DIR/liveportrait-api"

    if [ ! -L result ]; then
        err "No built image found. Run './deploy.sh build' first."
        exit 1
    fi

    skopeo copy \
        "docker-archive:$(readlink -f result)" \
        "docker://${REGISTRY}/${IMAGE_NAME}:${TAG}" \
        --dest-creds "${SCW_REGISTRY_USER:-}:${SCW_REGISTRY_PASSWORD:-}"

    log "Pushed ${REGISTRY}/${IMAGE_NAME}:${TAG}"
}

# ── Deploy Pulumi infrastructure ─────────────────────────────────────────────

deploy_infra() {
    log "Deploying Scaleway infrastructure..."
    cd "$SCRIPT_DIR/infra"

    # Check for required env vars
    for var in SCW_ACCESS_KEY SCW_SECRET_KEY SCW_DEFAULT_PROJECT_ID; do
        if [ -z "${!var:-}" ]; then
            err "Missing required env var: $var"
            exit 1
        fi
    done

    # Install deps if needed
    if [ ! -d node_modules ]; then
        log "Installing Pulumi dependencies..."
        npm install
    fi

    # Initialize stack if needed
    STACK="${PULUMI_STACK:-testing}"
    if ! pulumi stack select "$STACK" 2>/dev/null; then
        log "Initializing stack: $STACK"
        pulumi stack init "$STACK"
    fi

    # Check required secrets
    if ! pulumi config get registryUsername &>/dev/null; then
        warn "Registry credentials not set. Run:"
        warn "  pulumi config set --secret registryUsername <value>"
        warn "  pulumi config set --secret registryPassword <value>"
        exit 1
    fi

    # Set image tag to match what we built
    pulumi config set imageTag "$TAG"

    # Deploy
    log "Running pulumi up (stack: $STACK)..."
    pulumi up --yes

    # Show outputs
    log "Deployment complete!"
    echo ""
    pulumi stack output
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "${1:-all}" in
    build)
        build_image
        ;;
    push)
        push_image
        ;;
    infra)
        deploy_infra
        ;;
    all)
        build_image
        push_image
        deploy_infra
        log "Full deployment complete!"
        echo ""
        echo "Next steps:"
        echo "  1. Wait for cloud-init to complete on the GPU instance (~5 min)"
        echo "  2. SSH to the instance and check: systemctl status liveportrait-api"
        echo "  3. Test: curl http://<instance-ip>:8090/health"
        echo "  4. Set LIVEPORTRAIT_URL on the ASUS laptop Agent Zero"
        echo "  5. Open avatar-live.html in browser on the ASUS laptop"
        ;;
    *)
        echo "Usage: $0 {build|push|infra|all}"
        exit 1
        ;;
esac
