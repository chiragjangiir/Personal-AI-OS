import SwiftUI
import WatchKit

struct YimiWatchRideView: View {
    @ObservedObject var workout: WatchWorkoutCoordinator
    @ObservedObject var store: WatchYimiStore
    let phoneReachable: Bool
    let talk: () -> Void
    @Environment(\.isLuminanceReduced) private var dimmed
    @State private var page = 1
    @State private var presentation = WatchRidePresentation()
    @AppStorage("yimi.watch.heartRateHintShown") private var heartRateHintShown = false
    @State private var showsHeartRateHint = false
    private var metric: WatchCyclingMetricSnapshot? { workout.metricSnapshot }
    var body: some View {
        TabView(selection: $page) {
            controls.tag(0)
            data.tag(1)
            NowPlayingView().tag(2)
        }.tabViewStyle(.page(indexDisplayMode: dimmed ? .never : .automatic))
            .navigationTitle(workout.snapshot.state == .paused ? "已暂停" : "骑行中")
            .foregroundStyle(dimmed ? Color(white: 0.8) : Yimi.ink)
            .onChange(of: store.state?.ride) { _, ride in
                if presentation.receive(ride, now: Date()) { alertHaptic() }
            }
            .task {
                if presentation.receive(store.state?.ride, now: Date()) { alertHaptic() }

            }
            .task(id: presentation.expiresAt) {
                guard let expiry = presentation.expiresAt else { return }
                let remaining = max(0, expiry.timeIntervalSinceNow)
                do { try await Task.sleep(for: .seconds(remaining)) }
                catch { return }
                presentation.expire(at: Date())
            }
            .onChange(of: store.currentScope) { _, _ in presentation = WatchRidePresentation() }
            .task(id: metric?.observedAt) {
                if metric != nil, metric?.heartRateBPM == nil, !heartRateHintShown {
                    heartRateHintShown = true; showsHeartRateHint = true
                }
                let now = Date()
                let heartRate = WatchCyclingMetricMapper.fresh(metric?.heartRateBPM, at: metric?.heartRateSampleAt, observedAt: now)
                if presentation.update(heartRate: heartRate, phoneReachable: phoneReachable, now: now) { alertHaptic() }
            }
            .confirmationDialog("要保存这次骑行吗？", isPresented: Binding(get: { workout.awaitingSaveDecision }, set: { _ in }), titleVisibility: .visible) {
                Button("保存") { workout.decideSave(true) }
                Button("不保存", role: .destructive) { workout.decideSave(false) }
            }
            .alert("看不到心率", isPresented: $showsHeartRateHint) {
                Button("好", role: .cancel) {}
            } message: { Text("在 iPhone「健康」里允许依米读取心率。骑行照常记录。") }
    }
    private var controls: some View {
        VStack(spacing: 20) {
            HStack(spacing: 20) {
                control("结束", "xmark", Yimi.danger) {
                    workout.stopWorkout(askToSave: WatchRidePresentation.needsSaveDecision(elapsed: workout.elapsedTime))
                }
                control(workout.snapshot.state == .paused ? "继续" : "暂停", workout.snapshot.state == .paused ? "play.fill" : "pause.fill", Yimi.ink) {
                    workout.togglePause()
                }
            }
            control("和依米说话", "mic.fill", Yimi.klein, action: talk)
        }.disabled(workout.snapshot.state != .running && workout.snapshot.state != .paused)
    }
    private var data: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let figures = WatchRideFigures.live(phone: store.state?.ride?.metrics, phoneAt: store.rideMetricsAt,
                                                local: metric, elapsed: workout.elapsedTime, now: context.date)
            let banner = presentation.expiresAt.map { context.date < $0 } == true && !dimmed ? presentation.banner : nil
            YimiWatchRideNumbers(figures: figures, zone: figures.phoneCurrent ? store.state?.ride?.hr_zone : nil, banner: banner,
                                 cadence: WatchCyclingMetricMapper.fresh(metric?.cadenceSPM, at: metric?.cadenceSampleAt, observedAt: context.date),
                                 alerting: presentation.banner != nil, dimmed: dimmed)
        }
    }
    private func control(_ title: String, _ symbol: String, _ tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.title2).frame(width: 62, height: 62)
                    .background(tint == Yimi.klein ? Yimi.klein : Yimi.surface, in: Circle())
                    .foregroundStyle(tint == Yimi.klein ? .white : tint)
                Text(title).font(.footnote)
            }
        }.buttonStyle(PressScale())
    }
    private func alertHaptic() {
        WKInterfaceDevice.current().play(.notification)
        Task { try? await Task.sleep(for: .milliseconds(300)); WKInterfaceDevice.current().play(.notification) }
    }
}

/// The ride page's numbers (用时, 速度, 心率, 距离). Large type, one column; unavailable values read "--".
struct YimiWatchRideNumbers: View {
    let figures: WatchRideFigures
    let zone: Int?
    let banner: String?
    let cadence: Double?
    let alerting: Bool
    let dimmed: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let banner {
                    Text(banner).font(.callout).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(red: 0.23, green: 0.10, blue: 0.12), in: RoundedRectangle(cornerRadius: 12))
                } else {
                    Text(elapsed).font(.system(size: 26, weight: .semibold)).foregroundStyle(dimmed ? .gray : Yimi.ink)
                }
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(WatchCyclingDisplayFormatter.speedText(figures.speedMPS)).font(.system(size: 46, weight: .bold))
                    Text("km/h").font(.callout).foregroundStyle(Yimi.ink2)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "heart.fill").font(.title3)
                    Text(WatchCyclingDisplayFormatter.valueText(figures.heartRate, unit: "").trimmingCharacters(in: .whitespaces)).font(.system(size: 30, weight: .semibold))
                    if let zone { Text("\(zone) 区").font(.footnote).foregroundStyle(Yimi.ink2) }
                }.foregroundStyle(alerting && !dimmed ? Yimi.danger : (dimmed ? Color.gray : Yimi.ink))
                Text(WatchCyclingDisplayFormatter.distanceText(figures.distanceM)).font(.system(size: 30, weight: .semibold))
                if let cadence {
                    Text("踏频 \(WatchCyclingDisplayFormatter.valueText(cadence, unit: "rpm"))").font(.callout).foregroundStyle(Yimi.ink2)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).monospacedDigit().padding(.horizontal, 8)
        }
    }

    private var elapsed: String {
        guard let seconds = figures.elapsedS else { return "--:--" }
        return dimmed ? yimiClock(Int(seconds) / 60) : WatchCyclingDisplayFormatter.elapsedText(seconds)
    }
}

#Preview("骑行数据 · 手表自己的数", traits: .sizeThatFitsLayout) {
    YimiWatchRideNumbers(figures: .init(speedMPS: nil, distanceM: 12_600, elapsedS: 2_535, heartRate: 142, kcal: 380, phoneCurrent: false),
                         zone: nil, banner: nil, cadence: nil, alerting: false, dimmed: false)
        .frame(width: 184, height: 220).background(Yimi.ground)
}
#Preview("骑行数据 · 手机在 · 心率提醒 · 大字", traits: .sizeThatFitsLayout) {
    YimiWatchRideNumbers(figures: .init(speedMPS: 31.8 / 3.6, distanceM: 12_600, elapsedS: 2_535, heartRate: 178, kcal: 380, phoneCurrent: true),
                         zone: 5, banner: "心率 178 了，慢一点，喝口水。", cadence: 82, alerting: true, dimmed: false)
        .frame(width: 184, height: 220).background(Yimi.ground).environment(\.dynamicTypeSize, .accessibility2)
}
#Preview("骑行数据 · 息屏", traits: .sizeThatFitsLayout) {
    YimiWatchRideNumbers(figures: .init(speedMPS: 27.4 / 3.6, distanceM: 12_600, elapsedS: 2_535, heartRate: 142, kcal: 380, phoneCurrent: true),
                         zone: 3, banner: nil, cadence: nil, alerting: false, dimmed: true)
        .frame(width: 184, height: 220).background(Yimi.ground)
}
