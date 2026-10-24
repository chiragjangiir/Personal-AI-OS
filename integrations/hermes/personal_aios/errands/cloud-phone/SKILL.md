---
name: cloud-phone
description: 启动云手机，给主人登录控制链接，按 App 恢复或保存登录数据，关闭云手机；处理 APP_LOGIN_REQUIRED。
version: 1.0.0
author: Personal AIOS
platforms: [macos, linux]
metadata:
  hermes:
    tags: [cloud-phone, login, errands]
    category: errands
---

# 云手机

这是依米的后台安卓执行手机，不是主人的 iPhone。只支持千问、淘宝、支付宝和米家。微信使用 wechat 技能和 Mac 微信，不在云手机安装、登录或恢复微信。

启动、恢复、保存和关闭都在后台执行。`started` 只表示已接受，最终结果通过 `tier=lifecycle` 的 `errand_result` 返回；用 `phone_status()` 查看进度。一次只派一个步骤，前一步完成后才派下一步，不连续等待或重复派发。`busy`、失败或超时按真实结果说明，不把空任务列表当成功。派出后按主技能的后台任务规则，用 `paios_open_reply(reply_mode="text")` 简短告诉主人正在做什么，不说还没发生的进展；通话里已告知就声明 `reply_mode="none"`。

主代理只交谈、判断和转达；本技能的调用、等待和进度查询都由原生异步后台子代理执行，派出后主代理结束本轮。子代理拿到控制链接就通过已有时间线和通知立即交给主人；到需要主人登录、选择或确认的步骤，交代当前结果和下一步后结束，不睡眠等回复。主人说「登录好了」后，主代理按本次明确的 App 再派保存子任务；保存成功后才说已保存，不把登录完成当作保存完成。

手机异步办事也遵守本节收尾规则。子代理拿到 `started` 后，摘要报告“已开始，job_id=X；结果将以 errand_result 返回”，X 来自真实收据；保留工具名和实际返回的 status、job_id。没有证据，不推断结果或首次确认仍待处理。需要知道结果时调用 `phone_status`：它只列同一主人的运行中任务和最近 600 秒的持久终态，按 job_id 核对 state、success、terminal_reason、answer、finished_at，并把这些真实字段带回摘要。空列表不证明成功、失败或确认仍待处理。确认决定与 errand_result 可以只到父会话，子会话没收到不能否定它们。首次确认在工具执行前完成，卡片和等待不出现在你的对话里；`phone_task`、`send_message` 和 `paios_effect_check` 的结果带 `approval` 时，就是服务器的确认记录，摘要原样带回 confirmation_id、choice、decided_at，以及 reused（true 是沿用同人同类此前的确认，本次没有新卡片）。结果没有 `approval` 只说明这类效果不需要确认，不要据此说没有确认门禁或没经过主人确认。

同一 job_id 的 errand_result 和 approval decision（含工具结果里的 `approval`）是权威记录。子代理摘要与它们冲突时，由后台查询 phone_status，按权威记录回答；once/resolved 不能说成缺首次确认，completed 不能建议重派。原生委派的 tool_trace 不包含工具结果原文，不能用其中的 ok 推断手机成功；汇报保留权威结果的实际范围，不把执行完成扩展成收件人已收到。

确认卡未答复时，仅这次后台工具执行等待主人，其他任务照常办理；不重复派同一动作，也不把等待当作工具层故障。主人同意后，原调用继续一次，不再重发原任务。`confirmation_denied` 是主人拒绝；`confirmation_cancelled` 是任务或会话结束，`confirmation_expired` 是未答复到期，均未开始执行，不能说成已发送或已完成。

## 登录和控制

先用 `phone_status()` 读取当前 provider。`provider=mac-android` 使用主人 Mac 上的常驻安卓：`phone_task` 会自动启动 stopped 或 starting 的设备，等到 running 后再办事；显式启动仍可用 `phone_start`，按真实状态说明进展；登录在 Mac 上完成，登录和数据保留在同一台设备上，不调用恢复、保存或关闭云会话。Mac 不可达时明确报告“Mac 不可达”；未安装或启动失败时按返回的真实状态说明，不改走云手机、不说已经开始办。状态就绪后直接用原 `phone_task` 执行办事，沿用付款、发送确认和结果核对规则。

主人要求登录，或办事返回 `APP_LOGIN_REQUIRED` 时：

1. 用当前主人上下文中的真实 `principal_id` 调用 `phone_start(principal_id=…, purpose="login")`。不猜主人身份。login 启动不恢复旧 App 数据，先让控制页面可用。
2. 用 `phone_status()` 查看启动进度；一旦链接可用，就用 `phone_control_link()` 取真实控制链接，立即通过回复发给主人，不等 App 准备完成。链接仅给主人，不发给别人，不写入技能或 memory。创建中就说明还在启动，不重复启动。
3. 需要旧登录时，在发出链接后用 `phone_restore_apps(principal_id=…, apps=["淘宝"])` 恢复本次需要的 App。等待这一恢复结果，再请主人在控制页确认或登录。不自动恢复全部 App，不在恢复期间登录或保存。
4. 验证码、扫码和登录确认由主人在控制页完成。主人确认具体 App 已登录后，用 `phone_save_apps(principal_id=…, apps=["淘宝"])` 只保存这些 App。恢复失败或未完成时不上传，不把未登录数据覆盖旧登录。保存结果成功后才说登录数据已保存。
5. 不再使用时调用 `phone_close(principal_id=…)`，释放云手机。关闭不会自动保存；需要保留登录时先完成保存，再关闭。就绪后控制会话最多保留 30 分钟，超时自动关闭，不自动保存。主人要求立即关闭时直接关闭，并如实说明未保存的数据没有保存。

不读取、转述或保存密码、验证码、会话文件或凭据。App 登录完成不表示原办事请求已完成。

## 慢步骤和失败

先查 `phone_status`，按实际阶段和已用时间告知主人。链接已经可用就先交给主人。根据错误换办法：没有有效登录的旧数据可以不恢复，改由主人重新登录；恢复失败留下部分数据时，先关闭，再新开不恢复旧数据的登录会话，不能直接保存该 App；某个 App 慢就先处理其他 App；云手机不可用时考虑主人已有设备。没有 phone_start、phone_task 工具时，如实说明执行手机当前未启用，不启动、登录或派单。先解决原因，不盲目重复相同调用，也不新建会话排在旧清理后面。主人要求关闭而步骤仍在执行时，用 `phone_cancel` 请求停止；后台清理完成后再关闭，不把 `stopping` 说成已经释放。

## 恢复办事

普通办事直接用已有 `phone_task`，由执行器启动并恢复办事数据。需要显式打开云手机时，可用 `phone_start(principal_id=…, purpose="errand")`；显式会话打开期间不能派 `phone_task`。先完成必要保存并关闭，收到关闭成功结果后，再派原来已授权的办事任务。沿用付款、发送确认和关键选择规则。未登录就回到登录流程。原操作结果未知时先只读核对，不重新下单、付款、叫车或发消息。

已验证的新用法通过 `skill_manage` 修改 `errands/cloud-phone`。只保存可复用方法、工具限制和验证结果，不保存主人身份、控制链接、登录数据或授权记录。Curator 使用同一原生技能记录维护它。
