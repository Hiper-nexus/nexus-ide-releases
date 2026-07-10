# Third-party notices

NexusIDE includes third-party software and data. The corresponding licenses
remain with their copyright holders.

## ORCA (stablyai/orca) — terminal reliability modules

Selected modules are adapted from
[`stablyai/orca`](https://github.com/stablyai/orca) at commit
`143c36e566483006fe54fa2716b019ec00599752`, licensed under the MIT License.

Copyright (c) 2026 Lovecast Inc.

The full MIT license text is included at `third_party/licenses/orca-MIT.txt`.
Per-file provenance (upstream URL, original path, SHA-256 of the original
file, Nexus destination path, and adaptation notes) is recorded in
`third_party/provenance/orca-143c36e.json`.

Adapted modules in this harvest:

- Renderer recovery circuit breaker
- Terminal stream protocol
- Terminal output scheduler

Every adapted source file carries an attribution header pointing at the pin
and license. Existing copyright notices inside copied code are preserved.

## JavaScript and native dependencies

The production dependency inventory and individual package licenses are
recorded in the CycloneDX SBOM shipped with every release. Package license
files remain present in their packaged npm modules when required by the
upstream package.
