Personal-AI-OS lets people self-host their own personal assistant, Yimi (依米). Explain the user-visible improvement. / 说明使用者会得到什么改善。

## Problem and result / 问题与结果

<!-- Link the issue. Give one before/after example. Describe the final change, its owning module and affected consumers. -->

## Verification / 验证

<!-- Exact commands and results. List skipped prerequisites. Distinguish local/stub checks from real-device or production acceptance. -->

## Safety checklist / 安全清单

- [ ] Payment authorization stays bound to the current request. Default confirmation uses the phone card; opt-in phone/glasses voice payment and small automatic payment keep their existing limits and checks. / 支付授权仍绑定本次请求。默认使用手机确认卡；可选的手机或眼镜语音支付、小额自动支付保留原有限额与校验。
- [ ] Send paths use server-owned first-send consent for the principal, recipient and task type; custom tools call the same authority, and unrequested sends always ask. / 发送路径使用服务端按使用者、收件人和任务类型保存的首次发送确认；自制工具调用同一权威接口，未请求的发送每次确认。
- [ ] Voiceprint, uncertain-speaker and guest gates remain enforced by the existing authorities. / 保留声纹、身份不确定和访客门禁。
- [ ] Source, fixtures and logs contain no secrets or real personal records. / 源码、夹具和日志没有秘密或真实个人记录。
- [ ] Results preserve lineage and distinguish accepted, partial, failed and completed work. / 保留来源，并分清接收、部分完成、失败与完成。
- [ ] Dependencies retain their licenses and notices. / 保留依赖许可与声明。

For an unaffected item, explain why in the description. / 不受影响的项目请说明理由。

## Rollout and rollback / 生效与回滚

<!-- Note configuration/data/compatibility changes and a concrete undo path. Do not include credentials. -->
