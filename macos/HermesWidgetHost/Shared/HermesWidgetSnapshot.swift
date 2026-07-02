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
}

struct HermesWidgetRun: Codable, Identifiable, Hashable {
    var id: String
    var title: String
    var status: String
    var progress: Int
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

    static var snapshotFileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
            .appendingPathComponent(snapshotFileName)
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

    static func toggleTask(_ taskID: String) {
        var snapshot = load()
        snapshot.tasks = snapshot.tasks.map { task in
            guard task.id == taskID else { return task }
            var next = task
            next.done.toggle()
            next.status = next.done ? "Done" : "Planned"
            return next
        }
        snapshot.updatedAt = Date()
        save(snapshot)
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
            HermesWidgetTask(id: "idea", title: "창업 아이디어 정리", date: "2026-07-01", time: nil, owner: .hybrid, list: "UniPort", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "meeting", title: "마케팅 회의", date: "2026-07-01", time: "13:00", owner: .me, list: "UniPort", status: "Planned", done: false, durationMinutes: 30),
            HermesWidgetTask(id: "research", title: "경쟁사 리서치", date: "2026-07-01", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "adsp", title: "ADsP 접수", date: "2026-07-01", time: nil, owner: .me, list: "Me", status: "Done", done: true, durationMinutes: nil),
            HermesWidgetTask(id: "mate-2", title: "MATE", date: "2026-07-02", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "mate-3", title: "MATE", date: "2026-07-03", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "independ-3", title: "Independ", date: "2026-07-03", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "weekend-4", title: "주말", date: "2026-07-04", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "mate-4", title: "MATE", date: "2026-07-04", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "independ-4", title: "Independ", date: "2026-07-04", time: nil, owner: .agent, list: "Hermes", status: "Running", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "mate-5", title: "MATE", date: "2026-07-05", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "adsp-6", title: "adsp 접수", date: "2026-07-06", time: nil, owner: .me, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "phone-6", title: "알뜰폰 요금", date: "2026-07-06", time: nil, owner: .hybrid, list: "Me", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "holiday-17", title: "제헌절", date: "2026-07-17", time: nil, owner: .me, list: "Calendar", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "weekend-18", title: "주말", date: "2026-07-18", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "weekend-25", title: "주말", date: "2026-07-25", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil),
            HermesWidgetTask(id: "weekend-31", title: "주말", date: "2026-07-31", time: nil, owner: .weekend, list: "Weekend", status: "Planned", done: false, durationMinutes: nil)
        ],
        runs: [
            HermesWidgetRun(id: "run-research", title: "경쟁사 리서치", status: "running", progress: 72),
            HermesWidgetRun(id: "run-copy", title: "광고 카피 변환", status: "running", progress: 31)
        ],
        updatedAt: Date()
    )
}
