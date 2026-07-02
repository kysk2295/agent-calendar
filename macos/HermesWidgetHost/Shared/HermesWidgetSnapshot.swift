import Foundation

struct HermesWidgetSnapshot: Codable, Hashable {
    var todayDate: String
    var tasks: [HermesWidgetTask]
    var runs: [HermesWidgetRun]
    var updatedAt: Date

    var todayTasks: [HermesWidgetTask] {
        tasks
            .filter { $0.date == todayDate }
            .sorted { lhs, rhs in
                if lhs.done != rhs.done { return !lhs.done }
                return (lhs.time ?? "99:99", lhs.title) < (rhs.time ?? "99:99", rhs.title)
            }
    }

    var monthItems: [HermesWidgetTask] {
        let prefix = String(todayDate.prefix(7))
        return tasks.filter { $0.date.hasPrefix(prefix) }
    }

    var nextEvent: HermesWidgetTask? {
        tasks
            .filter { !$0.done && $0.time != nil && $0.date >= todayDate }
            .sorted { lhs, rhs in
                "\(lhs.date) \(lhs.time ?? "")" < "\(rhs.date) \(rhs.time ?? "")"
            }
            .first
    }

    var runningRuns: [HermesWidgetRun] {
        runs.filter { $0.status.localizedCaseInsensitiveContains("running") || $0.status.contains("실행") || $0.status.contains("진행") }
    }

    var reviewPending: Int {
        tasks.filter { $0.status.localizedCaseInsensitiveContains("review") || $0.status.contains("검토") }.count
    }
}

struct HermesWidgetTask: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var date: String
    var time: String?
    var owner: HermesWidgetOwner
    var list: String
    var status: String
    var done: Bool
    var durationMinutes: Int?
    var source: String?
}

struct HermesWidgetRun: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var status: String
    var progress: Int
}

struct HermesWidgetAction: Codable, Identifiable, Hashable {
    var id: String
    var type: String
    var createdAt: Date
    var taskID: String?
    var date: String?
    var screen: String?
    var runID: String?
    var source: String?
    var done: Bool?

    init(type: String, taskID: String? = nil, date: String? = nil, screen: String? = nil, runID: String? = nil, source: String? = nil, done: Bool? = nil) {
        self.id = UUID().uuidString
        self.type = type
        self.createdAt = Date()
        self.taskID = taskID
        self.date = date
        self.screen = screen
        self.runID = runID
        self.source = source
        self.done = done
    }
}

enum HermesWidgetOwner: String, Codable, Hashable {
    case me
    case agent
    case hybrid
    case weekend
}

enum HermesWidgetStore {
    static let appGroupID = "group.com.hermes.tasks"
    static let snapshotKey = "HermesWidgetSnapshot.v1"
    static let snapshotFileName = "HermesWidgetSnapshot.json"
    static let actionsFileName = "HermesWidgetActions.json"

    static var snapshotFileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent(snapshotFileName)
    }

    static var actionsFileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent(actionsFileName)
    }

    static var hasPersistedSnapshot: Bool {
        guard let url = snapshotFileURL else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    static func load() -> HermesWidgetSnapshot {
        if
            let url = snapshotFileURL,
            let data = try? Data(contentsOf: url),
            let snapshot = try? decoder.decode(HermesWidgetSnapshot.self, from: data)
        {
            return snapshot
        }
        guard
            let defaults = UserDefaults(suiteName: appGroupID),
            let data = defaults.data(forKey: snapshotKey),
            let snapshot = try? decoder.decode(HermesWidgetSnapshot.self, from: data)
        else {
            return .emptySnapshot
        }
        return snapshot
    }

    static func save(_ snapshot: HermesWidgetSnapshot) {
        guard
            let defaults = UserDefaults(suiteName: appGroupID),
            let data = try? encoder.encode(snapshot)
        else {
            return
        }
        if let url = snapshotFileURL {
            try? data.write(to: url, options: [.atomic])
        }
        defaults.set(data, forKey: snapshotKey)
    }

    static func enqueueAction(_ action: HermesWidgetAction) {
        guard let url = actionsFileURL else { return }
        var actions: [HermesWidgetAction] = []
        if
            let data = try? Data(contentsOf: url),
            let decoded = try? decoder.decode([HermesWidgetAction].self, from: data)
        {
            actions = decoded
        }
        actions.append(action)
        guard let data = try? encoder.encode(actions) else { return }
        try? data.write(to: url, options: [.atomic])
    }

    static func toggleTask(_ taskID: String) -> HermesWidgetTask? {
        var snapshot = load()
        var updatedTask: HermesWidgetTask?
        snapshot.tasks = snapshot.tasks.map { task in
            guard task.id == taskID else { return task }
            var next = task
            next.done.toggle()
            next.status = next.done ? "Done" : "Planned"
            updatedTask = next
            return next
        }
        snapshot.updatedAt = Date()
        save(snapshot)
        return updatedTask
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension HermesWidgetSnapshot {
    static var emptySnapshot: HermesWidgetSnapshot {
        HermesWidgetSnapshot(
            todayDate: Self.todayKey(),
            tasks: [],
            runs: [],
            updatedAt: Date()
        )
    }

    private static func todayKey() -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    static let sampleDesignSnapshot = HermesWidgetSnapshot(
        todayDate: "2026-07-01",
        tasks: [
            HermesWidgetTask(id: "idea", title: "창업 아이디어 정리", date: "2026-07-01", time: nil, owner: .hybrid, list: "UniPort", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "meeting", title: "마케팅 회의", date: "2026-07-01", time: "13:00", owner: .me, list: "UniPort", status: "Planned", done: false, durationMinutes: 30, source: "task"),
            HermesWidgetTask(id: "research", title: "경쟁사 리서치", date: "2026-07-01", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "adsp", title: "ADsP 접수", date: "2026-07-01", time: nil, owner: .me, list: "Me", status: "Done", done: true, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "mate-2", title: "MATE", date: "2026-07-02", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "mate-3", title: "MATE", date: "2026-07-03", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "independ-3", title: "Independ", date: "2026-07-03", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "weekend-4", title: "주말", date: "2026-07-04", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "mate-4", title: "MATE", date: "2026-07-04", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "independ-4", title: "Independ", date: "2026-07-04", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "mate-5", title: "MATE", date: "2026-07-05", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "adsp-6", title: "adsp 접수", date: "2026-07-06", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "phone-6", title: "알뜰폰 요금", date: "2026-07-06", time: nil, owner: .hybrid, list: "Me", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "holiday-17", title: "제헌절", date: "2026-07-17", time: nil, owner: .me, list: "Calendar", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "weekend-18", title: "주말", date: "2026-07-18", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "weekend-25", title: "주말", date: "2026-07-25", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil, source: "task"),
            HermesWidgetTask(id: "weekend-31", title: "주말", date: "2026-07-31", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil, source: "task")
        ],
        runs: [
            HermesWidgetRun(id: "run-research", title: "경쟁사 리서치", status: "running", progress: 72),
            HermesWidgetRun(id: "run-copy", title: "광고 카피 변환", status: "running", progress: 31)
        ],
        updatedAt: Date()
    )
}
