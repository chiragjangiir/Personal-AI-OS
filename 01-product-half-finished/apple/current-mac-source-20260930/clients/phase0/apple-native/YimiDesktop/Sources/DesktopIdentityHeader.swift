import SwiftUI

struct DesktopIdentityHeader: View {
    @ObservedObject var model: DesktopAppModel
    var showsConnection = true
    var body: some View {
        HStack(spacing: 8) {
            YimiPortrait(breathes: false).frame(width: 30, height: 30).clipShape(Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image("YimMarkHeader").resizable().frame(width: 17, height: 17).accessibilityHidden(true)
                    Text(showsConnection ? "依米 · " + (model.connected && !model.pause.paused ? "在呢" : model.presenceLabel) : "依米").fontWeight(.semibold).foregroundStyle(Yimi.klein)
                    if model.connected && !model.pause.paused { LiveDot(size: 6) }
                    else { Circle().fill(Yimi.ink3).frame(width: 6, height: 6).accessibilityHidden(true) }
                }
                Text(showsConnection ? model.connectionLabel + (model.connected ? " · 端到端加密" : "") : model.presenceLabel)
                    .font(.caption).foregroundStyle(Yimi.ink2)
            }
        }
    }
}
