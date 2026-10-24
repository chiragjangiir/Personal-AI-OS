import SwiftUI

struct YimiWatchOnboardingView: View {
    @Binding var completed: Bool
    @State private var explainsPermissions = false
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if explainsPermissions {
                    Text("依米会用到").font(.headline)
                    permission("mic", "麦克风", "只在你和她说话时听")
                    permission("heart.fill", "心率和锻炼", "只在骑行时用")
                    permission("bell", "通知", "轻震提醒，不出声")
                } else {
                    Text("依米也在手表上了").font(.title3.bold())
                    Text("抬手就能和她说话、看她回你什么、回答她的问题；骑车时看速度和心率。")
                        .foregroundStyle(Yimi.ink2)
                }
                Button("继续") {
                    if explainsPermissions { completed = true } else { explainsPermissions = true }
                }.buttonStyle(.borderedProminent).tint(Yimi.klein)
            }.padding(.horizontal, 10)
        }.background(Yimi.ground)
    }
    private func permission(_ icon: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top) {
            Image(systemName: icon).foregroundStyle(Yimi.klein).frame(width: 28)
            VStack(alignment: .leading) {
                Text(title).font(.headline)
                Text(detail).font(.footnote).foregroundStyle(Yimi.ink2)
            }
            Spacer(minLength: 0)
        }
    }
}

struct YimiWatchRegistrationView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(WatchStateReducer.linkText(.watch_unregistered)).font(.headline)
                ForEach(Array(["打开 iPhone 上的依米", "点右上角「设备」", "选「登记或更换 Watch」"].enumerated()), id: \.offset) { index, text in
                    HStack(alignment: .top) {
                        Text("\(index + 1)").foregroundStyle(Yimi.klein)
                        Text(text).font(.callout)
                    }
                }
                Text("登记好会自动继续。").font(.footnote).foregroundStyle(Yimi.ink2)
            }.padding(.horizontal, 10)
        }.navigationTitle("依米")
    }
}

struct YimiWatchUnavailableView: View {
    let title: String
    let detail: String
    let symbol: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol).font(.title2).foregroundStyle(Yimi.ink2)
            Text(title).font(.headline).multilineTextAlignment(.center)
            Text(detail).font(.footnote).foregroundStyle(Yimi.ink2).multilineTextAlignment(.center)
        }.padding(.horizontal, 12).navigationTitle("依米")
    }
}
