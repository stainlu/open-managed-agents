# Runtime Backend Positioning

Status: current as of 2026-05-02.

## Decision

Docker-on-VPS stays the production runtime backend.

`src/runtime/factory.ts` exists so the runtime substrate has an explicit
selection point, but the only supported backend is `docker`. Unknown backend
names must fail startup. Do not silently fall back.

Why:

- The product is the managed-agent layer, not a cloud-container benchmark.
- The current Docker backend already supports the important product behavior:
  per-session container identity, host-mounted durable workspace, warm pool,
  active pool, restart adoption, logs, limited networking, and simple local
  deployment.
- Cloud/container-service backends are only worth adding when they preserve the
  managed-agent contract without forcing the router or harness adapters to know
  cloud-specific storage and lifecycle details.

## Backend Fit

| Backend | Fit | Sharp Read |
|---|---|---|
| Docker on VPS | Production default | Best current match: cheap, simple, POSIX workspace, local adoption, direct logs, controllable lifecycle |
| AWS ECS/Fargate | Possible later | Viable but not free: Fargate bind mounts are ephemeral unless paired with EFS/EBS-style storage; task lifecycle and adoption must be rebuilt |
| Cloud Run | Possible partnership backend | Has NFS and Cloud Storage/gcsfuse volume options, but request/service lifecycle fights long-lived per-session agent containers |
| Kubernetes | Operator/enterprise backend | Technically clean with PV/PVC and CSI, but too much operational surface for the first open personal-agent product |
| Agent sandboxes | Tool/environment substrate, not core runtime replacement | E2B/Daytona/Modal/OpenAI Sandbox Agents are strong isolated computers, but OMA still owns sessions, approvals, events, queues, recovery, and API |

## Source Findings

AWS ECS/Fargate:

- ECS supports bind mounts for both EC2 and Fargate tasks.
- Fargate bind-mount storage is tied to task/container lifecycle and is
  ephemeral by default.
- Fargate platform versions expose default ephemeral storage and allow larger
  ephemeral storage, but durable shared state requires options such as EFS/EBS.
- ECS/Fargate can mount EFS, which makes persistent shared storage possible, but
  that changes the backend contract from local bind-mount adoption to cloud
  task plus network filesystem adoption.

Sources:

- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html
- https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html
- https://aws.amazon.com/about-aws/whats-new/2020/04/amazon-ecs-aws-fargate-support-amazon-efs-filesystems-generally-available/

Cloud Run:

- Cloud Run has volume sources including NFS and Cloud Storage through the
  gcsfuse CSI driver.
- That helps with workspace materialization, but it does not make Cloud Run a
  natural fit for OMA's active/warm session-container pool. Cloud Run wants
  service instances and request handling; OMA wants named long-lived execution
  contexts with adoption and explicit per-session lifecycle.

Source:

- https://cloud.google.com/run/docs/reference/rest/v1/Volume

Kubernetes:

- PersistentVolume/PersistentVolumeClaim is the right Kubernetes abstraction for
  durable per-session workspace storage.
- Kubernetes also brings StorageClass, CSI, access modes, scheduling, and
  cluster-level operations. That is acceptable for enterprise operators, not for
  the initial cheap/open personal-agent wedge.

Source:

- https://kubernetes.io/docs/concepts/storage/persistent-volumes/

Agent sandboxes:

- OpenAI Sandbox Agents explicitly split responsibilities: the outer runtime
  owns approvals, tracing, handoffs, and resume bookkeeping; the sandbox session
  owns commands, file changes, and environment isolation.
- That split matches OMA's architecture. It argues for integrating sandboxes as
  environment/tool substrates, not replacing OMA's managed-agent layer.
- Daytona, E2B, and Modal all provide isolated programmable sandboxes useful for
  agent tool execution. They are product-adjacent infrastructure, not the API
  layer that owns agents, sessions, events, policy, queues, and recovery.

Sources:

- https://openai.github.io/openai-agents-python/sandbox/guide/
- https://www.daytona.io/docs/en/sandboxes/
- https://e2b.dev/docs
- https://modal.com/docs/guide/sandboxes

## Backend Promotion Bar

A backend is not promoted until it can prove:

1. Spawn one isolated execution context per managed session.
2. Mount or materialize a durable per-session workspace.
3. Preserve managed session identity across process restart.
4. Reattach or correctly fail in-flight sessions after orchestrator restart.
5. Surface logs.
6. Support limited networking or fail capability checks loudly.
7. Preserve the public API without harness-specific or cloud-specific branches
   in the router.
8. Pass the `ContainerRuntime` contract plus a live restart/resume E2E.

## Next

Do not build ECS/Fargate/Cloud Run/Kubernetes yet.

The next practical backend work is:

- keep Docker as default;
- keep the runtime factory strict;
- add backend-contract documentation/tests only when a second backend is truly
  scheduled;
- evaluate agent sandboxes as an optional environment/tool execution substrate,
  not as the managed-agent runtime itself.
