# Contributing to Personal AI OS

[简体中文](CONTRIBUTING.zh-CN.md) · [Architecture](docs/architecture.md) · [Tests](docs/testing.md)

We want everyone to have their own personal assistant, Yimi (依米). The project started in October 2026. Version 0.0.1 contains the Linux server and the source for the iPhone, Apple Watch, Mac and Android glasses clients. Some capabilities need separately obtained vendor SDKs, model files or optional external services. Yimi's voice comes from Qwen's speech models. A passing public test suite shows correct behavior against local contracts and synthetic data; it does not show that anything was verified on real devices or in production.

## Get a working checkout

Fork the repository, clone your fork and create one branch per change. The [first-run guide](docs/first-run.md) is the reference for prerequisites, model configuration, local image builds and client dependencies. No prebuilt server images are published for 0.0.1.

Then read the [module map and reading order](docs/architecture.md) and run the tests for the module you plan to change, following [the testing guide](docs/testing.md). Public CI server tests use synthetic inputs and local stubs and need no model keys. Use a separate data directory for development, and never copy a real user's conversations, media, contacts or credentials into a fixture.

For a first contribution, pick a task from [good first issues](docs/good-first-issues.md). For a new skill or connector, read [skills and connectors](docs/skills-and-connectors.md). Report a reproducible defect with the bug template; propose a skill or connector with the proposal template. For a larger behavior change, open an issue first that says what the user needs to get done, which modules are involved and what "done" means.

## Match the code you touch

- **TypeScript** runs directly on Node 24 (Gateway requires 24.18 or newer, below 25; public CI uses 24.19.0). Keep ESM, explicit `.ts` imports, the strict compiler settings and the file's indentation. Nearby production code uses semicolons and small functions. There is no repository-wide formatter or lint gate; don't add one in passing.
- **Python** uses four-space indentation and `snake_case`, and reuses the existing `pytest` or `unittest` fixtures and dependency locks. Public CI uses Python 3.12. The phone executor has its own Python environment.
- **Swift and Kotlin** follow their module's conventions. Use the existing Swift packages, Xcode schemes and Gradle tasks, and don't reformat generated project files.
- **Validate at the boundary.** Check external input where it enters. Identity, consent, tool results and retries each have one authority. Surface failures explicitly; don't hide a contract mismatch behind a broad exception handler, a fake success or a guessed fallback.
- **Keep adapters thin.** A complete protocol or field adapter stays within 200 lines, counting related code together. If it grows past that, remove the duplication at its source. Business decisions stay in the module that owns them.

## Send a reviewable pull request

1. State the problem the user hit and the expected result. Link the issue if there is one.
2. One change per PR. If persisted data or a public contract changes, explain the migration and compatibility.
3. Run the affected tests from [the testing guide](docs/testing.md) and include the commands, results and anything skipped for missing prerequisites. A fix for a real behavior defect comes with a regression case. Text-only changes don't need a test that repeats the text.
4. Fill in the safety checklist in the PR template. Never include secrets, personal records, device identifiers or unredacted logs. Report vulnerabilities through [the private channel](SECURITY.md).
5. Tell the reviewer how to verify the change and how to undo it. A screenshot can explain a UI change but does not replace a behavior check.

Review covers the whole producer-to-consumer path, who owns what, how failures propagate and whether the safety contract holds. Expect requests to narrow the scope or reuse an existing module. After the author resolves substantive comments, a maintainer checks the final diff and the required CI before merging. Changes to identity, payment, sending or voiceprint gates need a reviewer who knows that boundary. Passing public CI does not authorize a release or a live external action. There is no promised review turnaround for 0.0.1.

Contributions are licensed under [Apache-2.0](LICENSE); third-party material keeps its own notices. There is **no CLA and no DCO**, and no sign-off is required. When you add a dependency or copied code, keep its license and attribution.

## Growing into a maintainer

These are criteria for starting a conversation, not automatic grants.

| Role | Track record | Access and how to ask |
| --- | --- | --- |
| Contributor | A focused PR with reproducible validation and active participation in review | Submit and review PRs through the public workflow. |
| Triage | At least 3 merged PRs in one module, 5 useful reviews or issue reproductions, and 4 weeks of sustained participation | Open a maintainer-role issue with the evidence. Maintainers review it and may grant triage access to label, reproduce and organize issues. |
| Module maintainer | Triage experience; at least 5 merged PRs including a behavior fix with a regression check; 5 substantive reviews showing you understand the module's contracts and safety boundaries | Two maintainers approve the scope; while there is only one maintainer, that maintainer records the decision explicitly. Any write access stays under branch protection: you review and merge within the agreed module and cannot bypass required checks. |

Maintainers record their scope and availability in the role issue. Sensitive changes still need an independent review. Access can be narrowed or removed for inactivity, a requested break, or a breach of the safety contract or the [Code of Conduct](CODE_OF_CONDUCT.md). Release and repository-administration rights need a separate recorded decision; merge rights do not include them.
