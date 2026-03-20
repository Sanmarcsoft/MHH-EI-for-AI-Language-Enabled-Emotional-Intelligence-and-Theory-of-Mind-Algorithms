import * as pulumi from "@pulumi/pulumi";
import * as scaleway from "@pulumiverse/scaleway";

// ---------------------------------------------------------------------------
// Stack configuration
// ---------------------------------------------------------------------------

const config = new pulumi.Config();
const stack = pulumi.getStack();

// GPU instance commercial type. GPU-3070-S is the Scaleway NVIDIA 3070-class
// GPU instance available in fr-par-2. Override via `pulumi config set gpuType`.
// Other valid options: RENDER-S (older V100), L4-1-24G (L4 GPU, fr-par-3).
const gpuType = config.get("gpuType") ?? "GPU-3070-S";

// SSH access note: Scaleway injects SSH public keys from your project's
// account.SshKey resources automatically. Register your key at
// https://console.scaleway.com/iam/ssh-keys or via:
//   scw iam ssh-key create name=mykey public-key="$(cat ~/.ssh/id_ed25519.pub)"
// No per-instance key configuration is needed in this Pulumi program.

// Scaleway Container Registry credentials for pulling the LivePortrait image.
// Set via: pulumi config set --secret registryUsername <value>
//          pulumi config set --secret registryPassword <value>
const registryUsername = config.requireSecret("registryUsername");
const registryPassword = config.requireSecret("registryPassword");

// Image tag to deploy. Defaults to "production" per SOP.
// Override via: pulumi config set imageTag testing
const imageTag = config.get("imageTag") ?? "production";

const imageRef = `rg.fr-par.scw.cloud/sanmarcsoft/liveportrait-api:${imageTag}`;

// ---------------------------------------------------------------------------
// Security Group
// Inbound: port 22 (SSH management) and 8090 (LivePortrait HTTP API).
// Outbound: accept all (container must reach Scaleway registry on pull).
// Default inbound policy is drop — only the explicit rules below are admitted.
// ---------------------------------------------------------------------------

const securityGroup = new scaleway.instance.SecurityGroup("liveportrait-api-sg", {
    name: `liveportrait-api-sg-${stack}`,
    description: `LivePortrait API security group (${stack})`,
    zone: "fr-par-2",
    inboundDefaultPolicy: "drop",
    outboundDefaultPolicy: "accept",
    stateful: true,
    inboundRules: [
        {
            // SSH — restrict to your management CIDR in production via
            // pulumi config set sshCidr 203.0.113.0/24 and reference it here.
            // Left open (0.0.0.0/0) so the stack is functional on first deploy;
            // tighten before exposing to the public internet.
            action: "accept",
            protocol: "TCP",
            port: 22,
        },
        {
            // LivePortrait HTTP API
            action: "accept",
            protocol: "TCP",
            port: 8090,
        },
    ],
    tags: [
        "liveportrait-api",
        stack,
        "managed-by-pulumi",
    ],
});

// ---------------------------------------------------------------------------
// Reserved public IP
// GPU instances in fr-par-2 require an explicitly allocated flexible IP.
// We allocate it separately so it survives instance replacement.
// ---------------------------------------------------------------------------

const publicIp = new scaleway.instance.Ip("liveportrait-api-ip", {
    zone: "fr-par-2",
    tags: [
        "liveportrait-api",
        stack,
        "managed-by-pulumi",
    ],
});

// ---------------------------------------------------------------------------
// Cloud-init user data
// Runs once on first boot. Sequence:
//   1. Install Docker (ubuntu_jammy base image ships without it).
//   2. Install NVIDIA container toolkit (required for --gpus all).
//   3. Authenticate against the Scaleway Container Registry.
//   4. Pull and run the LivePortrait API container.
//   5. Configure a systemd unit so the container restarts across reboots.
//
// The cloud-init script is assembled from Pulumi Output<string> because
// the registry password is a secret Output. pulumi.interpolate produces
// a single Output<string> that Pulumi will resolve at deploy time and
// never log in plaintext.
// ---------------------------------------------------------------------------

const cloudInitScript: pulumi.Output<string> = pulumi.interpolate`#cloud-config
package_update: true
package_upgrade: false

packages:
  - apt-transport-https
  - ca-certificates
  - curl
  - gnupg
  - lsb-release

runcmd:
  # --- Docker ---
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update -qq
  - apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin

  # --- NVIDIA Container Toolkit ---
  - curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  - curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  - apt-get update -qq
  - apt-get install -y -qq nvidia-container-toolkit
  - nvidia-ctk runtime configure --runtime=docker
  - systemctl restart docker

  # --- Registry authentication ---
  - docker login rg.fr-par.scw.cloud -u ${registryUsername} -p ${registryPassword}

  # --- Pull image ---
  - docker pull ${imageRef}

  # --- Create systemd unit for the LivePortrait API container ---
  - |
    cat > /etc/systemd/system/liveportrait-api.service << 'EOF'
    [Unit]
    Description=LivePortrait GPU API
    After=docker.service
    Requires=docker.service

    [Service]
    Restart=always
    RestartSec=10
    ExecStartPre=-/usr/bin/docker stop liveportrait-api
    ExecStartPre=-/usr/bin/docker rm liveportrait-api
    ExecStart=/usr/bin/docker run --rm --name liveportrait-api \
      --gpus all \
      -p 8090:8090 \
      -e MODEL_CACHE_DIR=/models \
      -v /opt/liveportrait/models:/models \
      ${imageRef}
    ExecStop=/usr/bin/docker stop liveportrait-api

    [Install]
    WantedBy=multi-user.target
    EOF

  - mkdir -p /opt/liveportrait/models
  - systemctl daemon-reload
  - systemctl enable liveportrait-api
  - systemctl start liveportrait-api
`;

// ---------------------------------------------------------------------------
// GPU Instance
// ubuntu_jammy is the correct image label for Ubuntu 22.04 LTS on Scaleway.
// GPU-3070-S requires sbs_volume (SBS block storage) for the root volume —
// local NVMe scratch is not large enough for the OS + model weights.
// 100 GB gives ~60 GB free after OS install for model caching on-instance
// (primary cache is the Object Storage bucket below).
// ---------------------------------------------------------------------------

const server = new scaleway.instance.Server("liveportrait-api", {
    name: `liveportrait-api-${stack}`,
    type: gpuType,
    image: "ubuntu_jammy",
    zone: "fr-par-2",
    ipId: publicIp.id,
    securityGroupId: securityGroup.id,
    rootVolume: {
        volumeType: "sbs_volume",
        sizeInGb: 100,
        deleteOnTermination: true,
    },
    state: "started",
    userData: {
        // The provider maps the "cloud-init" key to the cloud-init user data
        // slot. Value must be a raw cloud-config string (not base64).
        "cloud-init": cloudInitScript,
    },
    tags: [
        "liveportrait-api",
        "mhh-ei",
        stack,
        "managed-by-pulumi",
    ],
});

// ---------------------------------------------------------------------------
// Object Storage bucket — face model cache
// Named sanmarcsoft-avatar-models. Bucket names are globally unique on
// Scaleway Object Storage per region; the name does not include the stack
// suffix because the model artefacts are shared across testing and production
// (read-only from the instance, write from the build pipeline).
// If you need per-stack isolation, append `-${stack}` to the name.
// ---------------------------------------------------------------------------

const modelsBucket = new scaleway.object.Bucket("avatar-models", {
    name: "sanmarcsoft-avatar-models",
    region: "fr-par",
    versioning: {
        // Versioning off by default — face model files are large binaries
        // replaced in-place rather than incrementally patched. Enable if
        // a rollback story for model weights becomes a requirement.
        enabled: false,
    },
    tags: {
        project: "mhh-ei",
        component: "liveportrait-api",
        environment: stack,
        managed_by: "pulumi",
    },
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// The public IPv4 address of the GPU instance.
// Use this to configure Cloudflare Zero Trust or an upstream DNS record
// pointing api.mhh-ei.example.com -> this IP.
export const instanceIp = publicIp.address;

// The full API endpoint (without TLS — add a Cloudflare tunnel or nginx
// reverse proxy in front if you need HTTPS termination on the instance).
export const apiEndpoint = pulumi.interpolate`http://${publicIp.address}:8090`;

// S3-compatible endpoint for the face model cache bucket.
// Mount or access via AWS SDK with:
//   endpoint: bucketEndpoint
//   region: fr-par
//   credentials: SCW_ACCESS_KEY / SCW_SECRET_KEY
export const bucketEndpoint = modelsBucket.endpoint;
export const bucketName = modelsBucket.name;

// Instance ID for use with `scw instance server get <id> zone=fr-par-2`
export const instanceId = server.id;
