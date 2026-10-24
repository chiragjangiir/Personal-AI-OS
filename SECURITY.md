# Security policy · 安全报告

Personal-AI-OS lets people self-host their own personal assistant, Yimi (依米) while keeping their conversations, memory and tool permissions under their control. Security fixes target the current `0.0.x` release and the default branch; older snapshots do not receive a separate backport promise.

## Report privately

Open this repository's **Security → Advisories → Report a vulnerability** form. This creates a private GitHub vulnerability report shared with the repository's security maintainers. Do not file a public issue or PR containing an exploit, credentials or personal records. No personal email address is used for reports.

Include the affected version or commit, component, impact, prerequisites, minimal reproduction with synthetic data and any suggested mitigation. For identity, sending, voiceprint or payment defects, explain which gate can be bypassed. Remove tokens, account identifiers, conversations and media. If a secret has already leaked, revoke or rotate it through the service that issued it; do not paste it into the report.

If **Report a vulnerability** is unavailable, the repository administrator must enable private vulnerability reporting in repository settings. You may open a public issue containing only “Please enable private vulnerability reporting,” with no defect details. Keep the report private until the channel is available. The [GitHub guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) describes that setting.

Maintainers acknowledge and assess reports as capacity allows. They coordinate a fix and disclosure with the reporter through the private advisory, then publish a security advisory and affected/fixed versions when appropriate. There is no guaranteed response time or bounty program in 0.0.1. Test only systems and accounts you are authorized to use; use an isolated local environment for reproduction.

## Optional identity recovery and deployment privileges

The optional `owner-override` mode lets a paired user claim their identity when voiceprint recognition fails. A deployer first provisions the passphrase secret with `01-product-half-finished/backend/services/personal-aios-integration/tools/provision-owner-override.ts` and mounts it through `deploy/cloud/compose.owner-override.yaml`. Enabling the mode requires the passphrase and an authenticated paired device. It expires after 24 hours by default. While active, payments require the phone confirmation card; voice and small automatic payments are unavailable. See `src/owner-override.ts` and `src/payment/authority.ts` in the Integration package for the enforced contract.

The production and staging release watchdogs in `deploy/cloud/compose.yaml` mount `/var/run/docker.sock` so they can manage release containers. Access to this socket gives control of the host Docker daemon and is equivalent to root access on that host. Run the stack on a host you administer, and treat watchdog code and its mounted configuration as privileged deployment inputs.

The workshop container in `deploy/cloud/compose.yaml` has elevated capabilities, including `SYS_ADMIN` and `NET_ADMIN`, and uses `apparmor:unconfined` to create its sandbox namespaces, mounts and network rules. Its read-only filesystem and resource limits do not remove those privileges. Deploy it on a host you administer, keep its inputs controlled, and do not treat it as a host security boundary for untrusted code.

## 中文说明

Personal-AI-OS 让每个人都能部署自己的个人助理依米，同时让使用者掌握对话、记忆和工具权限。安全修复面向当前 `0.0.x` 版本与默认分支，暂不承诺为旧快照单独回补。

请在本仓库 **Security → Advisories → Report a vulnerability** 中提交私密报告。不要公开提交漏洞细节、凭据或个人记录。报告包含受影响版本、组件、影响、必要前提和使用合成数据的最小复现。涉及身份、发送、声纹或支付时，说明哪一道门禁被绕过。不要附带真实 token、对话、媒体或账号标识。

如果没有私密报告按钮，只公开提出“请启用 private vulnerability reporting”，不要描述漏洞。管理员启用后再私密提交。泄漏的秘密应向签发服务撤销或轮换，不要在报告里粘贴。维护者会在私密 advisory 中协作处理和协调披露。0.0.1 不承诺固定响应时限，也没有漏洞赏金计划。

可选的 `owner-override` 身份恢复模式用于声纹识别失败的情况。部署者先生成口令秘密，再通过 `deploy/cloud/compose.owner-override.yaml` 挂载。使用者必须从已认证的配对设备输入口令，模式默认在 24 小时后到期。开启期间只能用手机确认卡付款，语音付款和小额自动付款均不可用。

生产与预发的 release watchdog 挂载 Docker socket，用于管理发布容器。该权限等同于控制宿主机的 Docker daemon，也等同于宿主机 root 权限。应在自己管理的主机上运行，并将 watchdog 代码和挂载配置视为特权部署输入。

`deploy/cloud/compose.yaml` 中的工坊容器具有 `SYS_ADMIN`、`NET_ADMIN` 等提升权限，并设置 `apparmor:unconfined`，以创建沙箱所需的命名空间、挂载和网络规则。只读文件系统和资源限制不会消除这些权限。应在自己管理的主机上部署并控制输入，不要把它当作运行不可信代码时的宿主安全边界。
