import AppIntents
import SwiftUI
import WidgetKit

struct HermesWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: HermesWidgetSnapshot
}

struct HermesTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> HermesWidgetEntry {
        HermesWidgetEntry(date: Date(), snapshot: .sampleDesignSnapshot)
    }

    func getSnapshot(in context: Context, completion: @escaping (HermesWidgetEntry) -> Void) {
        completion(HermesWidgetEntry(date: Date(), snapshot: HermesWidgetStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HermesWidgetEntry>) -> Void) {
        let now = Date()
        let nextRefresh = Calendar.current.date(byAdding: .minute, value: 30, to: now) ?? now.addingTimeInterval(1800)
        completion(Timeline(entries: [HermesWidgetEntry(date: now, snapshot: HermesWidgetStore.load())], policy: .after(nextRefresh)))
    }
}

struct ToggleHermesTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Hermes task toggle"

    @Parameter(title: "Task ID")
    var taskID: String

    init() {
        taskID = ""
    }

    init(taskID: String) {
        self.taskID = taskID
    }

    func perform() async throws -> some IntentResult {
        let updatedTask = HermesWidgetStore.toggleTask(taskID)
        HermesWidgetStore.enqueueAction(HermesWidgetAction(type: "toggleTask", taskID: taskID, source: updatedTask?.source, done: updatedTask?.done))
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

struct OpenHermesDateIntent: AppIntent {
    static let title: LocalizedStringResource = "Hermes date open"

    @Parameter(title: "Date")
    var date: String

    init() {
        date = ""
    }

    init(date: String) {
        self.date = date
    }

    func perform() async throws -> some IntentResult {
        HermesWidgetStore.enqueueAction(HermesWidgetAction(type: "openDate", date: date, screen: "calendar"))
        return .result()
    }
}

struct OpenHermesScreenIntent: AppIntent {
    static let title: LocalizedStringResource = "Hermes screen open"

    @Parameter(title: "Screen")
    var screen: String

    init() {
        screen = "today"
    }

    init(screen: String) {
        self.screen = screen
    }

    func perform() async throws -> some IntentResult {
        HermesWidgetStore.enqueueAction(HermesWidgetAction(type: "openScreen", screen: screen))
        return .result()
    }
}

struct OpenHermesTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Hermes task open"

    @Parameter(title: "Task ID")
    var taskID: String

    init() {
        taskID = ""
    }

    init(taskID: String) {
        self.taskID = taskID
    }

    func perform() async throws -> some IntentResult {
        HermesWidgetStore.enqueueAction(HermesWidgetAction(type: "openTask", taskID: taskID))
        return .result()
    }
}

struct OpenHermesRunIntent: AppIntent {
    static let title: LocalizedStringResource = "Hermes run open"

    @Parameter(title: "Run ID")
    var runID: String

    init() {
        runID = ""
    }

    init(runID: String) {
        self.runID = runID
    }

    func perform() async throws -> some IntentResult {
        HermesWidgetStore.enqueueAction(HermesWidgetAction(type: runID.isEmpty ? "openScreen" : "openRun", screen: "agents", runID: runID.isEmpty ? nil : runID))
        return .result()
    }
}

@main
struct HermesWidgetsBundle: WidgetBundle {
    var body: some Widget {
        HermesMonthCalendarWidget()
        HermesTodayWidget()
        HermesNextEventWidget()
        HermesAgentStatusWidget()
    }
}

struct HermesMonthCalendarWidget: Widget {
    let kind = "HermesMonthCalendarWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HermesTimelineProvider()) { entry in
            MonthCalendarWidgetView(snapshot: entry.snapshot)
        }
        .configurationDisplayName("Hermes 월 캘린더")
        .description("한 달 일정과 담당자를 Large 위젯으로 확인합니다.")
        .supportedFamilies([.systemLarge])
        .contentMarginsDisabled()
    }
}

struct HermesTodayWidget: Widget {
    let kind = "HermesTodayWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HermesTimelineProvider()) { entry in
            TodayWidgetView(snapshot: entry.snapshot)
        }
        .configurationDisplayName("Hermes 오늘")
        .description("오늘 작업 4개와 남은 개수를 Medium 위젯으로 봅니다.")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}

struct HermesNextEventWidget: Widget {
    let kind = "HermesNextEventWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HermesTimelineProvider()) { entry in
            NextEventWidgetView(snapshot: entry.snapshot)
        }
        .configurationDisplayName("Hermes 다음 일정")
        .description("가장 가까운 시간 지정 일정을 Small 위젯으로 봅니다.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct HermesAgentStatusWidget: Widget {
    let kind = "HermesAgentStatusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: HermesTimelineProvider()) { entry in
            AgentStatusWidgetView(snapshot: entry.snapshot)
        }
        .configurationDisplayName("Hermes 에이전트 상태")
        .description("실행 중 에이전트와 검토 대기를 Small 위젯으로 봅니다.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct MonthCalendarWidgetView: View {
    let snapshot: HermesWidgetSnapshot

    var body: some View {
        HermesGlassCard(cornerRadius: 24) {
            VStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(month)월")
                        .font(.system(size: 22, weight: .black))
                        .foregroundStyle(Color(hex: "#D7613D"))
                    Text("\(year)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color(hex: "#A0967F"))
                    Spacer()
                    HermesMark(size: 22, radius: 7, fontSize: 11)
                }
                .padding(.horizontal, 3)
                .padding(.bottom, 8)

                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: 7), spacing: 0) {
                    ForEach(["일", "월", "화", "수", "목", "금", "토"], id: \.self) { weekday in
                        Text(weekday)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(weekdayColor(weekday))
                            .frame(height: 22)
                    }
                    ForEach(monthCells) { cell in
                        VStack(alignment: .leading, spacing: 2) {
                            Button(intent: OpenHermesDateIntent(date: cell.date)) {
                                Text("\(cell.day)")
                                    .font(.system(size: 11, weight: cell.isToday ? .black : .semibold))
                                    .foregroundStyle(cell.isToday ? .white : dayColor(cell))
                                    .frame(width: 17, height: 17)
                                    .background(cell.isToday ? Color(hex: "#D7613D") : .clear)
                                    .clipShape(Circle())
                            }
                            .buttonStyle(.plain)

                            VStack(spacing: 1.5) {
                                ForEach(cell.events.prefix(2)) { task in
                                    Button(intent: OpenHermesTaskIntent(taskID: task.id)) {
                                        Text(task.title.isEmpty ? " " : task.title)
                                            .font(.system(size: 8.5, weight: .semibold))
                                            .lineLimit(1)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.horizontal, 4)
                                            .padding(.vertical, 1)
                                            .foregroundStyle(ownerStyle(task.owner).foreground)
                                            .background(ownerStyle(task.owner).background)
                                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(ownerStyle(task.owner).border, lineWidth: 0.5))
                                            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                                    }
                                    .buttonStyle(.plain)
                                }
                                if cell.events.count > 2 {
                                    Text("+\(cell.events.count - 2)")
                                        .font(.system(size: 8.5, weight: .bold))
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 4)
                                        .padding(.vertical, 1)
                                        .foregroundStyle(Color(hex: "#8A8070"))
                                        .background(Color.white.opacity(0.46))
                                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(height: 44, alignment: .topLeading)
                        .opacity(cell.inMonth ? 1 : 0.58)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 16)
        }
    }

    private var year: Int { dateParts.year }
    private var month: Int { dateParts.month }

    private var dateParts: (year: Int, month: Int) {
        let parts = snapshot.todayDate.split(separator: "-").compactMap { Int($0) }
        return (parts.first ?? 2026, parts.dropFirst().first ?? 7)
    }

    private var monthCells: [MonthCell] {
        let calendar = Calendar(identifier: .gregorian)
        let first = calendar.date(from: DateComponents(year: year, month: month, day: 1)) ?? Date()
        let days = calendar.range(of: .day, in: .month, for: first)?.count ?? 31
        let previous = calendar.date(byAdding: .month, value: -1, to: first) ?? first
        let previousDays = calendar.range(of: .day, in: .month, for: previous)?.count ?? 30
        let offset = calendar.component(.weekday, from: first) - 1
        let rows = max(5, Int(ceil(Double(offset + days) / 7.0)))

        return (0..<(rows * 7)).map { index in
            let rawDay = index - offset + 1
            let inMonth = rawDay >= 1 && rawDay <= days
            let shownDay = rawDay < 1 ? previousDays + rawDay : rawDay > days ? rawDay - days : rawDay
            let date = String(format: "%04d-%02d-%02d", year, month, max(1, min(rawDay, days)))
            let events = inMonth ? snapshot.monthItems.filter { $0.date == date } : []
            return MonthCell(id: "\(index)-\(shownDay)", day: shownDay, date: date, inMonth: inMonth, isToday: inMonth && date == snapshot.todayDate, events: events)
        }
    }

    private func weekdayColor(_ weekday: String) -> Color {
        if weekday == "일" { return Color(hex: "#C0826A") }
        if weekday == "토" { return Color(hex: "#8AA0C0") }
        return Color(hex: "#A8A091")
    }

    private func dayColor(_ cell: MonthCell) -> Color {
        guard cell.inMonth else { return Color(hex: "#BDB4A3") }
        return Color(hex: "#3B362E")
    }
}

struct TodayWidgetView: View {
    let snapshot: HermesWidgetSnapshot

    var body: some View {
        HermesGlassCard(cornerRadius: 22) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Button(intent: OpenHermesScreenIntent(screen: "today")) {
                        Text("오늘")
                            .font(.system(size: 14, weight: .black))
                            .foregroundStyle(Color(hex: "#2B2620"))
                    }
                    .buttonStyle(.plain)
                    Text(todayLabel)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Color(hex: "#A0967F"))
                    Spacer()
                    Text("\(remaining) 남음")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color(hex: "#B8492C"))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 2)
                        .background(Color(hex: "#D7613D").opacity(0.12))
                        .clipShape(Capsule())
                }
                .padding(.bottom, 10)

                VStack(spacing: 2) {
                    ForEach(snapshot.todayTasks.prefix(4)) { task in
                        HStack(spacing: 9) {
                            Button(intent: ToggleHermesTaskIntent(taskID: task.id)) {
                                Text(task.done ? "✓" : "")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 16, height: 16)
                                    .background(task.done ? Color(hex: "#3E9B72") : Color.clear)
                                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(task.done ? Color(hex: "#3E9B72") : Color(hex: "#C9BEA9"), lineWidth: 1.5))
                                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                            }
                            .buttonStyle(.plain)

                            Button(intent: OpenHermesTaskIntent(taskID: task.id)) {
                                Text(task.title)
                                    .font(.system(size: 12.5, weight: .medium))
                                    .foregroundStyle(task.done ? Color(hex: "#A89E8E") : Color(hex: "#2B2620"))
                                    .strikethrough(task.done)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.plain)
                            Spacer(minLength: 4)
                            if let time = task.time {
                                Text(formatTime(time))
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(Color(hex: "#9A9080"))
                            }
                            if task.owner != .me {
                                Text(task.owner == .agent ? "에이전트" : "공동")
                                    .font(.system(size: 9.5, weight: .bold))
                                    .foregroundStyle(ownerStyle(task.owner).foreground)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(ownerStyle(task.owner).background)
                                    .overlay(Capsule().stroke(ownerStyle(task.owner).border, lineWidth: 0.5))
                                    .clipShape(Capsule())
                            }
                        }
                        .frame(height: 27)
                    }
                    if snapshot.todayTasks.isEmpty {
                        Text("오늘 작업 없음")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color(hex: "#A0967F"))
                            .frame(maxWidth: .infinity, minHeight: 80)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
    }

    private var remaining: Int {
        snapshot.todayTasks.filter { !$0.done }.count
    }

    private var todayLabel: String {
        let parts = snapshot.todayDate.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return "7월 1일 (수)" }
        let date = Calendar(identifier: .gregorian).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date()
        let weekday = DateFormatter.koreanShortWeekday.string(from: date)
        return "\(parts[1])월 \(parts[2])일 (\(weekday))"
    }
}

struct NextEventWidgetView: View {
    let snapshot: HermesWidgetSnapshot

    var body: some View {
        HermesGlassCard(cornerRadius: 22) {
            VStack(alignment: .leading, spacing: 2) {
                Text("다음 일정")
                    .font(.system(size: 10.5, weight: .bold))
                    .tracking(0.3)
                    .textCase(.uppercase)
                    .foregroundStyle(Color(hex: "#C0826A"))
                    .padding(.bottom, 2)
                if let event = snapshot.nextEvent {
                    Button(intent: OpenHermesTaskIntent(taskID: event.id)) {
                        Text(event.title)
                            .font(.system(size: 13.5, weight: .black))
                            .foregroundStyle(Color(hex: "#2B2620"))
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(intent: OpenHermesScreenIntent(screen: "calendar")) {
                        Text("예정 없음")
                            .font(.system(size: 13.5, weight: .black))
                            .foregroundStyle(Color(hex: "#2B2620"))
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                    }
                    .buttonStyle(.plain)
                }
                Text(nextEventSubtitle)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(Color(hex: "#9A9080"))
                    .lineLimit(2)
                Spacer()
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(ownerStyle(snapshot.nextEvent?.owner ?? .me).background)
                        .overlay(RoundedRectangle(cornerRadius: 3).stroke(ownerStyle(snapshot.nextEvent?.owner ?? .me).border, lineWidth: 1))
                        .frame(width: 9, height: 9)
                    Text(snapshot.nextEvent == nil ? "캘린더 대기" : "\(snapshot.nextEvent?.owner == .agent ? "에이전트" : "내 일정") · \(snapshot.nextEvent?.durationMinutes ?? 30)분")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(Color(hex: "#7A7062"))
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 15)
        }
    }

    private var nextEventSubtitle: String {
        guard let event = snapshot.nextEvent else { return "시간 지정 일정이 없습니다" }
        let time = event.time.map(formatTime) ?? "종일"
        return "\(time) · \(event.list)"
    }
}

struct AgentStatusWidgetView: View {
    let snapshot: HermesWidgetSnapshot

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ContainerRelativeShape()
                .fill(Color.rgba(43,38,32,0.72))
                .overlay(ContainerRelativeShape().stroke(Color.white.opacity(0.10), lineWidth: 0.5))
                .shadow(color: Color.black.opacity(0.28), radius: 22, x: 0, y: 14)

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    HermesMark(size: 19, radius: 6, fontSize: 10)
                    Text("에이전트")
                        .font(.system(size: 11, weight: .bold))
                    Spacer()
                    Circle()
                        .fill(Color(hex: "#5FD08A"))
                        .frame(width: 7, height: 7)
                        .shadow(color: Color(hex: "#5FD08A"), radius: 4)
                }
                .padding(.bottom, 9)
                Text("\(snapshot.runningRuns.count)")
                    .font(.system(size: 26, weight: .black))
                    .lineLimit(1)
                Text("실행 중")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.60))
                    .padding(.bottom, 8)
                Button(intent: agentIntent) {
                    Text(agentBody)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.80))
                        .lineSpacing(2)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.white.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 15)

            if snapshot.reviewPending > 0 {
                Text("\(snapshot.reviewPending) 검토")
                    .font(.system(size: 9, weight: .black))
                    .foregroundStyle(Color(hex: "#2B2620"))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(hex: "#F0D38A"))
                    .clipShape(Capsule())
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .containerBackground(for: .widget) {
            Color.clear
        }
    }

    private var agentBody: String {
        guard let run = snapshot.runningRuns.first ?? snapshot.runs.first else { return "대기 중\n진행률 0%" }
        return "\(run.title)\n진행률 \(run.progress)%"
    }

    private var agentIntent: OpenHermesRunIntent {
        OpenHermesRunIntent(runID: (snapshot.runningRuns.first ?? snapshot.runs.first)?.id ?? "")
    }
}

struct HermesGlassCard<Content: View>: View {
    var cornerRadius: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            ContainerRelativeShape()
                .fill(Color.rgba(251,249,244,0.82))
                .overlay(ContainerRelativeShape().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
                .shadow(color: Color.black.opacity(0.22), radius: 24, x: 0, y: 14)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea()
        .containerBackground(for: .widget) {
            Color.clear
        }
    }
}

struct HermesMountainBackground: View {
    var body: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(colors: [Color(hex: "#8FB4D6"), Color(hex: "#A9C3D9"), Color(hex: "#C6C9CE"), Color(hex: "#9AA7AE"), Color(hex: "#6E7E86")], startPoint: .topLeading, endPoint: .bottomTrailing)
            Color.clear
        }
    }
}

struct HermesMark: View {
    var size: CGFloat
    var radius: CGFloat
    var fontSize: CGFloat

    var body: some View {
        Text("H")
            .font(.system(size: fontSize, weight: .black))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: [Color(hex: "#D7613D"), Color(hex: "#B8492C")], startPoint: .topLeading, endPoint: .bottomTrailing))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

struct MonthCell: Identifiable {
    var id: String
    var day: Int
    var date: String
    var inMonth: Bool
    var isToday: Bool
    var events: [HermesWidgetTask]
}

struct OwnerVisualStyle {
    var background: Color
    var border: Color
    var foreground: Color
}

func ownerStyle(_ owner: HermesWidgetOwner) -> OwnerVisualStyle {
    switch owner {
    case .agent:
        return OwnerVisualStyle(background: Color(hex: "#E3EFE4"), border: Color(hex: "#C2DAC6"), foreground: Color(hex: "#3E7A52"))
    case .hybrid:
        return OwnerVisualStyle(background: Color(hex: "#ECE6F4"), border: Color(hex: "#D5C9E6"), foreground: Color(hex: "#6B5A8A"))
    case .weekend:
        return OwnerVisualStyle(background: Color(hex: "#F6E7D6"), border: Color(hex: "#EAD3B8"), foreground: Color(hex: "#B5793B"))
    case .me:
        return OwnerVisualStyle(background: Color(hex: "#E7ECF4"), border: Color(hex: "#C9D2E2"), foreground: Color(hex: "#4A5A78"))
    }
}

func formatTime(_ value: String) -> String {
    let chunks = value.split(separator: ":").compactMap { Int($0) }
    guard let hour = chunks.first else { return value }
    let minute = chunks.dropFirst().first ?? 0
    let period = hour < 12 ? "오전" : "오후"
    let displayHour = hour % 12 == 0 ? 12 : hour % 12
    return "\(period) \(displayHour):\(String(format: "%02d", minute))"
}

extension DateFormatter {
    static let koreanShortWeekday: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "E"
        return formatter
    }()
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

    static func rgba(_ red: Int, _ green: Int, _ blue: Int, _ alpha: Double) -> Color {
        Color(red: Double(red) / 255, green: Double(green) / 255, blue: Double(blue) / 255, opacity: alpha)
    }
}

#Preview("월 캘린더", as: .systemLarge) {
    HermesMonthCalendarWidget()
} timeline: {
    HermesWidgetEntry(date: Date(), snapshot: .sampleDesignSnapshot)
}

#Preview("오늘", as: .systemMedium) {
    HermesTodayWidget()
} timeline: {
    HermesWidgetEntry(date: Date(), snapshot: .sampleDesignSnapshot)
}

#Preview("다음 일정", as: .systemSmall) {
    HermesNextEventWidget()
} timeline: {
    HermesWidgetEntry(date: Date(), snapshot: .sampleDesignSnapshot)
}

#Preview("에이전트", as: .systemSmall) {
    HermesAgentStatusWidget()
} timeline: {
    HermesWidgetEntry(date: Date(), snapshot: .sampleDesignSnapshot)
}
