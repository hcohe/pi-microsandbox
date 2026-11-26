# Google Cloud: admin at home, reader in the sandbox

[Back to README](../README.md) · [Agent recipes](agent-recipes.md) · [Images](images.md)

You have admin access on your host. Your agent should be able to look around
Google Cloud—not rearrange the furniture. Let's give it a separate identity.

The trick: **a dedicated service account + a short-lived impersonated token**.
Your host mints the token; Microsandbox substitutes it into approved outbound
requests. The guest gets a placeholder, not your admin login or a downloaded key.
Google IAM—not the agent's promise to behave—decides which operations are allowed.

This example grants **Compute Viewer in one project**, not universal read access
to every Google Cloud service. It demonstrates a successful VM read and a denied
label write. Outputs below describe expected results, not a recorded live run.

## Before the robot gets its visitor badge

You'll need:

- `gcloud` on the host, already signed in as the administrator you intend to use.
- A **newly built cloud-tools image** selected for the sandbox. This branch adds
  gcloud, AWS CLI, and curl to the shared base; an already-published tag or the
  package's existing digest-pinned image won't change retroactively.
  [Build and select the new image →](images.md#cloud-clis-from-this-branch)
- A test project with the IAM, IAM Service Account Credentials, and Compute
  Engine APIs already enabled. If an API is missing, obtain separate human
  approval to enable it; don't auto-enable APIs while troubleshooting.
- Permission on the host to create a service account, grant its project role,
  and authorize your own impersonation of that account.
- An **existing disposable VM**, its exact name and zone, and approval for a
  harmless test label if something is misconfigured. Do not use a production VM.

Replace `YOUR_PROJECT_ID`, `you@example.com`, `TEST_VM`, and `TEST_ZONE` below
with reviewed values. Keep the same project throughout.

Ask your agent:

> Help me give this sandbox read-only Compute access to YOUR_PROJECT_ID using a
> dedicated service account. Validate each gcloud leaf with local help first.
> Show me the exact host IAM changes and ask before each mutation; I will run
> them from a trusted host terminal or separately approve each host command.
> Don't copy my gcloud config, mint keys, print tokens, or sign in inside the VM.
> Then propose Project-scoped sandbox settings for my approval. Test a read and,
> only after my separate approval, a label write on TEST_VM in TEST_ZONE.

## Review the commands before changing cloud IAM

### Step 1: Syntax Validation via `gcloud help <leaf_command>`

Help is local; these commands don't change cloud resources. Check the installed
CLI before using the corresponding examples:

```sh
gcloud help iam service-accounts create
gcloud help projects add-iam-policy-binding
gcloud help iam service-accounts add-iam-policy-binding
gcloud help auth print-access-token
gcloud help compute instances describe
gcloud help compute instances add-labels
```

### Step 2: Parameter Verification

Confirm the authenticated host principal, project, service-account email, test
VM/zone, and exact role. Check existing/inherited grants too: IAM permissions are
additive, so another binding must not give the new service account write access.
Verify required flags and whether each installed leaf supports `--dry-run` or
`--validate-only`.

### Step 3: Dry-Run Command Proposal

The leaves used here do not offer `--dry-run`/`--validate-only` in the checked
help. These are real changes, not simulated ones. If your installed version adds
such a flag, preview with it before applying. Otherwise review the explicit
project, member, role, and scope with the human before proceeding.

### Step 4: Command Proposal & Authorization

**IAM mutations must never run autonomously.** Get explicit approval for each
host-side command below. Approval to configure sandbox settings is separate from
approval to change cloud IAM. Never turn off the sandbox or grant blanket host
execution merely to run this setup.

## On the host: create the reader, not another admin

First, create a fresh service account:

```sh
gcloud iam service-accounts create pi-agent-compute-reader \
  --project=YOUR_PROJECT_ID \
  --account=you@example.com \
  --display-name="Pi agent compute reader" \
  --quiet
```

Give **that service account** Compute Viewer in the chosen project:

```sh
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --project=YOUR_PROJECT_ID \
  --account=you@example.com \
  --member="serviceAccount:pi-agent-compute-reader@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/compute.viewer \
  --condition=None \
  --format=none \
  --quiet
```

Allow **your host user** to mint short-lived tokens for **only that account**:

```sh
gcloud iam service-accounts add-iam-policy-binding \
  pi-agent-compute-reader@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --project=YOUR_PROJECT_ID \
  --account=you@example.com \
  --member="user:you@example.com" \
  --role=roles/iam.serviceAccountTokenCreator \
  --condition=None \
  --format=none \
  --quiet
```

Token Creator belongs to the host principal on this one service account, not to
the sandbox account or the entire project. `Service Account User` is not the
same permission. Do not create a service-account key. IAM changes can take time
to propagate; wait for the intended grants rather than adding broader roles.

## With the agent: wire up the secret source

> Inspect scopes, credentials, mounts, and host bypasses first. Propose one
> Project-scoped batch: source CLOUDSDK_AUTH_ACCESS_TOKEN from the exact host
> impersonation command below; scope substitution to compute.googleapis.com;
> set network mode to allowlist with only that exact API host and DNS enabled.
> Keep fallback blocked, explicit host execution disabled, third-party tools
> blocked, and pass-throughs empty. Explain list replacement and restart impact.
> Don't mount host cloud configuration or forward admin credential variables.
> After approval, verify the desired and adopted policy; don't assume a save
> means the VM activated it. Flag any higher Session override hiding the result.

After replacing the placeholders, the agent can propose:

```json
{"scope":"project","operations":[
  {"path":"secrets","operation":"upsert","value":{
    "env":"CLOUDSDK_AUTH_ACCESS_TOKEN",
    "hostCmd":"gcloud auth print-access-token --account=you@example.com --impersonate-service-account=pi-agent-compute-reader@YOUR_PROJECT_ID.iam.gserviceaccount.com --project=YOUR_PROJECT_ID --quiet",
    "allowHosts":["compute.googleapis.com"]
  }},
  {"path":"network.mode","operation":"set","value":"allowlist"},
  {"path":"network.allow_hosts","operation":"set","value":["compute.googleapis.com"]},
  {"path":"network.allow_dns","operation":"set","value":true},
  {"path":"fallback_mode","operation":"set","value":"block"},
  {"path":"allow_host_execution","operation":"set","value":false},
  {"path":"block_third_party","operation":"set","value":true},
  {"path":"pass_through_tools","operation":"set","value":[]}
]}
```

This intentionally replaces the Project network-host and pass-through lists.
The secret upsert preserves unrelated secret entries. Audit those entries and
mounts separately: an existing admin credential in cwd, another forwarded
variable, or another secret is still access. Don't blindly clear unrelated
configuration, and don't mistake higher-layer shadowing for active restriction.

**Review the host command carefully.** It executes as your host user during VM
creation/recreation, within the extension's 10-second deadline. It returns the
restricted account's OAuth access token—not your administrator's token—to the
host-side secret handler. Never run it in a chat-visible terminal just to show
its output. Inspection and saving don't execute it; activation may.

`CLOUDSDK_AUTH_ACCESS_TOKEN` is the gcloud CLI's supported bearer-token override.
No guest login, ADC file, or host `~/.config/gcloud` mount is needed. If your
host's gcloud isn't on Pi's PATH, use its trusted absolute path in `hostCmd`.

Network access and secret substitution are separate controls. Both target
`compute.googleapis.com` here; network domain rules are DNS/IP-based, not URL
permissions. The new image points gcloud at the runtime system CA bundle with
`CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=/etc/ssl/certs/ca-certificates.crt`, so it can
trust Microsandbox's injected CA instead of only its bundled certifi roots.
For a custom image, configure that trust explicitly and confirm the runtime CA
was installed. Keep TLS verification enabled; do not widen to `open` or disable
certificate checks to work around a failure.

## Inside the sandbox: read succeeds

Ask the agent to run this through ordinary **sandbox Bash**, with no
`execution_target = "host"` and no impersonation command inside the guest:

```sh
gcloud compute instances describe TEST_VM \
  --project=YOUR_PROJECT_ID \
  --zone=TEST_ZONE \
  --format="value(name)" \
  --quiet
```

**Expected:** the chosen VM's name and exit code 0. Read an existing resource;
an empty list proves less. Compute Viewer covers Compute get/list operations,
not the data stored on disks or universal access across Google Cloud.

## Inside the sandbox: write gets bounced

Get **separate explicit approval** for this label attempt on the disposable VM.
Choose a label key not already present: a no-op may skip the write request.
If permissions are accidentally broader, this command can really add the label.

```sh
gcloud compute instances add-labels TEST_VM \
  --project=YOUR_PROJECT_ID \
  --zone=TEST_ZONE \
  --labels=pi-agent-write-probe=denied \
  --quiet
```

**Expected:** a nonzero exit and a Google IAM denial naming
`compute.instances.setLabels`. The CLI preserves other labels; do not replace
the whole label set to run a probe.

That's the satisfying failure: the same credential can read the VM, but Google
won't authorize the write. An expired token, missing API, missing VM, network
block, TLS error, or arbitrary nonzero exit **isn't evidence of read-only IAM**.
If the write succeeds, stop, audit additive grants, and obtain host-side human
approval to remove only the test label. Do not continue as though the test passed.

## The badge expires. That's on purpose.

Access tokens normally last about an hour. This integration resolves `hostCmd`
on VM creation/recreation; it doesn't refresh a running VM's token automatically.
A plain settings reload or no-op may reuse the VM and not renew it. Plan for
explicit VM recreation before expiry, accepting loss of guest-local state—not
by copying a refresh token, key, or admin profile into the guest.

When finished, have the host administrator review and explicitly approve removal
of unneeded sandbox configuration, impersonation grants, and the dedicated
service account. Already-issued tokens may remain usable until expiry; removing
a secret from settings is not an immediate token-revocation guarantee.

### Why this works

- [Service-account impersonation](https://docs.cloud.google.com/docs/authentication/use-service-account-impersonation)
  separates the host caller from the restricted identity.
- [gcloud access-token authentication](https://docs.cloud.google.com/sdk/docs/authorizing)
  supports the environment override without a guest login.
- [Compute Viewer permissions](https://docs.cloud.google.com/iam/docs/roles-permissions/compute)
  allow reads but omit the [setLabels write permission](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/setLabels).

No live cloud resources, IAM policies, or credentials were changed to write this
example. Validate it in your own approved test project before relying on it.
