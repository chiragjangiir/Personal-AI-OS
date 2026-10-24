import SwiftUI

/// 依米 design language: white ground, International Klein Blue for her identity and primary actions only,
/// calm spacing, and motion on every change (nothing pops). Values mirror the approved web prototype.
enum Yimi {
    /// Every token is adaptive: light = the approved prototype values, dark = a deep near-black palette that keeps the
    /// Klein identity. Resolved by UIKit per trait collection, so a system appearance change applies live.
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        #if os(watchOS)
        let hex = dark
        return Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
        #else
        func ui(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        return Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
        #endif
    }

    static let klein = adaptive(0x002FA7, 0x4F7BFF)
    static let kleinPressed = adaptive(0x00257F, 0x3C63D6)
    static let tint = adaptive(0xEEF2FC, 0x182244)
    static let tint2 = adaptive(0xD9E2F8, 0x26376B)
    /// Screen ground (white in light, the deepest tone in dark).
    static let ground = adaptive(0xFFFFFF, {
        #if os(watchOS)
        return 0x000000
        #else
        return 0x0B0E14
        #endif
    }())
    /// Cards, bubbles and sheets that sit on `ground` or `paper` (white in light, lifted in dark).
    static let surface = adaptive(0xFFFFFF, 0x1D2330)
    static let paper = adaptive(0xF6F7FA, 0x161B25)
    static let hair = adaptive(0xE6E9F0, 0x2A3140)
    static let ink = adaptive(0x0A0F1E, 0xECEFF6)
    static let ink2 = adaptive(0x586174, 0xA6AEC0)
    static let ink3 = adaptive(0x8A93A5, 0x8790A4)
    static let ok = adaptive(0x138A50, 0x3FCB84)
    static let okTint = adaptive(0xE7F5EE, 0x12281D)
    static let danger = adaptive(0xE5484D, 0xFF6B70)
    static let activityAccent = adaptive(0x002FA7, 0x6F93FF)
    static let activitySlow = adaptive(0x80520A, 0xEFC477)
    static let activityFailure = adaptive(0xBF3038, 0xFF8990)
    static let portrait = adaptive(0xEDF0F6, 0x1A202B)
    static let silhouette = adaptive(0xDCE2EC, 0x2A3345)
    /// "Release to cancel" ground of the push-to-talk overlay (white text sits on it in both modes).
    static let cancel = adaptive(0x586174, 0x4A5266)

    enum Radius {
        static let small: CGFloat = 12
        static let card: CGFloat = 18
        static let watchCard: CGFloat = 14
        static let hero: CGFloat = 32
    }

    /// Three durations (micro 0.14 s, component 0.28 s, page 0.42 s) on the emphasized-decelerate curve, an iOS sheet
    /// spring, and a light overshoot for things that snap into place (the PiP).
    enum Motion {
        static let micro = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.14)
        static let component = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.28)
        static let page = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.42)
        static let cover = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.52)
        static let sheet = Animation.spring(response: 0.46, dampingFraction: 0.86)
        static let snap = Animation.spring(response: 0.42, dampingFraction: 0.7)
    }
}

/// Every tappable surface answers the finger: a slight shrink while pressed.
struct PressScale: ButtonStyle {
    var scale: CGFloat = 0.95
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(Yimi.Motion.micro, value: configuration.isPressed)
    }
}

/// Every static portrait follows the owner-scoped server image and crop.
/// The bundled portrait is the initial/default image. Live video replaces it after its first frame.
/// Watch uses the same cache through the paired-phone projection.
#if !os(watchOS)
struct YimiPortrait: View {
    @ObservedObject private var avatar = YimiAvatarStore.shared
    var breathes = true
    var snapshot: YimiCallPortraitSnapshot?
    /// Where her face sits in the photo (unit coordinates); crops keep it as central as the frame allows.
    var focus: UnitPoint {
        let profile: CentralAvatarProfile?
        if let snapshot { profile = snapshot.profile }
        else { profile = avatar.profile }
        return profile.map { UnitPoint(x: $0.focus.x, y: $0.focus.y) } ?? UnitPoint(x: 0.53, y: 0.36)
    }
    static let photo: UIImage? = Bundle.main.url(forResource: "yimi-portrait", withExtension: "jpg", subdirectory: "Avatar")
        .flatMap { UIImage(contentsOfFile: $0.path) }

    private var portraitImage: UIImage? {
        if let snapshot {
            return snapshot.imageData.flatMap { UIImage(data: $0) } ?? (snapshot.profile == nil ? Self.photo : nil)
        }
        return avatar.imageData.flatMap { UIImage(data: $0) } ?? (avatar.profile == nil ? Self.photo : nil)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Yimi.portrait
                if let photo = portraitImage {
                    cropped(photo, in: geo.size)
                } else { silhouette(in: geo.size) }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
        }
        .accessibilityHidden(true)
    }

    private func cropped(_ photo: UIImage, in size: CGSize) -> some View {
        let scale = max(size.width / photo.size.width, size.height / photo.size.height)
        let width = photo.size.width * scale, height = photo.size.height * scale
        let x = min(0, max(size.width - width, size.width / 2 - focus.x * width))
        let y = min(0, max(size.height - height, size.height / 2 - focus.y * height))
        return Image(uiImage: photo).resizable()
            .frame(width: width, height: height)
            .offset(x: x, y: y)
            .phaseAnimator(breathes ? [1.0, 1.012] : [1.0]) { view, s in
                view.scaleEffect(s, anchor: UnitPoint(x: focus.x, y: 1))
            } animation: { _ in .easeInOut(duration: 3) }
    }

    private func silhouette(in size: CGSize) -> some View {
        let w = size.width, h = size.height, head = min(w * 0.42, h * 0.36)
        return VStack(spacing: -head * 0.12) {
            Ellipse().fill(Yimi.silhouette).frame(width: head, height: head * 1.16)
            UnevenRoundedRectangle(topLeadingRadius: w * 0.4, topTrailingRadius: w * 0.4)
                .fill(Yimi.silhouette)
                .frame(width: min(w * 0.86, head * 3.2), height: h * 0.34)
        }
        .frame(width: w, height: h, alignment: .bottom)
    }
}

#endif

/// Green "she is here" dot with a soft pulse.
struct LiveDot: View {
    var size: CGFloat = 8
    #if os(watchOS)
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Circle().fill(Yimi.ok).frame(width: size, height: size)
            .overlay(Circle().stroke(Yimi.ok.opacity(pulse ? 0 : 0.45), lineWidth: pulse ? size : 0).scaleEffect(pulse ? 2 : 1))
            .onAppear {
                if !reduceMotion { withAnimation(.easeOut(duration: 2.4).repeatForever(autoreverses: false)) { pulse = true } }
            }
            .onChange(of: reduceMotion) { _, reduced in
                if reduced { pulse = false }
                else { withAnimation(.easeOut(duration: 2.4).repeatForever(autoreverses: false)) { pulse = true } }
            }
            .transaction { if reduceMotion { $0.animation = nil; $0.disablesAnimations = true } }
            .accessibilityHidden(true)
    }
    #else
    var body: some View {
        Circle().fill(Yimi.ok).frame(width: size, height: size)
            .overlay(LiveDotRing(size: size, color: Yimi.ok.opacity(0.45)).allowsHitTesting(false))
            .accessibilityHidden(true)
    }
    #endif
}

#if !os(watchOS)
#if os(macOS)
private typealias LiveDotPlatformView = NSView
#else
private typealias LiveDotPlatformView = UIView
#endif
/// The pulse ring (a stroke widening to the dot's size while it doubles and fades over 2.4 s) as a Core Animation
/// layer: the render server runs it, so a visible dot costs no SwiftUI update per frame.
private final class LiveDotRingView: LiveDotPlatformView {
    private let ring = CAShapeLayer()
    init(size: CGFloat) {
        super.init(frame: .zero)
        #if os(macOS)
        wantsLayer = true
        #else
        isUserInteractionEnabled = false
        #endif
        ring.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        ring.path = CGPath(ellipseIn: ring.bounds, transform: nil)
        ring.fillColor = nil; ring.lineWidth = 0
        platformLayer.addSublayer(ring)
    }
    required init?(coder: NSCoder) { nil }
    func setColor(_ color: CGColor) { ring.strokeColor = color }
    /// Layout runs whenever the view joins a window, which is also when a stopped animation must restart.
    private func place() {
        ring.position = CGPoint(x: bounds.midX, y: bounds.midY)
        guard ring.animation(forKey: "pulse") == nil else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale"); scale.fromValue = 1; scale.toValue = 2
        let width = CABasicAnimation(keyPath: "lineWidth"); width.fromValue = 0; width.toValue = ring.bounds.width
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 1; fade.toValue = 0
        let pulse = CAAnimationGroup(); pulse.animations = [scale, width, fade]; pulse.duration = 2.4
        pulse.timingFunction = CAMediaTimingFunction(name: .easeOut); pulse.repeatCount = .infinity
        pulse.isRemovedOnCompletion = false
        ring.add(pulse, forKey: "pulse")
    }
    #if os(macOS)
    override func layout() { super.layout(); place() }
    private var platformLayer: CALayer { layer! }
    #else
    override func layoutSubviews() { super.layoutSubviews(); place() }
    private var platformLayer: CALayer { layer }
    #endif
}

#if os(macOS)
private struct LiveDotRing: NSViewRepresentable {
    let size: CGFloat, color: Color
    func makeNSView(context: Context) -> LiveDotRingView { LiveDotRingView(size: size) }
    func updateNSView(_ view: LiveDotRingView, context: Context) { view.setColor(color.resolve(in: context.environment).cgColor) }
}
#else
private struct LiveDotRing: UIViewRepresentable {
    let size: CGFloat, color: Color
    func makeUIView(context: Context) -> LiveDotRingView { LiveDotRingView(size: size) }
    func updateUIView(_ view: LiveDotRingView, context: Context) { view.setColor(color.resolve(in: context.environment).cgColor) }
}
#endif
#endif

/// Progress ring for something she is doing; spins softly when the amount is unknown.
struct ProgressRing: View {
    var progress: Double?
    @State private var spin = false
    #if os(watchOS)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif
    var body: some View {
        ZStack {
            Circle().stroke(Yimi.tint2, lineWidth: 4)
            Circle()
                .trim(from: 0, to: progress ?? 0.28)
                .stroke(Yimi.klein, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(spin ? 270 : -90))
                #if os(watchOS)
                .animation(reduceMotion ? nil : progress == nil ? .linear(duration: 1.4).repeatForever(autoreverses: false) : Yimi.Motion.component, value: spin)
                #else
                .animation(progress == nil ? .linear(duration: 1.4).repeatForever(autoreverses: false) : Yimi.Motion.component, value: spin)
                #endif
        }
        .frame(width: 44, height: 44)
        #if os(watchOS)
        .onAppear { if progress == nil && !reduceMotion { spin = true } }
        .onChange(of: reduceMotion) { _, reduced in spin = progress == nil && !reduced }
        #else
        .onAppear { if progress == nil { spin = true } }
        #endif
        .accessibilityHidden(true)
    }
}

/// Small rounded status label.
struct YimiPill: View {
    enum Tone { case klein, ok, muted }
    let text: String
    var tone: Tone = .klein
    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(tone == .klein ? Yimi.klein : tone == .ok ? Yimi.ok : Yimi.ink2)
            .padding(.horizontal, 9).padding(.vertical, 3)
            .background(tone == .klein ? Yimi.tint : tone == .ok ? Yimi.okTint : Yimi.paper, in: Capsule())
    }
}

/// Live waveform bars, procedurally animated (the mic level is not exposed to the UI layer).
struct WaveBars: View {
    var count = 28
    var maxHeight: CGFloat = 58
    var color: Color = .white
    #if os(watchOS)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #else
    private let reduceMotion = false
    #endif
    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<count, id: \.self) { i in
                    let v = abs(sin(t * 3.1 + Double(i) * 0.55) * sin(t * 1.7 + Double(i) * 0.21))
                    Capsule().fill(color).frame(width: 4, height: 8 + CGFloat(v) * maxHeight)
                }
            }
            .frame(height: maxHeight + 10)
        }
        .accessibilityHidden(true)
    }
}

/// mm:ss for call and task clocks.
func yimiClock(_ seconds: Int) -> String {
    String(format: "%02d:%02d", max(0, seconds) / 60, max(0, seconds) % 60)
}
