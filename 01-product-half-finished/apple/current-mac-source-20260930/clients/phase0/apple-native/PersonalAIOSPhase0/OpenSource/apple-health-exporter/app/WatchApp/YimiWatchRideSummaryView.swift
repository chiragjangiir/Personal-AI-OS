import SwiftUI

struct YimiWatchRideSummaryView: View {
    @ObservedObject var workout: WatchWorkoutCoordinator
    @ObservedObject var store: WatchYimiStore
    private var figures: WatchRideSummaryFigures? {
        workout.summary.map { WatchRideSummaryFigures.resolve(phone: store.state?.ride, local: $0) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 7) {
                if workout.snapshot.state == .finished {
                    Label("已存进「健康」", systemImage: "checkmark").font(.footnote).foregroundStyle(Yimi.ok)
                    if let figures { YimiWatchRideSummaryFigures(figures: figures) }
                    if let commentary = figures?.commentary, !commentary.isEmpty {
                        Text(commentary).font(.callout).padding(9)
                            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: Yimi.Radius.watchCard))
                    } else {
                        Text("依米的点评到了会显示在这里").font(.footnote).foregroundStyle(Yimi.ink3)
                    }
                } else {
                    Text(workout.snapshot.state == .discarded ? "这次骑行没有保存" : workout.snapshot.state == .failed ? "这次骑行没能完成" : "这次骑行的保存状态无法确认")
                        .font(.headline)
                }
                Button("完成") { workout.resetAfterTerminalState() }.buttonStyle(.borderedProminent).tint(Yimi.klein)
            }.padding(.horizontal, 8)
        }.navigationTitle("骑行完成")
    }
}

/// 距离, 用时 and the totals the ride actually has. A total nobody supplied is left out rather than shown as zero.
struct YimiWatchRideSummaryFigures: View {
    let figures: WatchRideSummaryFigures

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(WatchCyclingDisplayFormatter.distanceText(figures.distanceM)).font(.title2.bold())
                Text(WatchCyclingDisplayFormatter.elapsedText(figures.timeS)).font(.callout)
            }.monospacedDigit()
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 8) {
                cell("均速", figures.avgKMH.map { WatchCyclingDisplayFormatter.speedText($0 / 3.6) + " km/h" })
                cell("最高", figures.maxKMH.map { WatchCyclingDisplayFormatter.speedText($0 / 3.6) + " km/h" })
                cell("爬升", figures.elevationM.map { WatchCyclingDisplayFormatter.valueText($0, unit: "m") })
                cell("消耗", figures.kcal.map { WatchCyclingDisplayFormatter.valueText($0, unit: "千卡") })
                cell("平均心率", figures.hrAvg.map { WatchCyclingDisplayFormatter.valueText($0, unit: "bpm") })
                cell("最高心率", figures.hrMax.map { WatchCyclingDisplayFormatter.valueText($0, unit: "bpm") })
            }
        }
    }

    @ViewBuilder private func cell(_ label: String, _ value: String?) -> some View {
        if let value {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.footnote).foregroundStyle(Yimi.ink3)
                Text(value).font(.callout.bold()).monospacedDigit()
            }
        }
    }
}

#Preview("骑行总结 · 手机的完整数据", traits: .sizeThatFitsLayout) {
    YimiWatchRideSummaryFigures(figures: .init(distanceM: 32_600, timeS: 5_320, avgKMH: 22.1, maxKMH: 41.2, kcal: 892,
                                               hrAvg: 148, hrMax: 176, elevationM: 186))
        .padding(8).frame(width: 184).background(Yimi.ground)
}
#Preview("骑行总结 · 只有手表自己的 · 大字", traits: .sizeThatFitsLayout) {
    YimiWatchRideSummaryFigures(figures: .init(distanceM: 32_600, timeS: 5_320, avgKMH: 22.1, maxKMH: nil, kcal: 892,
                                               hrAvg: 148, hrMax: 176, elevationM: nil))
        .padding(8).frame(width: 184).background(Yimi.ground).environment(\.dynamicTypeSize, .accessibility2)
}
