import SwiftUI

/// All payment outcomes come from the authority. The clock only renders the received duration.
struct YimiPaymentCard: View {
    @ObservedObject var payment: YimiPaymentModel
    let card: CentralPaymentCard
    var onDetails: (() -> Void)? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { clock in
            VStack(alignment: .leading, spacing: 16) {
                header
                if card.state.isTerminal {
                    terminal
                } else {
                    amount
                    details
                    status(at: clock.date)
                    if canDecide(at: clock.date) { actions }
                }
            }
            .padding(18)
            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Yimi.hair, lineWidth: 1))
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "creditcard").foregroundStyle(Yimi.ink2)
                VStack(alignment: .leading, spacing: 3) {
                    Text("付款确认").font(.headline).foregroundStyle(Yimi.ink)
                    Text("来自\(card.app)" + (card.state == .awaiting_owner ? " · 停在收银台，还没付" : ""))
                        .font(.caption).foregroundStyle(Yimi.ink2)
                }
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: 4)
                    headerStatus
                }
            }
            if dynamicTypeSize.isAccessibilitySize { headerStatus }
        }
    }

    private var headerStatus: some View {
        Text(payment.submitted.contains(card.payment_id) ? "已提交" : card.state.title)
            .font(.caption.weight(.semibold)).foregroundStyle(card.state == .paid ? Yimi.ok : Yimi.ink2)
    }

    private var amount: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("¥").font(.title3)
            Text(YimiPaymentText.amount(card.amount_fen)).font(.largeTitle.weight(.semibold)).monospacedDigit()
            Text("实付").font(.caption).foregroundStyle(Yimi.ink2)
        }.foregroundStyle(Yimi.ink)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider().overlay(Yimi.hair)
            detailRow("收款方", card.payee ?? "收银台未读到收款方")
            detailRow("商品", card.items.joined(separator: "\n"))
            if let delivery = card.delivery { detailRow("送到", delivery) }
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 6) {
                    Text(label).foregroundStyle(Yimi.ink2)
                    Text(value).foregroundStyle(Yimi.ink).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                HStack(alignment: .top, spacing: 16) {
                    Text(label).foregroundStyle(Yimi.ink2).frame(width: 48, alignment: .leading)
                    Text(value).foregroundStyle(Yimi.ink).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.font(.subheadline).fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func status(at date: Date) -> some View {
        if payment.submitted.contains(card.payment_id) {
            Text("决定已提交 · 等待服务器确认").font(.subheadline).foregroundStyle(Yimi.ink2)
        } else if card.state == .granted || card.state == .paying {
            Label("付款中 · 正在等待收银台结果", systemImage: "clock").font(.subheadline).foregroundStyle(Yimi.ink2)
        } else if card.state == .auto_pending {
            let seconds = remaining(card.auto_in_ms ?? 0, at: date)
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(Yimi.hair, lineWidth: 3)
                    Circle().trim(from: 0, to: min(1, CGFloat(seconds * 1000) / CGFloat(max(card.auto_in_ms ?? 1, 1))))
                        .stroke(Yimi.ink2, style: StrokeStyle(lineWidth: 3, lineCap: .round)).rotationEffect(.degrees(-90))
                    Text("\(seconds)").font(.headline).monospacedDigit()
                }.frame(width: 44, height: 44).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(seconds > 0 ? "\(seconds) 秒后自动付款" : "正在等待付款结果").font(.headline)
                    Text(seconds > 0 ? "凭你发起这件事那句话的声音 · 现在还可取消" : "请等待服务器确认，以收银台结果为准").font(.caption).foregroundStyle(Yimi.ink2)
                }
            }
        } else if card.state == .verifying {
            VStack(alignment: .leading, spacing: 4) {
                Text("正在核对两句话").font(.subheadline.weight(.medium))
                Text("发起这件事的那句 +「付吧」").font(.caption).foregroundStyle(Yimi.ink2)
            }
        } else {
            VStack(alignment: .leading, spacing: 9) {
                if let line = reasonLine { Text(line).font(.subheadline).foregroundStyle(Yimi.ink2) }
                if card.methods.voice.available {
                    Text("说「付吧」也行 · 或点下面的付款").font(.subheadline).foregroundStyle(Yimi.ink)
                }
                let seconds = remaining(card.expires_in_ms, at: date)
                Text(seconds > 0 ? "\(seconds / 60):\(String(format: "%02d", seconds % 60)) 内可确认 · 执行手机停在收银台等你" : "确认时间已到，等待服务器更新")
                    .font(.caption).foregroundStyle(Yimi.ink2).monospacedDigit()
            }
        }
    }

    private var reasonLine: String? {
        [card.notice?.reason, card.methods.voice.reason, card.methods.auto.reason].compactMap { reason in
            reason?.line(limitFen: card.notice?.limit_fen, usedFen: card.today_auto_used_fen,
                         budgetFen: card.notice?.limit_fen, newFen: card.notice?.amount_fen,
                         oldFen: card.notice?.previous_amount_fen, triesLeft: card.methods.voice.tries_left, terminal: "付款设备")
        }.first
    }

    private func remaining(_ milliseconds: Int, at date: Date) -> Int {
        max(0, Int(ceil((Double(milliseconds) / 1000) - max(0, date.timeIntervalSince(payment.receivedAt)))))
    }

    private func canDecide(at date: Date) -> Bool {
        [.awaiting_owner, .auto_pending, .verifying].contains(card.state)
            && remaining(card.expires_in_ms, at: date) > 0
    }

    private var actions: some View {
        actionLayout {
            Button(card.state == .verifying ? "取消这单" : "取消") { Task { await payment.decide(card, decision: "cancel") } }
                .buttonStyle(YimiPaymentActionStyle(primary: card.state == .auto_pending))
            if !payment.submitted.contains(card.payment_id) {
                Button(card.state == .auto_pending ? "现在付款" : "付款 ¥\(YimiPaymentText.amount(card.amount_fen))") {
                    Task { await payment.decide(card, decision: "pay") }
                }.buttonStyle(YimiPaymentActionStyle(primary: card.state != .auto_pending)).disabled(payment.busy)
            }
        }.disabled(!payment.available)
    }

    private var terminal: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(card.payee ?? card.app) · ¥\(YimiPaymentText.amount(card.amount_fen))").font(.subheadline.weight(.medium))
                Spacer(minLength: 4)
                if let onDetails {
                    Button("详情", action: onDetails).font(.subheadline).frame(minWidth: 44, minHeight: 44)
                }
            }
            Text(YimiPaymentText.result(card.state, orderCancel: card.result?.order_cancel))
                .font(.caption).foregroundStyle(Yimi.ink2)
            if card.state == .superseded, card.notice?.reason == .AMOUNT_CHANGED, let line = reasonLine {
                Text(line).font(.caption).foregroundStyle(Yimi.ink2)
            }
        }
    }

    private var actionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
    }
}

struct YimiPaymentSummaryRow: View {
    @ObservedObject var payment: YimiPaymentModel
    let onOpen: () -> Void
    var body: some View {
        if let card = payment.cards.first(where: { !$0.state.isTerminal }) {
            Button(action: onOpen) {
                HStack(spacing: 12) {
                    Image(systemName: "creditcard").foregroundStyle(Yimi.ink2)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(card.state.title) · ¥\(YimiPaymentText.amount(card.amount_fen))").font(.subheadline.weight(.semibold))
                        Text("\(card.payee ?? card.app) · 打开查看付款卡").font(.caption).foregroundStyle(Yimi.ink2)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Yimi.ink2)
                }.foregroundStyle(Yimi.ink).padding(.vertical, 12).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
    }
}

struct YimiPaymentCallBar: View {
    @ObservedObject var payment: YimiPaymentModel
    let card: CentralPaymentCard
    let onOpen: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            let elapsed = max(0, clock.date.timeIntervalSince(payment.receivedAt))
            let expires = max(0, Int(ceil(Double(card.expires_in_ms) / 1000 - elapsed)))
            let auto = max(0, Int(ceil(Double(card.auto_in_ms ?? 0) / 1000 - elapsed)))
            VStack(alignment: .leading, spacing: 8) {
                Button(action: onOpen) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("¥\(YimiPaymentText.amount(card.amount_fen))").font(.title2.weight(.semibold)).monospacedDigit()
                        Text(([card.payee ?? card.app] + card.items).joined(separator: " · ")).font(.subheadline).lineLimit(2)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption)
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain)
                Text(payment.submitted.contains(card.payment_id) ? "决定已提交，等待服务器确认" :
                     card.state == .auto_pending ? (auto > 0 ? "\(auto) 秒后自动付款 · 可取消" : "正在等待付款结果") :
                     card.state.title + (card.methods.voice.available && card.state.canDecide ? " · 说「付吧」也行" : " · 来自\(card.app)"))
                    .font(.caption).foregroundStyle(Yimi.ink2)
                if card.state.isTerminal {
                    Text(YimiPaymentText.result(card.state, orderCancel: card.result?.order_cancel)).font(.caption).foregroundStyle(Yimi.ink2)
                } else if card.state == .verifying {
                    Text("发起这件事的那句 +「付吧」").font(.caption).foregroundStyle(Yimi.ink2)
                }
                if card.state.canDecide, expires > 0 {
                    actionLayout {
                        Button("取消") { Task { await payment.decide(card, decision: "cancel") } }
                            .buttonStyle(YimiPaymentActionStyle(primary: card.state == .auto_pending))
                        if !payment.submitted.contains(card.payment_id) {
                            Button(card.state == .auto_pending ? "现在付款" : "付款 ¥\(YimiPaymentText.amount(card.amount_fen))") {
                                Task { await payment.decide(card, decision: "pay") }
                            }.buttonStyle(YimiPaymentActionStyle(primary: card.state != .auto_pending)).disabled(payment.busy)
                        }
                    }.disabled(!payment.available)
                }
            }.foregroundStyle(Yimi.ink).padding(14).background(Yimi.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Yimi.hair, lineWidth: 1))
        }
    }
    private var actionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
    }
}

struct YimiPaymentApprovalCard: View {
    @ObservedObject var payment: YimiPaymentModel
    let approval: CentralPaymentApproval
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var enrolment: Bool { approval.kind == "voiceprint_enrol" }
    private var supplement: Bool { approval.kind == "voice_enrollment" }
    private var voice: Bool { enrolment || supplement }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { clock in
            let remaining = max(0, Int(ceil(Double(approval.expires_in_ms) / 1000 - max(0, clock.date.timeIntervalSince(payment.approvalReceivedAt)))))
            VStack(alignment: .leading, spacing: 14) {
                Label(supplement ? "眼镜要补充你的声音" : enrolment ? "眼镜要录入你的声音" : "眼镜要解锁依米", systemImage: voice ? "person.wave.2" : "eyeglasses")
                    .font(.headline)
                Text(approval.device_label + " · " + (remaining > 0 ? "等待确认 \(remaining) 秒" : "已过确认时间"))
                    .font(.caption).foregroundStyle(Yimi.ink2).monospacedDigit()
                Text(supplement ? "只有你本人该点。允许后，戴着眼镜和依米聊一会儿，让她在眼镜上更熟悉你的声音；不用于付款。不是你发起的，点「不是我」。"
                     : enrolment ? "只有你本人该点。录入后，眼镜上的「付吧」才认得你的声音。不是你发起的，点「不是我」。" : "是你戴上的吗？确认后，眼镜在你戴着的时候保持解锁；摘下、断线或息屏会重新上锁。")
                    .font(.subheadline).foregroundStyle(Yimi.ink2)
                if payment.submitted.contains(approval.approval_id) {
                    Text("正在等待确认结果").font(.subheadline).foregroundStyle(Yimi.ink2)
                }
                actionLayout {
                        Button("不是我") { Task { await payment.approve(approval, allow: false) } }.buttonStyle(YimiPaymentActionStyle())
                        if !payment.submitted.contains(approval.approval_id) {
                            Button { Task { await payment.approve(approval, allow: true) } } label: {
                                Label(voice ? "允许录入" : "允许解锁", systemImage: "faceid")
                            }.buttonStyle(YimiPaymentActionStyle(primary: true)).disabled(payment.busy || remaining == 0)
                        }
                }.disabled(!payment.available)
            }.foregroundStyle(Yimi.ink).padding(18).background(Yimi.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Yimi.hair, lineWidth: 1))
        }
    }
    private var actionLayout: AnyLayout {
        dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
    }
}

struct YimiPaymentActionStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(primary ? Color.white : Yimi.ink)
            .background(primary ? Yimi.klein : Yimi.paper, in: RoundedRectangle(cornerRadius: 12))
            .opacity(!isEnabled ? 0.45 : configuration.isPressed ? 0.75 : 1)
    }
}

enum YimiPaymentText {
    static func amount(_ fen: Int) -> String { AssistantPayment.amount(fen) }
    static func method(_ value: String?) -> String {
        switch value { case "card": return "点卡片"; case "voice": return "声纹"; case "auto": return "免密"; default: return "尚未授权" }
    }
    static func terminal(_ value: String?) -> String {
        switch value { case "phone": return "iPhone"; case "glasses": return "眼镜"; default: return "" }
    }
    static func result(_ state: CentralPaymentState, orderCancel: String?) -> String {
        switch state {
        case .paid: return "收银台已显示支付成功"
        case .outcome_unknown: return "点了付款但没看到结果，已停止。请核对平台订单，不会再付一次。"
        case .superseded: return "金额变了，旧卡已作废。请查看新金额的付款卡。"
        case .cancelled, .expired, .failed:
            switch orderCancel {
            case "done": return "没有付款 · 平台订单也取消了"
            case "pending": return "没有付款 · 正在取消平台订单"
            case "failed": return "没有付款 · 平台订单没取消成功，请去平台核对"
            case "not_attempted": return "没有付款 · 未能取消平台订单，请去平台核对"
            case "not_needed": return "没有付款 · 请到平台完成验证并核对订单"
            default: return "没有付款 · 平台订单状态尚未确认"
            }
        default: return state.title
        }
    }
    static func date(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let value = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return value?.formatted(.dateTime.month().day().hour().minute()) ?? iso
    }
}
