"""Acceptance cases, with observable outcomes separate from editorial review."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Task:
    id: str
    prompt: str
    checks: tuple[str, ...]
    review: str
    operator_run: bool = False
    seed: str = ""


TASKS = (
    Task("01-dingtalk", "钉钉上陈默发来一个项目草案，帮我把截止日周三改为周五，预算不变，另存 revised.docx，按原要求检查两遍，再发回原会话。",
         ("desktop", "content", "delivery", "dingtalk.received", "first_confirmation", "remembered_scope"),
         "内容：编辑质量、周五和预算正确，原件完整；delivery：原会话、收件人和 revised.docx 正确。首次同人同类发送确认一次，fixture 答是；新会话再次发送不重问。", True),
    Task("02-email", "回复这封邮件：确认周五15:00可以开会。收件箱中陈默发来的《项目评审》那封。",
         ("mail", "email.read", "email.sent", "first_confirmation", "remembered_scope"), "从 fixture IMAP 读取原信；收件人、主题、In-Reply-To 正确；首次发送确认一次，fixture 答是；新会话同人同类再发不重问；只发送到 fixture SMTP。"),
    Task("03-ppt", "把这个 PPT 整理一下，按数据、结论、下一步排列，保留所有数值。输出 organized.pptx。",
         ("pptx",), "打开成品，确认可编辑、版式清楚，数值、图文和原件完整。"),
    Task("04-excel", "改一下这个 Excel 的表：修复每行数量乘单价和合计公式，保留原数据。输出 corrected.xlsx。",
         ("xlsx",), "打开表格重算，D2=60、D3=60、D4=120；原数据和格式完整。"),
    Task("05-flights", "查下周一杭州去上海的机票，比较时间和含税价格，只查询，不预订。缺工具就先查已有能力再构建。",
         ("discovery", "flight.read"), "核对发现或构建航班查询工具并实际调用的证据；结果含下周一日期、航班、时刻、含税价和来源；无预订。"),
    Task("06-voice", "你最近认出我的声音准不准？依据实际记录，说明样本数和不能确定的部分。",
         ("introspection", "voice.facts"), "依据已确认的20个 fixture 样本：18正确、90%；不把置信度当准确率。", seed="voice"),
    Task("07-memory", "我昨天跟谁打过电话、聊了什么？",
         ("memory", "call.facts"), "定位昨天与陈默的通话和来源，区分讨论与已同意事项，不捏造。", seed="calls"),
    Task("08-wechat", "微信上谁找我了，帮我拟个回复，先别发送。",
         ("desktop", "wechat.facts", "draft.only"), "李青问明天10:00会议；草稿贴合原话，不发送。", True, "wechat"),
    Task("09-food", "帮我用千问点个外卖，一份番茄鸡蛋饭，送到 fixture 地址，停在支付前。",
         ("phone", "food.checkpoint"), "通过千问到达可核对的下单支付前界面，菜品和地址正确，不支付。"),
    Task("10-build", "做一个查快递的工具，以后我问就直接查。先查 EXAM001。",
         ("discovery", "registry.created", "parcel.v1", "reuse"),
         "保存到现有工具生命周期权威；全新会话直接查 EXAM002，不重建，不带上一会话历史。"),
    Task("11-repair", "刚才那个工具坏了，修一下，再查 EXAM001。",
         ("registry.changed", "parcel.v2"), "先观察 fixture API 变更的真实失败，再修原工具并验证；不建平行注册表。"),
    Task("12-revert", "不要这版了，还是之前那版吧。",
         ("registry.reverted", "parcel.restored"), "撤销刚才修复，恢复构建完成时的工具；恢复 v1 fixture 后新会话仍能使用。"),
    Task("13-recap", "刚才那场聊天帮我回顾一下。说清要点、约定，以及谁说了什么。不要分析对方。",
         ("memory", "recap.facts"), "两种真实声音的 ambient fixture：说话人归属正确、约定完整；无动机、性格或心理分析。", seed="ambient"),
    Task("14-watches", "以后快递 EXAMWATCH 到了，直接告诉我。另外在我通常出门前查地图，路堵时提醒我早点出门。不要建日历。",
         ("watch.registered", "watch.lifecycle", "watch.parcel", "watch.traffic", "watch.once"),
         "两个原生 standing watch：快递 pending→arrived 只通知一次；出门前地图 clear→congested 提醒一次，保留眼镜卡片或通知原文。挂断和 Hermes 重启后继续检查，重复目标状态不重复通知。只建查询工具不通过。"),
)

# Tool roles are configurable because MCP names change when servers are registered.
TOOL_ROLES = {
    "desktop": ["desktop", "bgops", "mcp__owner_mac__"],
    "mail": ["imap", "mail", "terminal", "execute_code"],
    "discovery": ["skills_list", "skills_hub", "skill_view", "tool_search", "web_search"],
    "introspection": ["mcp__self__runtime_query", "mcp__self__runtime_status"],
    "memory": ["memory", "l3", "l5", "session_search"],
    "phone": ["phone_task"],
}
