# Personal-AI-OS 0.0.1

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。未来，各自使用者的依米可以在授权范围内相互协商。

这个源码版本包含 Linux 容器服务端，以及手机、眼镜、手表和 Mac 客户端。服务端连接设备输入、实时通话、个人时间线、记忆、归档和工具执行。模型按角色配置；依米的声音来自 Qwen。

对外发送遵循同一收件人和同一任务类型的首次确认。支付授权绑定本次请求，默认使用手机确认卡；语音支付和小额自动支付需在手机单独启用，两项默认关闭，并保留各自的身份、金额与撤销条件。工具工坊提供隔离执行空间；发布工具支持版本回滚。回滚不撤销数据库变更或外部系统操作。

服务端以源码和 Compose 交付，在本机构建镜像；0.0.1 不发布 GHCR 镜像。iPhone、Mac、手表和眼镜均以源码与构建说明交付，0.0.1 不附带预编译客户端。部署与客户端资源要求见 README 和 docs/。第三方 SDK、模型和外部服务遵循各自许可与使用条件。项目采用 Apache License 2.0；文件与 NOTICE 标明的许可例外继续适用，包括独立运行的 GPL 米家 MCP 服务。

Personal AI OS is a self-hosted personal assistant across phone, glasses, watch, and Mac. Model roles are configuration; Qwen provides its voice. See README for deployment requirements and consent boundaries, and LICENSE / NOTICE for licensing.
