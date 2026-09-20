// Nexus Redline — app companheiro de menu bar do NexusIDE.
// Lê ~/.nexus/redline-last-good.json (escrito pelo quota-service do Nexus)
// e mostra, no topo do Mac, a folga de cada conta de IA: barras 5h/semana,
// cores de urgência e cronômetro até o reset. Clique abre o menu com as quotas.
//
// Read-only sobre os dados: nunca lê Keychain, nunca renova token, nunca fala
// com provider. Único efeito colateral: o arquivo-sinal de refresh quando
// você pede "↺ Atualizar".
//
// Bundle: com.nexuside.redline — LSUIElement (sem dock), macOS 14+.

import AppKit
import ServiceManagement

// MARK: - Modelo (espelho de src/shared/redline-types.ts)

struct RedlineWindow: Codable {
    let kind: String
    let label: String
    let usedRatio: Double?
    let resetsAt: Double?
}

struct RedlineDecisiveWindow: Codable {
    let label: String
    let effectiveUsedRatio: Double
    let resetsAt: Double?
}

struct RedlineEntry: Codable {
    let id: String
    let adapterId: String
    let accountId: String?
    let label: String
    let emailMasked: String?
    let active: Bool
    let installed: Bool
    let onCooldown: Bool
    let cooldownUntil: Double?
    let windows: [RedlineWindow]
    let updatedAt: Double
    let eligible: Bool
    let excludedReason: String?
    let headroom: Double?
    let decisiveWindow: RedlineDecisiveWindow?
}

struct RedlineRankingRow: Codable {
    let entryId: String
    let adapterId: String
    let label: String
    let emailMasked: String?
    let headroom: Double
    let decisiveWindow: RedlineDecisiveWindow?
    let minutesToReset: Double?
}

struct RedlineSnapshotFile: Codable {
    let formatVersion: Int
    let generatedBy: String
    let updatedAt: Double
    let worstUsedRatio: Double?
    let entries: [RedlineEntry]
    let ranking: [String: [RedlineRankingRow]]
    let statusBarEntryIds: [String]?
}

// MARK: - Caminhos

let homeDir = FileManager.default.homeDirectoryForCurrentUser
let nexusDir = homeDir.appendingPathComponent(".nexus", isDirectory: true)
let snapshotURL = nexusDir.appendingPathComponent("redline-last-good.json")
let refreshRequestURL = nexusDir.appendingPathComponent("redline-refresh.request")

/// Nexus considerado offline quando o último snapshot é mais velho que isso.
let staleThreshold: TimeInterval = 10 * 60

// MARK: - Formatação

let providerGlyphs: [String: String] = [
    "claude": "✳", "codex": "❋", "openai": "❋", "grok": "𝕏",
    "kimi": "K", "gemini": "✦", "glm": "G", "antigravity": "▲", "agy": "▲",
    "cursor": "▣", "opencode": "⌘", "aider": "A", "longcat": "L",
]

func glyph(for adapterId: String) -> String {
    providerGlyphs[adapterId] ?? "●"
}

/// Letrinha inicial do email mascarado quando há conta (estilo do original).
func initial(for entry: RedlineEntry) -> String {
    guard let masked = entry.emailMasked, !masked.isEmpty, masked != "***" else { return "" }
    let first = String(masked.prefix(1)).lowercased()
    return " \(first)"
}

func color(hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

/// O menu nativo segue a aparência do macOS e no claro os tons de sistema
/// lavam sobre o branco (systemGreen ≈3:1 em texto pequeno). Resolvemos a
/// paleta na montagem — o menu é reconstruído a cada abertura — e o KVO de
/// effectiveAppearance repinta a faixa ao trocar de tema. No escuro ficam os
/// tons do sistema; no claro, variantes escuras ≥4.5:1.
func prefersDarkMenu() -> Bool {
    NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
}

func urgencyColor(forUsed used: Double?) -> NSColor {
    let dark = prefersDarkMenu()
    guard let used else { return dark ? .systemGray : color(hex: 0x6E6E73) }
    if used >= 0.85 { return dark ? .systemRed : color(hex: 0xB3382C) }
    if used >= 0.60 { return dark ? .systemOrange : color(hex: 0x9A5B00) }
    return dark ? .systemGreen : color(hex: 0x1B7A3D)
}

/// Melhor janela de um tipo ("hours" = 5h, "weekly" = semana).
func window(_ entry: RedlineEntry, kind: String) -> RedlineWindow? {
    entry.windows.first { $0.kind == kind && $0.usedRatio != nil }
        ?? entry.windows.first { $0.kind == kind }
}

/// "38m", "12h", "6d" — quanto falta pro reset.
func countdown(_ resetsAt: Double?) -> String {
    guard let resetsAt else { return "–" }
    let remaining = resetsAt - Date.now.timeIntervalSince1970 * 1000
    if remaining <= 0 { return "agora" }
    let minutes = remaining / 60_000
    if minutes < 60 { return "\(Int(minutes.rounded(.up)))m" }
    let hours = minutes / 60
    if hours < 48 { return "\(Int(hours.rounded(.up)))h" }
    return "\(Int((hours / 24).rounded(.up)))d"
}

func pct(_ used: Double?) -> String {
    guard let used else { return "?" }
    return "\(Int((used * 100).rounded()))%"
}

/// Barra de 5 blocos: ▮ preenchidos conforme o uso.
func bars(for used: Double?) -> (text: String, color: NSColor) {
    guard let used else { return ("·····", .systemGray) }
    let clamped = min(1, max(0, used))
    let filled = Int((clamped * 5).rounded())
    let text = String(repeating: "▮", count: filled) + String(repeating: "░", count: 5 - filled)
    return (text, urgencyColor(forUsed: used))
}

func ageLabel(_ updatedAt: Double) -> String {
    let age = Date.now.timeIntervalSince1970 * 1000 - updatedAt
    let seconds = Int(age / 1000)
    if seconds < 90 { return "agora mesmo" }
    let minutes = seconds / 60
    if minutes < 60 { return "há \(minutes) min" }
    let hours = minutes / 60
    if hours < 36 { return "há \(hours)h" }
    return "há \(hours / 24)d"
}

// MARK: - Status item

func attributedSegment(entry: RedlineEntry) -> NSAttributedString {
    let fiveH = window(entry, kind: "hours") ?? window(entry, kind: "session")
    let week = window(entry, kind: "weekly") ?? window(entry, kind: "monthly")

    let base: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium),
        .baselineOffset: 0.5,
    ]
    let text = NSMutableAttributedString(string: "\(glyph(for: entry.adapterId))\(initial(for: entry)) ", attributes: base)

    for win in [fiveH, week].compactMap({ $0 }) {
        let bar = bars(for: win.usedRatio)
        text.append(NSAttributedString(string: bar.text, attributes: base.merge([.foregroundColor: bar.color])))
        text.append(NSAttributedString(string: " \(countdown(win.resetsAt)) ", attributes: base.merge([.foregroundColor: NSColor.secondaryLabelColor])))
    }
    if fiveH == nil && week == nil {
        text.append(NSAttributedString(string: "sem leitura ", attributes: base.merge([.foregroundColor: NSColor.systemGray])))
    }
    return text
}

extension Dictionary where Key == NSAttributedString.Key, Value == Any {
    func merge(_ other: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any] {
        var copy = self
        for (key, value) in other { copy[key] = value }
        return copy
    }
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var snapshot: RedlineSnapshotFile?
    var watchSource: DispatchSourceFileSystemObject?
    var pollTimer: Timer?
    /// Guarda o estado do login item sem depender de SMAppService a cada paint.
    var launchAtLoginEnabled = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu

        refreshLaunchAtLoginState()
        reloadSnapshot()
        startWatching()
        // Tema do macOS mudou → faixa repinta com a paleta da nova aparência
        // (o menu em si já remonta a cada abertura, via menuNeedsUpdate).
        _ = NSApp.observe(\.effectiveAppearance, options: []) { [weak self] _, _ in
            DispatchQueue.main.async { self?.renderStatusItem() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        watchSource?.cancel()
        pollTimer?.invalidate()
    }

    // MARK: Leitura + observação do snapshot

    func reloadSnapshot() {
        guard let data = try? Data(contentsOf: snapshotURL),
              let decoded = try? JSONDecoder().decode(RedlineSnapshotFile.self, from: data)
        else {
            snapshot = nil
            renderStatusItem()
            return
        }
        snapshot = decoded
        renderStatusItem()
    }

    func startWatching() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.reloadSnapshotIfChanged()
        }
        let fd = open(snapshotURL.path, O_RDONLY)
        if fd >= 0 {
            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .rename, .delete],
                queue: .main
            )
            source.setEventHandler { [weak self] in self?.reloadSnapshot() }
            source.setCancelHandler { close(fd) }
            source.resume()
            watchSource = source
        }
    }

    /// O DispatchSource morre se o Nexus substituir o arquivo por rename —
    /// o poll de 2s é a rede de segurança e reabre o watch.
    func reloadSnapshotIfChanged() {
        if watchSource == nil { startWatching() }
        reloadSnapshot()
    }

    // MARK: Desenho da barra

    func isStale() -> Bool {
        guard let snap = snapshot else { return true }
        let age = Date.now.timeIntervalSince1970 * 1000 - snap.updatedAt
        return age / 1000 > staleThreshold
    }

    func entriesForBar(_ snap: RedlineSnapshotFile) -> [RedlineEntry] {
        if let ids = snap.statusBarEntryIds, !ids.isEmpty {
            let wanted = Set(ids)
            return snap.entries.filter { wanted.contains($0.id) }
        }
        return Array(snap.entries.filter { entry in
            entry.windows.contains { $0.usedRatio != nil }
        }.prefix(6))
    }

    func renderStatusItem() {
        guard let button = statusItem.button else { return }
        let compact: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold),
            .foregroundColor: NSColor.systemGray
        ]
        guard let snap = snapshot, !snap.entries.isEmpty else {
            button.attributedTitle = NSAttributedString(string: " ⬡ ", attributes: compact)
            button.toolTip = "Nexus Redline — sem dados do Nexus ainda"
            return
        }

        let bar = entriesForBar(snap)
        if bar.isEmpty {
            button.attributedTitle = NSAttributedString(
                string: " ⬡ \(snap.entries.count) ",
                attributes: compact
            )
            button.toolTip = "Nexus Redline — \(snap.entries.count) contas, ainda sem leitura de cota"
            return
        }

        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
        ]
        let title = NSMutableAttributedString()
        if isStale() {
            title.append(NSAttributedString(string: "◌ ", attributes: base.merge([.foregroundColor: NSColor.systemGray])))
        }
        for entry in bar {
            title.append(attributedSegment(entry: entry))
            title.append(NSAttributedString(string: "│", attributes: base.merge([.foregroundColor: NSColor.separatorColor])))
        }
        title.deleteCharacters(in: NSRange(location: title.length - 1, length: 1))
        button.attributedTitle = title
        button.toolTip = "Nexus Redline — \(bar.count) com leitura · \(snap.entries.count) contas · \(ageLabel(snap.updatedAt))"
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu(menu)
    }

    func rebuildMenu(_ menu: NSMenu) {
        menu.removeAllItems()

        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        ]
        let bold: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        ]

        guard let snap = snapshot, !snap.entries.isEmpty else {
            let item = NSMenuItem()
            item.attributedTitle = NSAttributedString(
                string: "Sem dados ainda — abra o Nexus",
                attributes: base.merge([.foregroundColor: NSColor.secondaryLabelColor])
            )
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(.separator())
            addCommonItems(to: menu)
            return
        }

        let freshness = isStale() ? " · Nexus offline" : ""
        let header = NSMenuItem()
        header.attributedTitle = NSAttributedString(
            string: "⬡ Nexus Redline · \(ageLabel(snap.updatedAt))\(freshness)",
            attributes: bold.merge([.foregroundColor: NSColor.secondaryLabelColor])
        )
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        // Ranking primeiro: "qual conta usar agora" é a pergunta do menu.
        if let best = bestRankingRow(snap) {
            let rec = NSMenuItem()
            rec.attributedTitle = NSAttributedString(
                string: "⚑ Recomendada: \(shortLabel(best)) — folga \(Int((best.headroom * 100).rounded()))%",
                attributes: bold.merge([.foregroundColor: NSColor.systemGreen])
            )
            rec.isEnabled = false
            menu.addItem(rec)
            menu.addItem(.separator())
        }

        for entry in snap.entries {
            for item in entryItems(entry, base: base) {
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        addCommonItems(to: menu)
    }

    func bestRankingRow(_ snap: RedlineSnapshotFile) -> RedlineRankingRow? {
        snap.ranking.values.flatMap { $0 }.max { $0.headroom < $1.headroom }
    }

    func shortLabel(_ row: RedlineRankingRow) -> String {
        let initialPart = row.emailMasked.map { " \(String($0.prefix(2)))…" } ?? ""
        return "\(glyph(for: row.adapterId))\(initialPart)"
    }

    /// Item da conta + itens de detalhe (um por janela com leitura).
    func entryItems(_ entry: RedlineEntry, base: [NSAttributedString.Key: Any]) -> [NSMenuItem] {
        let item = NSMenuItem()
        let state: String
        if entry.onCooldown {
            state = " · cooldown \(countdown(entry.cooldownUntil))"
        } else if let reason = entry.excludedReason {
            switch reason {
            case "no-credential": state = " · sem credencial"
            case "needs-relogin": state = " · sessão expirada"
            case "cooldown": state = " · cooldown"
            case "unknown-usage": state = " · sem leitura"
            default: state = ""
            }
        } else {
            state = ""
        }

        let title = NSMutableAttributedString(
            string: "\(glyph(for: entry.adapterId)) \(entry.label)\(state)",
            attributes: base.merge(state.isEmpty ? [:] : [.foregroundColor: NSColor.secondaryLabelColor])
        )
        item.attributedTitle = title
        item.isEnabled = false

        var items = [item]
        let detailFont: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize - 1, weight: .regular)
        ]
        for win in entry.windows where win.usedRatio != nil {
            let bar = bars(for: win.usedRatio)
            let detail = NSMenuItem()
            let label = win.label.padding(toLength: 10, withPad: " ", startingAt: 0)
            // Barra no tom de urgência; número e reset em labelColor —
            // a leitura não pode depender só da cor (doutrina de estado).
            let line = NSMutableAttributedString(string: "   \(label) ")
            line.append(NSAttributedString(
                string: bar.text,
                attributes: detailFont.merge([.foregroundColor: bar.color])
            ))
            line.append(NSAttributedString(
                string: "  \(pct(win.usedRatio)) · reseta em \(countdown(win.resetsAt))",
                attributes: detailFont.merge([.foregroundColor: NSColor.labelColor])
            ))
            detail.attributedTitle = line
            detail.isEnabled = false
            detail.indentationLevel = 1
            items.append(detail)
        }
        return items
    }

    func addCommonItems(to menu: NSMenu) {
        let refresh = NSMenuItem(title: "↺  Atualizar agora", action: #selector(requestRefresh), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)

        let openNexus = NSMenuItem(title: "⬡  Abrir quotas no Nexus", action: #selector(openNexusApp), keyEquivalent: "o")
        openNexus.target = self
        menu.addItem(openNexus)

        menu.addItem(.separator())

        let login = NSMenuItem(title: launchAtLoginEnabled ? "✓  Iniciar com o macOS" : "   Iniciar com o macOS",
                               action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self
        menu.addItem(login)

        let quit = NSMenuItem(title: "⏻  Sair do Redline", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    // MARK: Ações

    @objc func requestRefresh() {
        try? FileManager.default.createDirectory(at: nexusDir, withIntermediateDirectories: true)
        let data = Data("{\"source\":\"menubar\",\"at\":\(Int(Date.now.timeIntervalSince1970 * 1000))}\n".utf8)
        FileManager.default.createFile(atPath: refreshRequestURL.path, contents: data)
        // Feedback: Nexus responde escrevendo o snapshot de novo (watch pega).
        reloadSnapshotIfChanged()
    }

    @objc func openNexusApp() {
        if let url = URL(string: "nexus://quota") {
            NSWorkspace.shared.open(url)
        }
    }

    func refreshLaunchAtLoginState() {
        launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    }

    @objc func toggleLaunchAtLogin() {
        refreshLaunchAtLoginState()
        do {
            if launchAtLoginEnabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Não foi possível \(launchAtLoginEnabled ? "desativar" : "ativar") o início automático"
            alert.informativeText = "Instale o app em /Applications e tente de novo. (\(error.localizedDescription))"
            alert.runModal()
        }
        refreshLaunchAtLoginState()
    }
}

// MARK: - Bootstrap

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
