# 给依米增加技能或连接器 · Skills and connectors

Personal-AI-OS 让每个人都能部署自己的个人助理依米。最小的有效贡献，是让依米用已有能力完成一件新事情，并能核对结果。先按[首次运行指南](first-run.md)准备公开开发环境，使用合成数据和本地服务验证。0.0.1 的第三方 SDK、模型和账号不会随源码提供。

Personal-AI-OS lets people self-host their own personal assistant, Yimi (依米). Start with the smallest contribution that lets Yimi accomplish a useful task and verify its result. Follow [first run](first-run.md), then develop against synthetic data and local services. Third-party SDKs, model assets and accounts are separate prerequisites in 0.0.1.

## 先选扩展位置 · Choose the existing extension point

| 需求 / Need | 位置 / Location | 实际加载方式 / Discovery |
| --- | --- | --- |
| 教助手组合已有工具 / Teach a workflow using existing tools | `integrations/hermes/personal_aios/errands/<name>/SKILL.md` | `deploy/cloud/hermes-init.py` adds `errands` and `shared-skills` to Hermes `skills.external_dirs`. |
| 可复用的工具制作方法 / Share an engineering method | `integrations/hermes/personal_aios/shared-skills/<name>/SKILL.md` | Same native skill discovery; do not copy private profile state into this directory. |
| 外部应用或 API / Connect an app or API | An MCP server, following `integrations/hermes/personal_aios/mijia.py`, or the existing `integrations/connectors/phone_executor/` | Explicit registration in `deploy/cloud/hermes-init.py`; use the existing phone app registry for phone apps. |
| 产品内工具 / Add a product-owned tool | Existing plugin registration in `integrations/hermes/personal_aios/__init__.py` and its owning module | Existing tool schema and execution gate; no second registry or permission store. |

先查看原生 Hermes、现有 MCP 和连接器能否直接完成工作。技能只教使用方法。需要新代码时，薄适配只转换协议或字段，完整职责最多 200 行。不要把重试、任务状态和授权再做一遍。

Check native Hermes, MCP and existing connectors before writing code. A skill teaches tool use. A protocol adapter translates the external interface and stays within 200 lines for its complete responsibility. Reuse the existing retry, job and consent authorities.

## 小例子一：只读回顾技能 · Example: a read-only recap skill

现有 `integrations/hermes/personal_aios/errands/memory-recap/SKILL.md` 的做法是：先限定请求范围，用现有检索工具查证据，再由当前主运行组织回复。它没有另起总结服务。下面是从这个做法提炼的小例子，适合放进 `errands/meeting-recap/SKILL.md`：

The existing `memory-recap/SKILL.md` bounds the request, retrieves source records and lets the current main run compose the reply. It creates no second summarization service. A small contribution using that pattern could be:

```markdown
---
name: meeting-recap
description: 按使用者指定的时间和主题，回顾已有谈话中的决定与待办。
---

先确认本次请求的时间与主题。用现有 session_search、paios_l3_query/inspect
或 paios_l5_locate/read 查找依据，按需要保留可回查的来源标识。
只总结记录支持的决定与待办。负责人、期限或说话人不明确时直接说明。
已经纠正、撤回或删除的断言不能当成当前事实。
通过本轮现有 paios_open_reply 合同回复。这个技能只读，不自动发送或另存摘要。
```

1. Add one folder with a unique frontmatter `name` and a clear `description`. Do not change the main persona to force discovery.
2. In an isolated development profile initialized by the normal setup, use native `skill_view('meeting-recap')` to verify discovery. `tests/hermes/test_skill_authority.py` shows the real loader and isolated profile fixture.
3. Exercise a request with synthetic records. Check cited sources and an ambiguous or absent fact. Do not invent an answer to make the demonstration succeed.
4. Include the skill, its useful behavior check and any licensed resources in the PR. Editing a skill file does not update an already running production process.

新增文件夹并给出唯一名称与清楚的描述。用现有原生加载器核验发现，不改人格来强迫加载。以合成记录验证来源和不确定情况。PR 包含技能、必要验证与资源许可。修改源码不等于已更新生产运行。

## 小例子二：米家只读查询 · Example: a read-only connector call

现有 `mijia.py` 的 `create_server(api, load_spec, data_root, call_log=None)` 接收真实 API 或测试 API。工具通过同一个 MCP server 注册。`tests/hermes/test_mijia.py` 使用 `staging/fake_mijia.py`，验证真正的 stdio MCP 客户端，而不接触真实家庭设备。

The Mijia connector injects its API into `create_server` and registers tools on one MCP server. `test_mijia.py` connects a real stdio MCP client to `staging/fake_mijia.py`. The small read path is:

`mijia.py` is GPL-3.0-or-later and runs as a separate MCP service. Study its interface and test pattern without copying its implementation into Apache-licensed files. Preserve the component's license and notices when modifying or redistributing it. See [NOTICE](../NOTICE).

`mijia.py` 采用 GPL-3.0-or-later，以独立 MCP 服务运行。可参考接口和测试方法，不把实现复制进 Apache 许可文件。修改或分发该组件时保留其许可与声明，见 [NOTICE](../NOTICE)。

```text
get_login_status()
  → refresh_devices()
  → read_device(device=<name returned by refresh>, home=<returned home>, room=<returned room>)
```

名称、家庭、房间和能力来自本次 `refresh_devices` 返回值，不从例子硬编码。登录未完成时先走现有扫码流程；等待扫码不算登录成功。只读查询可以作为新连接器的第一个闭环。

Use names and capabilities from the returned discovery data. Follow the existing login flow when required; waiting for a scan is not a successful login. A read-only query is a useful first end-to-end connector increment.

For another app, start with an issue describing its official interface, license, authentication and one useful read operation. Add its implementation beside the owning connector, or use an existing external MCP server. Register it explicitly in `hermes-init.py` and keep credentials in deployment configuration. Reuse the existing skill discovery for instructions. Add a fake external boundary that exercises the real wire/tool contract, including a failed authentication or transport result. Never call a real account from public CI. If a phone app is already supported, extend `phone_apps.py` or its app cards instead of adding a parallel phone executor.

新应用先说明接口、许可、认证和一个有用的只读操作。复用现有 MCP server 或在所属连接器旁实现，显式注册并从部署配置读取凭据。测试用假的外部边界跑真实工具合同，至少覆盖一条必要失败路径。公开 CI 不操作真实账号。已有手机应用应扩展注册表或应用卡片，不另造执行器。

## 每个贡献都要保留的合同 · Required safety contract

- **支付授权绑定本次请求。** 默认使用手机确认卡。使用者在手机启用语音支付后，可在手机或眼镜按已有声纹、身份、请求与金额条件确认；另行启用的小额自动支付保留熟悉收款方、单笔与当日限额及撤销窗口。两项设置默认关闭。旧收据、技能文本或模型推断不能代替所需授权。Mac、Watch 或后台任务不能替使用者确认付款。
- **首次发送确认。** 向他人发送时，按同一身份、稳定收件地址和任务类型复用服务端 `effectConsent`。新收件人或新任务类型重新确认；未请求的发送每次确认。所有发送途径共用这项权威。自制脚本或尚未接入门禁的工具先调用 `paios_effect_check`，只有 `allowed=true` 才执行。服务不可达或拒绝时停止发送。
- **声纹与身份门禁。** 复用 Integration 的 `admission.ts`、`voiceprint/` 和原生 run scope。保留身份不确定、访客与已验证身份的区别。技能或连接器不能放宽门禁，不能把声音簇当成使用者，也不能靠客户端字段升级身份。需要确认时走现有确认记录。
- **代码与日志中不放秘密。** API key、账号会话、登录二维码内部状态、联系人、个人媒体和设备凭据都留在配置或受控数据目录。例子用虚构数据。错误可以说明失败类型，不能输出 token 或原始认证载荷。
- **按事实报告。** `accepted`、排队、部分完成、失败与成功分开报告。保留结果、来源和确认标识；不把工具调用成功当成业务完成。米家的入口设备只读限制也适用于新工具与手机应用路径。

Payment authorization is bound to the current request. The default uses the phone confirmation card. Voice payment on the phone/glasses and small automatic payment must be enabled separately on the phone; both default off and retain their identity, request, payee, amount and undo-window checks. First-send consent is server-owned and scoped to principal, stable recipient and task type; unrequested sends always ask. Preserve uncertain-speaker and guest restrictions and existing voiceprint confirmation. Keep secrets and personal records out of source, fixtures and logs. Report actual outcomes and preserve their lineage. A skill's instructions cannot replace any of these enforcement gates.

Use the [existing test commands and skip inventory](testing.md). Changes to identity, payment, sends or tool result semantics need the corresponding existing regression tests and a reviewer familiar with that boundary. A stub verifies its covered contract; real-account and device acceptance remains a separate, explicitly authorized check.
