import AppKit
import SwiftUI
import WidgetKit

final class HermesWidgetHostDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
        WidgetCenter.shared.reloadAllTimelines()
        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
    }
}

@main
struct HermesWidgetHostApp: App {
    @NSApplicationDelegateAdaptor(HermesWidgetHostDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
