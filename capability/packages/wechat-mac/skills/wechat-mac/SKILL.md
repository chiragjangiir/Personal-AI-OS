---
name: wechat-mac
description: 在现有 owner_mac 微信原语上提交不可变的发送批次及只读核对。
---

先读现有 wechat 技能，沿用它的缓存原语、稳定微信账号核实、精确标题与完整草稿检查、一次发送及 finally 恢复。平台不代替你观察界面，不使用云手机微信。权限弹窗由主人处理。

其中旧的 paios_effect_check 步骤由本包发送工具的网关接住；启用本包后直接提交发送批次，不再调用旧效果分类工具。

prepare 完成并恢复现场后，将实际 send 批次的完整 command 和稳定 recipient 一次交给 wechat_send_text、wechat_send_file 或 wechat_reply。批次保留原来的发送前检查和 finally，不把以后才决定的动作写进批次。owner_requested 只表示主人明确要求本次具体操作。

等待确认时继续独立工作，不提交第二份发送；批准后平台执行同一批次。结果未知先用 wechat_read_recent 或现有截图原语只读核对，不重复输入。
