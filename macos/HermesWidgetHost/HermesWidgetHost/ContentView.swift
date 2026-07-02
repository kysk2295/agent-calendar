import SwiftUI
import WidgetKit

struct ContentView: View {
    @State private var saved = false

    var body: some View {
        ZStack {
            HermesHostMountainBackground()
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 11) {
                    Text("H")
                        .font(.system(size: 18, weight: .black))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(LinearGradient(colors: [Color(hex: "#D7613D"), Color(hex: "#B8492C")], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Hermes 위젯")
                            .font(.system(size: 19, weight: .bold))
                        Text("macOS 데스크톱 위젯 · 알림 센터")
                            .font(.system(size: 12, weight: .semibold))
                            .opacity(0.86)
                    }
                    Spacer()
                }

                Text("위젯 갤러리에서 Hermes를 검색해 월 캘린더, 오늘, 다음 일정, 에이전트 상태 위젯을 바탕화면에 추가하세요.")
                    .font(.system(size: 15, weight: .semibold))
                    .lineSpacing(5)
                    .frame(maxWidth: 520, alignment: .leading)

                HStack(spacing: 10) {
                    Button("빈 스냅샷 다시 쓰기") {
                        HermesWidgetStore.save(.emptySnapshot)
                        WidgetCenter.shared.reloadAllTimelines()
                        saved = true
                    }
                    .buttonStyle(.borderedProminent)

                    Button("위젯 갤러리 열기") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
                    }
                    .buttonStyle(.bordered)
                }

                if saved {
                    Text("빈 스냅샷 저장됨 · 위젯 타임라인을 새로고침했습니다.")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color(hex: "#E3EFE4"))
                }
            }
            .foregroundStyle(.white)
            .padding(38)
            .frame(width: 720, height: 420, alignment: .topLeading)
        }
    }
}

struct HermesHostMountainBackground: View {
    var body: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(
                colors: [Color(hex: "#8FB4D6"), Color(hex: "#A9C3D9"), Color(hex: "#C6C9CE"), Color(hex: "#9AA7AE"), Color(hex: "#6E7E86")],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            MountainShape(back: true)
                .fill(LinearGradient(colors: [.clear, Color.black.opacity(0.30), Color.black.opacity(0.42)], startPoint: .top, endPoint: .bottom))
                .frame(height: 210)
            MountainShape(back: false)
                .fill(Color(hex: "#344249").opacity(0.55))
                .frame(height: 150)
        }
        .ignoresSafeArea()
    }
}

struct MountainShape: Shape {
    var back: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let points: [CGPoint] = back
            ? [
                CGPoint(x: 0.00, y: 0.62), CGPoint(x: 0.14, y: 0.40), CGPoint(x: 0.26, y: 0.55), CGPoint(x: 0.40, y: 0.28),
                CGPoint(x: 0.54, y: 0.50), CGPoint(x: 0.68, y: 0.32), CGPoint(x: 0.82, y: 0.52), CGPoint(x: 1.00, y: 0.38)
            ]
            : [
                CGPoint(x: 0.00, y: 0.70), CGPoint(x: 0.18, y: 0.52), CGPoint(x: 0.34, y: 0.66), CGPoint(x: 0.50, y: 0.46),
                CGPoint(x: 0.66, y: 0.64), CGPoint(x: 0.80, y: 0.50), CGPoint(x: 1.00, y: 0.62)
            ]
        path.move(to: CGPoint(x: 0, y: rect.maxY))
        points.forEach { point in
            path.addLine(to: CGPoint(x: rect.minX + point.x * rect.width, y: rect.minY + point.y * rect.height))
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

extension Color {
    init(hex: String) {
        let clean = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var value: UInt64 = 0
        Scanner(string: clean).scanHexInt64(&value)
        let red = Double((value >> 16) & 0xFF) / 255
        let green = Double((value >> 8) & 0xFF) / 255
        let blue = Double(value & 0xFF) / 255
        self.init(red: red, green: green, blue: blue)
    }
}
