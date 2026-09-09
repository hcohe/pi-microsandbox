# List available development recipes without starting virtualization.
default:
    @just --list

# Measure repeated sandbox startup and enforce the boot-time regression limit.
test-boot-speed:
    @node --experimental-strip-types scripts/test-boot-speed.mjs
