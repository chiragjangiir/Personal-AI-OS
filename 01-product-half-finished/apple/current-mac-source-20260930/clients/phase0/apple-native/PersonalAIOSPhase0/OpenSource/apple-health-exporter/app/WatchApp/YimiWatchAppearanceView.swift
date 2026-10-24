import SwiftUI
import WatchKit

struct YimiWatchAppearanceView: View {
    @ObservedObject private var avatar = YimiAvatarStore.shared
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let data = avatar.imageData, let image = UIImage(data: data) {
                    GeometryReader { geometry in
                        let scale = max(geometry.size.width / image.size.width, geometry.size.height / image.size.height)
                        let width = image.size.width * scale, height = image.size.height * scale
                        let focus = avatar.profile?.focus
                        Image(uiImage: image).resizable().frame(width: width, height: height)
                            .offset(x: min(0, max(geometry.size.width - width, geometry.size.width / 2 - (focus?.x ?? 0.5) * width)),
                                    y: min(0, max(geometry.size.height - height, geometry.size.height / 2 - (focus?.y ?? 0.5) * height)))
                    }.frame(height: 130).clipped().clipShape(RoundedRectangle(cornerRadius: 18))
                        .accessibilityLabel("依米当前形象").accessibilityIdentifier("watch.appearance.current")
                    Text("已保存 · 经 iPhone").font(.footnote).foregroundStyle(Yimi.ink2)
                } else {
                    Image(systemName: "person.crop.circle").font(.largeTitle).foregroundStyle(Yimi.ink2)
                    Text("等待 iPhone 同步当前样子").font(.footnote)
                }
                Text("到 iPhone 更换").font(.headline).accessibilityIdentifier("watch.appearance.phone")
                Text("打开 iPhone 上的依米，点右上角菜单 → 她的样子。").font(.footnote).foregroundStyle(Yimi.ink2)
                if let error = avatar.error { Text(error).font(.footnote).foregroundStyle(Yimi.danger) }
            }.padding(.horizontal, 8)
        }.navigationTitle("她的样子")
    }
}
