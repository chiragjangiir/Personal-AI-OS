---
name: code-batch-operation
description: 操作 Mac 文件、表格或应用时，记录意图与待办，合批执行无需中间观察的动作，并核对最终状态。
---

# 成批操作方法〔codebatch-v1〕

方法参考 OpenGCUA `maiui_code_agent.py:build_code_prompt` L46–161，commit [b753f4c](https://github.com/Tongyi-MAI/OpenGCUA/blob/b753f4c645b499e362d70303c23c26bd4ce24937/packages/harness/examples/osworld/maiui_code_agent.py#L46-L161)，Apache-2.0；只采用方法文字。

- 每次调用工具前，用一句话说明本步意图。先观察再操作，不猜未见过的控件、路径或数值。
- 开始前用原生 `todo` 保存本次待办，例如找文件、计算、写入、核对、交付和恢复现场。每项 `content` 用 `[pending]` / `[attempted]` / `[changed_unverified]` / `[claimed_verified]` / `[blocked]` 标明业务状态。原生 `status` 仍只使用工具支持的值，不把这些前缀传进它的枚举字段。
- 未执行记 pending；已经尝试记 attempted；发生改变但结果未核实记 changed_unverified；实际输出或画面证实目标后才记 claimed_verified，并记下证据；缺少前提或授权记 blocked。claimed_verified 是你的有据报告，不代替独立验收。
- 原技能允许执行脚本时，不依赖中间画面的一串动作写进同一个 `owner_mac.exec` 脚本，按顺序执行。读取、计算、写入和逐项核对可以在同一批；GUI 短动作也可合批。每个动作只打印下一步判断需要的简短结果。出错立即结束业务动作，进入原技能的 finally 收尾，并保留失败原因。只能使用原技能允许的入口，不因本方法扩大执行权限。
- 下一步必须看画面才能判断时，结束当前批次。只在这时把截图作为本批最后一个业务动作，再 fetch + vision 看一次。不能把依赖未见结果的动作放进同一批盲做。纯文件计算不为结束批次而截图。
- 一次看图把当前要确认的问题一起问完。看不清再用 region 放大，不重复截同一画面。截图只用于本次判断，按操作技能的私有目录和用后删除规则处理。
- 同一办法第一次失败后，检查原因并改变方法，不原样盲重试。发送、写入等效果不明时先只读对账，不重复产生效果。
- 报告成功前重读最终文件或界面，逐项核对主人要求。未核对的项保持 changed_unverified；部分完成或工具调用成功不能算全部完成。
- 本方法只改变动作的打包方式。原技能的首次发送确认、身份和草稿核对、付款、对账、系统权限、恢复现场等安全规则全部照旧。

### 修改已有 Office 文件

- 在原文件上增改，用能读写整个文件包的库：表格用 openpyxl，`load_workbook(原文件)`（`.xlsm` 加 `keep_vba=True`），再 `create_sheet`、写值、设 `number_format`，另存为输出文件；Word 用 python-docx。工坊已装好这两个库。
- 不手拼 zip，不自己新写或整份替换全局部件：`styles.xml`、theme、`workbook.xml`、sharedStrings、`[Content_Types].xml`。原包缺少某个全局部件时，交给库按 Excel 隐式默认值补齐。例如默认字体是 Calibri 11、family 2、主题色 1、scheme minor；只写字号和字体名，原有单元格的默认字体就被改了。
- 改之前先列原包部件。含 openpyxl 不保留的内容（形状、表单控件、切片器、数据验证或条件格式的扩展）时，先告诉主人哪些会丢，按他的选择处理，不静默丢失。
- 写完重新打开输出，对照原文件核对，并在报告里写明结果：
  - 原有每个 Sheet：每格的值、公式和解析后的样式（字体、填充、边框、数字格式）不变；
  - 工作簿默认字体和 Normal 样式与原文件一致；原包没有 `styles.xml` 时，与 Excel 隐式默认一致；
  - theme 与原文件逐字节相同，或原文件本来没有 theme；
  - `workbook.xml` 里的 Sheet 名称和顺序、定义名称、日期基准（date1904）不变，只多出新增的 Sheet；
  - 新增内容逐项正确。
  只比较原 Sheet 的 XML 不够，单元格样式依赖工作簿级部件。报告时分开列出逐字节相同、经库重写但语义相同、以及新增的部件。

### Mac 窗口后台代码批

经 `owner_mac.exec` 执行 `"$HOME/Library/Application Support/依米/desktop/owner-ssh/opengcua" /绝对路径/batch.py`，预算沿用该调用的 timeout（1–300 秒）。程序可写顶层 `await`，得到 `mac`、`session` 和 `output_dir`。每批先用 `mac.apps.get(...)` 与 `app.windows.list()/get(id)` 绑定已存在的唯一窗口，再观察该窗口，用同一观察的 AXNode 或图像 PointRef 执行动作，显式指定 `delivery="background"`。没有可靠的目标就停止；不启动或激活 App，不自动转前台。用 `await session.emit(...)` 交付树、回执或截图；图片写到 `output_dir`，打印出的路径经现有 `owner_mac.fetch` 取回，按需看图。核对实际文字和点击效果后再报告成功。每批重新绑定，不跨批复用窗口句柄、AX index 或 image ID；暂停、断线和结果未知时先只读核对，不重放，不开启自动重连。保持本技能既有授权边界：首次向某人发送某类任务仍须确认，付款逐次且仅在手机或眼镜确认；不改全局剪贴板；不触碰系统权限弹窗，任何允许、拒绝或关闭动作都交给主人。
