# Recovery and troubleshooting

[Back to README](../README.md)

1. Run `/msb status` and `/msb logs`.
2. If the state is `unavailable (blocked)`, fix the displayed configuration,
   image, virtualization, or missing-tool error and run `/msb reload`.
3. If a process died, a later startup or `/msb prune` can remove its labelled
   sandbox after the owner lock is free. The named volume is retained.
4. If a same-name resource has different managed labels, pi-microsandbox refuses to
   attach or replace it. Remove only a verified managed, unmounted volume with
   `/msb volumes rm NAME --yes`.
5. On unsupported virtualization hosts, use `PI_MSB_DISABLE=1` for explicit host
   mode or configure `fallback_mode = "host"` knowingly. The latter remains
   visibly distinct from `/msb off`.
6. For bootstrap failures, use an image that already contains the required
   command list or allow the configured network policy to reach the package
   repositories. Deny mode cannot bootstrap an image missing those commands.

For installation prerequisites, see [installation and requirements](getting-started.md). To test a live sandbox from source, see the [live test matrix](development.md#live-test-matrix).
