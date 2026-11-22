# Vaults & Mirrors

<!-- Outline scaffold — Phase 2+ fills full prose -->

How GAIA maps vaults 1-1 to local storage directories and tracks external folders safely via Vault Mirrors.

---

## Outline

- **1-1 Physical Vault Ownership**: Each item belongs to one owning vault (`assets/vaults/<storage_key>/` or custom storage root). Deleting a vault item deletes managed files inside the vault; external references stay untouched on disk.
- **Creating & Switching Vaults**: `Vault → Create vault` (storage root, preview loading: `quick`, `lazy`, `hidden`) and the active vault dropdown.
- **Vault Mirrors**:
  - `1-1 Reference` (`reference_1to1`): Tracks external files read-only in place (shown in italic) without copying until you run **Collect into vault**.
  - `Distill & Copy` (`distill_copy`): Flattens and copies new/updated files into `<vault_store>` with non-destructive `.NN` versioning.
- **Reconciling Disk Changes (`Check folder sync`)**: Resolving mirrored updates, renamed/relocated files, untracked files discovered on disk, and missing files.

---

**Index:** [GAIA Guide](./README.md) · **Next:** [Organizing & Playlists](./organizing-and-playlists.md)
