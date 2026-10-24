---
name: memory-recap
description: 按主人请求回顾已有记录中的重点、约定、待办与谁说了什么；使用当前主 Agent 与现有检索工具。
---

主人要回顾今天、一次谈话或一段观察时，按问题需要查现有记录。
有来源的 observation、paios_ambient_journal_search、paios_l3_query/inspect、原生 session_search、paios_l5_locate/read 都可使用；不强制按层顺序，不建立第二条总结流水线。

1. 先限定主人请求的时间、事件、参与者和用途。按需定位原件。保留 event_id、processed_event_id、segment_id、raw_ref、archive_revision、time_range；原生消息存在时才引用 native_message_id。
2. 区分主人、已知人物、speaker_cluster 和 unknown_subject。声音簇不自动等于主人或已知人物。说话人不确定时直接说不确定。
3. 只据来源总结重点、明确约定、未决问题和后续事项。每项保留谁说的、发生时间与可回查来源。待办的负责人、期限或双方同意缺失时说明，不自行补齐。
4. 不对他人的表情、声音特点、诚实程度、性格或道德作分析；不从一次谈话建立持久人物画像。保留原话与业务事实，不把推测写成事实。
5. 旧历史记录的是当时的内容。有 assertion 引用时，按需用 paios_l3_inspect 查当前 head 与停止原因。已纠正、撤销或删除的结论不得当当前事实。普通纠正保留历史，不声称已彻底遗忘。
6. 回顾请求不要求另存一份摘要。主 Agent 判断哪些内容值得保留，并按现有作用域与授权，用 paios_l3_commit 写有来源的断言；稳定重点使用原生 memory 写 L2。最终回复由本轮主 Agent 生成，按已有 paios_open_reply 合同回传。向他人分享回顾时，所有发送途径共用服务器 effectConsent，同一主人、稳定收件地址和任务类型首次确认，新会话也沿用。phone_task、send_message（含邮件）由代码门禁检查；自制工具、脚本和未接入门禁的 Mac 发送先调用 paios_effect_check(effect)，仅 allowed=true 才发送。requested=false 每次确认；拒绝或服务不可达就停止。不把发送确认记到原生 memory，也不扩大授权范围。

严格遗忘不能在受影响的运行里完成。先明确授权、范围和保留规则，再停止并排空相关运行。由受控管理路径按策略处理 L3/L5，保留实际 MEM 收据，清理明确选择的 L2 项、原生 L4 会话与派生缓存，重启并使用干净上下文。native_forget.py 处理停止后的原生投影；它报告未核验的备份、原件等剩余范围。paios_l3_forget 的提交收据只证明其声明的 L3 范围。未完成全部范围的验证，不承诺全系统彻底遗忘。
