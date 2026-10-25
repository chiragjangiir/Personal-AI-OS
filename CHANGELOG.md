# Personal-AI-OS 0.0.2

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。这一版把依米会做的事整理成统一的能力包。

米家、手机任务、消息、微信、桌面、Mac 和内置工具都以能力包接入，每个包可以单独启用和回退（单机外设还需启用对应开关），确认和执行回执各走同一份合同。能力包是本项目在 Hermes 之上的一层，不改动上游。查找技能和 MCP 服务、检查包的合同、登记和回退，都在同一个工坊里完成。

模型设置只有一个权威来源：单机部署第一次启动时从 `.env` 导入主脑、视觉和工坊的配置，之后沿用已保存的设置和凭据，改动在客户端的“模型与密钥”页面进行。启动命令需要在 Linux 部署主机上以 root 身份执行，工坊使用独立的 1 GiB ext4 容量卷。模型用量分开记录输入、输出、缓存读取和缓存写入，用量或费用无法确认时保留估算或未知标记。

新版本启动时把 Hermes 原生核心记忆里已有的条目导入个人记忆。通过正式发布流程回退后，旧版本读取的是当前核心记忆资料的投影；重新升级只导入回退期间新增的条目；代码回退仍不撤销数据库变更或外部操作。

手机、手表和 Mac 的连接、音频与界面更新以源码交付，第三方 SDK 和模型资源需另行取得。保留社区贡献的 Mac 桌面模拟器指南和原生端测试的环境说明。项目继续采用 Apache-2.0；独立运行的米家 MCP 服务保留 GPL-3.0-or-later 许可，见 NOTICE。

Personal AI OS 0.0.2 organizes Yimi's capabilities into capability packages with shared consent and receipt contracts, each enabled and rolled back on its own (single-host peripherals also need their corresponding switches enabled); they are this project's layer on top of Hermes, not an upstream change. Brain, vision and workshop settings have one authority, imported from `.env` on first start. Existing Hermes native core memories are imported at release startup, and release rollback projects the current core memory profile. Third-party SDKs and model resources are obtained separately. See README for deployment requirements and LICENSE / NOTICE for licensing.

# Personal-AI-OS 0.0.1

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。未来，各自使用者的依米可以在授权范围内相互协商。

这个源码版本包含 Linux 容器服务端，以及手机、眼镜、手表和 Mac 客户端。服务端连接设备输入、实时通话、个人时间线、记忆、归档和工具执行。模型按角色配置；依米的声音来自 Qwen。

对外发送遵循同一收件人和同一任务类型的首次确认。支付授权绑定本次请求，默认使用手机确认卡；语音支付和小额自动支付需在手机单独启用，两项默认关闭，并保留各自的身份、金额与撤销条件。工具工坊提供隔离执行空间；发布工具支持版本回滚。回滚不撤销数据库变更或外部系统操作。

服务端以源码和 Compose 交付，在本机构建镜像；0.0.1 不发布 GHCR 镜像。iPhone、Mac、手表和眼镜均以源码与构建说明交付，0.0.1 不附带预编译客户端。部署与客户端资源要求见 README 和 docs/。第三方 SDK、模型和外部服务遵循各自许可与使用条件。项目采用 Apache License 2.0；文件与 NOTICE 标明的许可例外继续适用，包括独立运行的 GPL 米家 MCP 服务。

Personal AI OS is a self-hosted personal assistant across phone, glasses, watch, and Mac. Model roles are configuration; Qwen provides its voice. See README for deployment requirements and consent boundaries, and LICENSE / NOTICE for licensing.
