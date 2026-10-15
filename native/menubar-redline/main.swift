// Nexus Redline — app companheiro de menu bar do NexusIDE.
// Lê ~/.nexus/redline-last-good.json (escrito pelo quota-service do Nexus)
// e mostra, no topo do Mac, a folga de cada conta de IA: barras 5h/semana,
// cores de urgência e cronômetro até o reset num painel vertical com rolagem.
//
// Read-only sobre os dados: nunca lê Keychain, nunca renova token, nunca fala
// com provider. Único efeito colateral: o arquivo-sinal de refresh quando
// você pede "↺ Atualizar".
//
// Bundle: com.nexuside.redline — LSUIElement (sem dock), macOS 14+.

import AppKit
import ServiceManagement

// MARK: - Modelo (espelho de src/shared/redline-types.ts)

struct RedlineWindow: Codable, Equatable {
    let kind: String
    let label: String
    let usedRatio: Double?
    let resetsAt: Double?
    var estimated: Bool? = nil
}

struct RedlineDecisiveWindow: Codable, Equatable {
    let label: String
    let effectiveUsedRatio: Double
    let resetsAt: Double?
}

struct RedlineEntry: Codable, Equatable {
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
    var readHint: String? = nil
}

struct RedlineRankingRow: Codable, Equatable {
    let entryId: String
    let adapterId: String
    let label: String
    let emailMasked: String?
    let headroom: Double
    let decisiveWindow: RedlineDecisiveWindow?
    let minutesToReset: Double?
}

struct RedlineSnapshotFile: Codable, Equatable {
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
    "minimax-code": "M",
]

func glyph(for adapterId: String) -> String {
    providerGlyphs[adapterId] ?? "●"
}

func color(hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

/// Resolve pela aparência da superfície que desenha, não pela do processo.
/// A barra pode ser clara mesmo com o app escuro (papel de parede do macOS).
func urgencyColor(forUsed used: Double?) -> NSColor {
    NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        guard let used else { return dark ? color(hex: 0xAAAAAF) : color(hex: 0x515154) }
        if used >= 0.8 { return dark ? color(hex: 0xFF8178) : color(hex: 0xB3382C) }
        if used >= 0.5 { return dark ? color(hex: 0xE5C07B) : color(hex: 0x9A5B00) }
        return dark ? color(hex: 0x7EE2A8) : color(hex: 0x1B7A3D)
    }
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
    guard let used else { return ("·····", urgencyColor(forUsed: nil)) }
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

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var snapshot: RedlineSnapshotFile?
    var watchSource: DispatchSourceFileSystemObject?
    var pollTimer: Timer?
    let popover = NSPopover()
    lazy var quotaPanel: QuotaPanelController = {
        let panel = QuotaPanelController(target: self)
        // Ampliar/Reduzir muda o tamanho e o comportamento do popover.
        panel.onPreferredSizeChange = { [weak self] in self?.applyPanelMode() }
        return panel
    }()
    /// Guarda o estado do login item sem depender de SMAppService a cada paint.
    var launchAtLoginEnabled = false
    /// NSKeyValueObservation morre ao sair de escopo: sem reter aqui, trocar o
    /// tema do macOS nunca repinta a faixa (F-029).
    var appearanceObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        popover.behavior = .transient
        // O painel é Nexus-escuro sempre: chrome e seta do popover acompanham.
        popover.appearance = NSAppearance(named: .darkAqua)
        popover.contentViewController = quotaPanel

        refreshLaunchAtLoginState()
        reloadSnapshot()
        startWatching()
        startObservingAppearance()
    }

    /// Tema do macOS mudou → repinta a faixa/tooltip com a nova aparência.
    func startObservingAppearance() {
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: []) { [weak self] _, _ in
            DispatchQueue.main.async { self?.renderStatusItem() }
        }
    }

    @objc func togglePanel() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let button = statusItem.button else { return }
        reloadSnapshot()
        refreshLaunchAtLoginState()
        // Sempre abre compacto: o ampliado é uma decisão do momento (print).
        quotaPanel.resetToCompact()
        // Keep the whole panel on the screen containing the status item.
        if let visible = button.window?.screen?.visibleFrame.size {
            quotaPanel.availableScreenSize = visible
        }
        quotaPanel.update(snapshot: snapshot, launchAtLogin: launchAtLoginEnabled)
        popover.behavior = .transient
        popover.contentSize = quotaPanel.preferredContentSize()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    /// Ampliado vira o painel do print: um clique fora (ou o próprio atalho de
    /// captura) não pode fechá-lo, então o popover deixa de ser transient. Quem
    /// fecha é o ícone da barra, o "Abrir no Nexus" ou o botão Reduzir.
    func applyPanelMode() {
        popover.behavior = quotaPanel.isExpanded ? .applicationDefined : .transient
        let size = quotaPanel.preferredContentSize()
        if popover.contentSize != size { popover.contentSize = size }
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
            if popover.isShown { quotaPanel.update(snapshot: nil, launchAtLogin: launchAtLoginEnabled) }
            return
        }
        snapshot = decoded
        renderStatusItem()
        if popover.isShown { quotaPanel.update(snapshot: decoded, launchAtLogin: launchAtLoginEnabled) }
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

    /// Contas que a faixa resume: as que o quota-service escolheu em
    /// `statusBarEntryIds` (teto 6 — F-612); sem a lista, as primeiras seis
    /// com leitura. A pior janela dessas contas vira o resumo da barra —
    /// varrer o snapshot inteiro mostraria cota de conta que a faixa não cobre.
    func entriesForBar(_ snap: RedlineSnapshotFile) -> [RedlineEntry] {
        if let ids = snap.statusBarEntryIds, !ids.isEmpty {
            let wanted = Set(ids)
            return snap.entries.filter { wanted.contains($0.id) }
        }
        return Array(snap.entries.filter { entry in
            entry.windows.contains { $0.usedRatio != nil && $0.estimated != true }
        }.prefix(6))
    }

    func renderStatusItem() {
        guard let button = statusItem.button else { return }
        button.image = nil
        let compact: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold),
            .foregroundColor: urgencyColor(forUsed: nil)
        ]
        let count = snapshot?.entries.count ?? 0
        let freshness = snapshot.map { ageLabel($0.updatedAt) } ?? "sem dados do Nexus"
        let offline = isStale() && snapshot != nil ? " · Nexus offline" : ""
        button.toolTip = "Nexus Redline · \(count) contas · \(freshness)\(offline). Clique para ver todas as cotas."

        guard let snap = snapshot, !snap.entries.isEmpty else {
            button.attributedTitle = NSAttributedString(string: " ⬡ ", attributes: compact)
            button.setAccessibilityLabel("Nexus Redline, sem dados. Abrir cotas")
            return
        }

        // A faixa é UM resumo — a pior janela entre as contas da faixa. O
        // detalhe de cada conta mora no painel; aqui cabe só o aperto máximo.
        var worst: (entry: RedlineEntry, window: RedlineWindow)?
        for entry in entriesForBar(snap) {
            for win in entry.windows
            where ["hours", "session", "weekly", "monthly", "credits"].contains(win.kind) && win.estimated != true {
                guard let used = win.usedRatio else { continue }
                if used > (worst?.window.usedRatio ?? -1) { worst = (entry, win) }
            }
        }
        guard let worst else {
            button.attributedTitle = NSAttributedString(
                string: " ⬡ \(snap.entries.count) ", attributes: compact
            )
            button.setAccessibilityLabel("Nexus Redline, \(count) contas, sem leitura. Abrir cotas")
            return
        }

        let base: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .medium)
        ]
        let labelInk = base.merging([.foregroundColor: NSColor.labelColor]) { _, new in new }
        let title = NSMutableAttributedString()
        if isStale() {
            title.append(NSAttributedString(string: "◌ ", attributes: compact))
        }
        title.append(NSAttributedString(string: "\(glyph(for: worst.entry.adapterId)) ", attributes: labelInk))
        let bar = bars(for: worst.window.usedRatio)
        title.append(NSAttributedString(string: bar.text, attributes: base.merging(
            [.foregroundColor: bar.color]) { _, new in new }))
        title.append(NSAttributedString(string: " \(pct(worst.window.usedRatio))", attributes: labelInk))
        button.attributedTitle = title
        button.setAccessibilityLabel(
            "Nexus Redline, \(count) contas, pior leitura \(pct(worst.window.usedRatio)) em \(worst.entry.label). Abrir cotas"
        )
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
        popover.performClose(nil)
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
        quotaPanel.update(snapshot: snapshot, launchAtLogin: launchAtLoginEnabled)
    }
}

// MARK: - Bootstrap

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
