# Repository scale

Session creation resolves immutable commit before `201`; resolution failure returns `400`. Memory development and PostgreSQL modes use the same pin. Profiling runs asynchronously. Poll `GET /api/sessions/:id/profile`; no separate profile SSE events. Retry failed or expired profiles with `POST` on that route; original commit stays pinned.

Local sources require Git repositories; committed subdirectories allowed. Files and nested `.gitignore` rules come from pinned Git objects. Dirty/untracked files, symlinks, submodules, or missing commits cannot silently replace pinned content. Moving HEAD leaves Session evidence unchanged. GitHub reads commit trees and blobs, not branch-scoped code search.

## Profiles and scope

Repository Profiles record discoverable file/byte counts, language counts, nested package manifests, generated/vendor roots, completeness, tier. Ignored files and credential paths stay excluded. Truncated trees or exhausted file/byte/time budgets produce `partial`: lower-bound counts, never proof of a small repository. Configure limits through `SPECVOICE_PROFILE_*` in the environment example.

| Profile                            | Build rule                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Complete small                     | No Scope Plan required; an existing proposed plan still requires confirmation.   |
| Mid, large, very-large             | Explicit, confirmed scope required.                                              |
| Partial, any tier                  | Explicit, confirmed scope required, even when the lower-bound count looks small. |
| Pending, indexing, failed, expired | Discovery and Builds wait; failed profiles can be retried.                       |

After profiling, bounded voice discovery can precede scope confirmation. Dashboard shows commit, completeness, errors, package roots. Edit included/excluded paths, save proposal, then confirm. Unsaved edits cannot confirm an older displayed plan. Every saved scope change needs renewed confirmation.

Scope entries: literal repository-relative file or directory paths. Empty includes permit whole discoverable repository only for complete small profiles. Exclusions win. Reject absolute paths, traversal, empty path components, trailing slashes, backslashes, pattern syntax (`*`, `?`, brackets, `!`, `:`, `#`). `.git` and `.env*` stay inaccessible.

Confirmation re-inventories selected scope server-side; ignores client estimates. Scope must be nonempty and fully enumerable within profile limits. Confirmed scope binds to pinned commit. Accepted Build Attempt freezes scope and generation inputs.

## Work limits and publication

Operations enforce scope before descendant traversal, reads, search. Discovery defaults: 100 files, 5 MiB, 10 seconds per operation; directory traversal also bounded. Reads display at most 4000 characters. Search counts only permitted results. Listing/search retain `files`/`results`, adding `complete` and optional `stopReason`. Ignore-rule reads consume local byte budget; partial listings can contain fewer bytes than the configured ceiling.

Sparse checkout reduces build work. Before push, worker checks every generated commit's ancestry and changed paths: deletions, both rename endpoints, even reverted changes. Publishes only validated commit. See [Build pipeline](./build-pipeline.md) for recovery.

Limits bound operations; they do not establish throughput on very large production repositories. Source-host latency, repository structure, rate limits, disk capacity still matter. Submodules and Git LFS hydration remain unsupported.

## Measured local benchmark

`npm run bench:repositories` repeats synthetic Git-object inventory and scoped search. Local run on 2026-10-13 inventoried 100,000 files completely; 100,001 stopped at 100,000-file cap and remained partial. Fixture: tiny text files across 101 packages on a development host. Artifact records timings and process memory. Concurrent Docker builds affect results; no production SLA implied.

Package counts accumulate directory ancestry; no per-manifest listing rescan. CPU aggregation checks cancellation and profiling deadline. Very-large or partial repositories remain usable through explicitly bounded Scope Plans; no whole-repository Build acceptance implied. Build export and toolchain limits are stricter than profile inventory limits. See [Claude execution](agents/claude-code.md).
