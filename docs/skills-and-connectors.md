# 给依米增加能力 · Skills and connectors

每个人都应该有自己的依米：跑在自己的服务器上，用自己选择的模型和设备，帮自己办成日常的事。给她增加一项新本事，最小的有效贡献是一个能力包：让她用已有的能力多办成一件事，并交回一份可以核对的结果。

Everyone should have their own Yimi, running on their own host with the models and devices they choose. The smallest useful contribution is a capability package: it lets Yimi accomplish one more task with what already exists and return a result that can be checked.

## 能力包是什么 · What a capability package is

从 0.0.2 起，扩展的入口是 `capability/`。一个能力包遵循 Agent Plugins v1 格式：清单是 `plugin.json`，本项目的扩展字段写在其中的 `extensions["ai.yimi.capability"]`，声明兼容性、运行服务、允许的作用域、网络出口、工具、预发命令、测试和来源。分工很明确：Hermes 提供智能体运行时；身份、确认、任务状态和回执账本归平台服务所有。能力包是本项目在 Hermes 之上的一层，不改动上游。

Starting with 0.0.2, the extension point is `capability/`. A package uses the Agent Plugins v1 format plus this project's capability extension and receipts: its manifest is `plugin.json`, and `extensions["ai.yimi.capability"]` declares compatibility, the runtime server, allowed scopes, network egress, tools, staging commands, tests and provenance. Hermes provides the agent runtime; platform services own identity, consent, job state and the receipt ledger. Capability packages are this project's layer on top of Hermes, not a change to upstream.

## 包的入口 · Package entry points

- `capability/templates/yimi-capability-template/`：可移植模板，包含 `plugin.json`、`mcp.json`、技能、Python/TypeScript 服务、fake 服务与契约用例。
- `capability/contracts/README.md`：manifest、九类影响与六类回执事实的合同；`upstream/` 保留上游 Agent Plugins schema。
- `capability/sdk/python/yimi_receipt.py`、`capability/sdk/ts/receipt.ts`：生成结构化回执；结果使用 MCP `structuredContent`，不另建成功标记或报告通路。
- `capability/packages/ts-health/`：已有平台只读查询示例；`tests/contract.yaml` 使用合成数据。
- `capability/packages/mijia/`：独立进程运行的米家服务与回执适配；该组件采用 GPL-3.0-or-later，见根目录 NOTICE。
- `capability/packages/load.py`、`deploy/cloud/cloud.json` 的 `capability_packages`：现有加载器与启用配置；单机外设仍受对应环境开关控制。

The template is the starting point; the contracts README defines the manifest, the nine effect classes and the six receipt fact kinds; the Python and TypeScript SDKs build receipts returned as MCP `structuredContent`; `ts-health` is a read-only example with synthetic contract data; the Mi Home package runs as a separate GPL-3.0-or-later process (see NOTICE); `load.py` and `capability_packages` in `cloud.json` load and enable packages.

## 贡献范围 · Contribution scope

- 先检查 Hermes 原生能力、已有技能、MCP 和仓库内的包；已有能力可复用时不再复制执行器。
- Reuse existing skills, MCP servers and packages before adding an adapter. Keep one transformation responsibility within 200 lines.
- 新包放入 `capability/packages/<name>/`，技能放入包自己的 `skills/`，沿用模板的清单、fake 和契约检查。
- Put new capabilities in packages. Keep product logic outside the Hermes core and its native patch; retain the existing gateway, consent and receipt authorities.
- 影响类别、身份和授权来自合同与平台；包不自行增加类别、替换身份、记住授权或维护第二份任务状态。付款、首次发送确认和身份门禁的规则见 README 的[安全约定](../README.md#安全约定)；技能文本不能替代这些门禁。
- Effect classes, identity and authorization come from the contracts and the platform. A package does not add classes, substitute identity, remember consent or keep a second copy of job state. Payment, first-send consent and identity rules are in the README's [safety contract](../README.en.md#safety-contract); a skill's instructions cannot replace these gates.
- `secrets` 只声明环境变量名；源码、清单、测试和回执均不放真实密钥。用合成记录及本地 fake 验证，不连接真实账号或设备。
- `secrets` declares environment variable names only; no real keys in source, manifests, tests or receipts. Verify with synthetic records and local fakes, never real accounts or devices.
- 先按 [首次运行](first-run.md) 和 [测试说明](testing.md) 准备环境。通过已有契约测试后，再在隔离实例核对加载、结果回执和回退；不把离线 fake 的结果写成真实设备验收。
- Prepare with [first run](first-run.md) and [testing](testing.md). After the existing contract tests pass, check loading, receipts and rollback on an isolated instance; an offline fake result is not real-device acceptance.
