---
name: local-tools
description: 主人要求在设备上办事时，先查带日期的能力库存，再选择现有应用接口、技能、本地或公司 AI、GUI；没有合适能力才构建。
---

# 用已有能力办成事

先理解主人要的结果、资料在哪里、要交付什么、哪些动作已获授权。主代理读取本技能并交代目标；库存探测和实际执行由现有异步执行子代理完成，沿工程手册分工，不递归委派。适用于 Mac、云手机、工坊和以后接入的设备，不按任务名硬编码应用路由。微信仍只用 Mac，不转派云手机。

## 每设备的带日期库存

每次动作前读取当前 profile 原生 `memory` 中该设备唯一的带日期库存（以设备标识区分），不为每个任务另建。记录采集日期、系统与版本、可用应用/CLI/技能/工具/本地与公司 AI、最近验证日期和限制。完整列表过长时，用普通自有技能的支持文件保存明细，例如 `skill_manage` 写入 `device-capabilities/references/<设备标识>.md`，memory 只保存该库存的日期、摘要与路径，刷新时更新同一份。库存只是发现缓存，不是第二份工具注册表或授权记录；不写产品技能目录或配置，不记录密钥、聊天内容或登录凭据。

同一设备库存每周刷新；应用安装或升级、连接变化、工具失效时立即刷新受影响项。首次没有库存就探测并保存。库存未过期时只核实本次要用的入口和权限，不重复全量扫描。设备离线或无法探测就记未知，缓存不能证明现在在线、已登录或操作成功。

| 设备 | 在已有授权连接上采集 |
| --- | --- |
| Mac | 用 `mdfind 'kMDItemContentType == "com.apple.application-bundle"'` 查应用 bundle，读取相关应用版本和入口；用 `command -v` 查候选 CLI；用 `shortcuts list` 列快捷指令；查已连接技能/MCP/tools、本地 agent 的帮助与能力。Spotlight 无结果时只查相关安装目录，不据此断言未安装。 |
| 云手机 | 由现有 phone executor／超级代理在自身权限内用 `pm list packages` 查应用，核对超级代理实际支持的操作、登录和权限；没有 shell 接口就用现有能力查询，不假造包列表或另建 adb 连接。 |
| 工坊 | 查当前 profile 的 `skills_list`、`skill_view`、MCP 和工具 schema、可用 CLI；区分联网构建能力与可接触主人资料的执行环境。 |
| 新设备 | 用该设备现有发现入口核对同类能力和连接，再保存独立库存；不能从另一台设备推定能力。 |

## 挑最快可用的路径

在能完成结果、保护资料和遵守授权的前提下比较时间、精度与成本。优先级是可调整的选择依据，不要求逐个尝试失败才换路。

1. 已有技能和应用自己的接口：读取实际 `sdef`、URL scheme、CLI 帮助、Shortcuts 或已连接 MCP 的合同。只用已确认的接口；应用存在不等于支持脚本。
2. 已有应用 helper：核对本机版本、接口和当前权限，优先复用已经验证的短动作；微信用 wechat 的缓存 helper。没有验证过的候选先核对，不另写截图或点击程序。
3. 已配置的本地 AI：处理主人要求的其他任务时，库存确认可用后，可通过 `codex exec`、`opencode run`、`claude -p` 交代目标、允许读写的路径和验收结果；参数以本机版本帮助为准。不得命令这些 agent 代做微信步骤，也不得用它们测试或证明依米自己的能力。它们在本机运行不代表推理或数据留在本机，先核对提供方和资料边界。不能把工坊中“不调用 Codex/OpenCode”的 builder 合同改成本地代理执行。
4. GUI：接口和 helper 不适合时，读 `owner-mac-computer-use`，使用依米自己的原生 `computer_use`。微信也可沿自己的 helper 截图、`owner_mac.fetch` 和 `vision_analyze` 路径；观察、截图和操作均不交给 Codex、OpenCode、Claude Code 或其他 agent。driver 必须实际安装在目标 Mac 并已获权限；安装和配置不证明 Computer Use 已可用。
5. 没有适合的现成能力，才按 `engineering-handbook` 查 hub/registry 并构建或适配，验证后保存复用方法。

本地 AI 的文字自报不证明完成。核对实际工具记录、文件内容、应用状态或可见结果，再把证据交回主代理，沿共享结果事实回报主人。Codex 如使用主人账号的额度，执行前说明会占用额度，结果中如实报告已知用量；没有用量收据就说明无法核实，不编数、不换账号或改模型配置。

## 选择示例

这些示例说明如何选择，不是固定路由，也不证明当前设备已安装或已登录。

- 纸杯建模：库存有 Mac Rhino 8 时，先核对尺寸、模型和导出格式，优先用它的脚本能力。官方确认 Rhino **8.11 起**有 `/Applications/Rhino 8.app/Contents/Resources/bin/rhinocode`；连接运行实例需要先在 Rhino 执行 `StartScriptServer`。核对实际安装路径、版本和帮助，再选 `list`／`script <脚本绝对路径>`；修改启动设置另需授权。较早版本可核对 `ScriptEditor` 或其他已验证入口，不能套用 Windows 的 `Rhino.exe /runscript`。见 [RhinoCode 官方 CLI](https://developer.rhino3d.com/guides/scripting/advanced-cli/) 和 [Rhino 8 脚本能力](https://www.rhino3d.com/en/features/developer/scripting/)。
- WPS 文档或表格：先读已有 Office 修改方法，判断现有文件库、WPS 自身接口或本地 AI 哪个能准确保留原内容和格式；需要 WPS GUI 时再操作，验证保存后的文档或工作簿。
- 微信：先读 `wechat`，由依米用自己的模型与 Mac 缓存 helper 操作；AX 内容不足时，用自己的截图 helper、`owner_mac.fetch` 和 `vision_analyze` 观察后继续。不得命令 Codex、OpenCode、Claude Code 或其他 agent 代做微信步骤，不得转派云手机；发送仍经过同一门禁。
- 钉钉／飞书：库存确认有公司 AI、账号已登录且本次资料允许交给它时，可在该入口处理公司资料，再将真实结果转述主人；不能把资料带到隔离联网工坊，也不能把“已提交”说成“已处理”。向同事发消息仍是对外发送。
- 播电视剧：库存确认腾讯视频（QQLive）可用时比较其真实入口与浏览器播放，选择最快可行路径；核对目标剧集和实际播放状态。遇到付费、订阅或会员购买就停止付款步骤。

## 动作边界

无论实际执行者是应用 helper、脚本、本地 AI、公司 AI 还是 GUI，向人发送前必须经过原生 `paios_effect_check(effect)` 且 `allowed=true`。已由原生 hook 检查的发送沿用同一门禁；自制和本地 agent 路径在实际 send 前显式检查，不等发送后补。使用真实稳定收件地址和任务类型；拒绝、超时、服务不可达就停，不换执行者绕过。不能先授予本地 agent 无限制发送权限，再相信它自报已检查。

这些路径不执行付款、不代主人确认；付款申请沿原生付款流程由主人在手机或眼镜确认。不得读取 secrets、改认证或模型配置来使工具可用；只使用当前连接和权限。保存已验证的方法或候选 patch 后，再按工程手册清理自己创建的临时目录。
