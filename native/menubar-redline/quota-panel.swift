import AppKit

private final class PanelBackground: NSView {
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}

private final class AccountList: NSStackView {
    override var isFlipped: Bool { true }
}

/// A bounded, opaque surface: quotas are ordinary labels, never disabled menu
/// actions. Only the account list scrolls; refresh and app controls stay visible.
final class QuotaPanelController: NSViewController {
    private let titleLabel = NSTextField(labelWithString: "Nexus Redline")
    private let summaryLabel = NSTextField(labelWithString: "")
    private let freshnessLabel = NSTextField(labelWithString: "")
    private let recommendationLabel = NSTextField(labelWithString: "")
    let scrollView = NSScrollView()
    private let accounts = AccountList()
    private let refreshButton: NSButton
    private let openButton: NSButton
    private let loginButton: NSButton
    private let quitButton: NSButton
    private var renderedSnapshot: RedlineSnapshotFile?
    private var hasRendered = false
    private var updateCountdowns: [() -> Void] = []

    init(target: AppDelegate) {
        refreshButton = NSButton(title: "Atualizar agora", target: target, action: #selector(AppDelegate.requestRefresh))
        openButton = NSButton(title: "Abrir no Nexus", target: target, action: #selector(AppDelegate.openNexusApp))
        loginButton = NSButton(checkboxWithTitle: "Iniciar com o macOS", target: target, action: #selector(AppDelegate.toggleLaunchAtLogin))
        quitButton = NSButton(title: "Sair", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = PanelBackground(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        summaryLabel.font = .systemFont(ofSize: 12)
        freshnessLabel.font = .systemFont(ofSize: 12)
        summaryLabel.textColor = .labelColor
        freshnessLabel.textColor = urgencyColor(forUsed: nil)
        recommendationLabel.font = .systemFont(ofSize: 12, weight: .medium)
        recommendationLabel.textColor = .labelColor
        recommendationLabel.lineBreakMode = .byTruncatingTail

        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy
        scrollView.drawsBackground = false
        scrollView.setAccessibilityLabel("Contas e cotas de todos os provedores")
        accounts.orientation = .vertical
        accounts.alignment = .leading
        accounts.spacing = 16
        accounts.detachesHiddenViews = true
        scrollView.documentView = accounts

        for button in [refreshButton, openButton, quitButton] { button.bezelStyle = .rounded }
        refreshButton.keyEquivalent = "r"
        openButton.keyEquivalent = "o"
        quitButton.keyEquivalent = "q"
        for child in [titleLabel, summaryLabel, freshnessLabel, recommendationLabel,
                      scrollView, refreshButton, openButton, loginButton, quitButton] {
            view.addSubview(child)
        }
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        let width = view.bounds.width
        let height = view.bounds.height
        titleLabel.frame = NSRect(x: 16, y: height - 40, width: width - 32, height: 24)
        summaryLabel.frame = NSRect(x: 16, y: height - 60, width: width - 32, height: 16)
        freshnessLabel.frame = NSRect(x: 16, y: height - 80, width: width - 32, height: 16)
        recommendationLabel.frame = NSRect(x: 16, y: height - 104, width: width - 32, height: 20)
        scrollView.frame = NSRect(x: 16, y: 96, width: width - 32, height: max(24, height - 212))
        refreshButton.frame = NSRect(x: 16, y: 52, width: 172, height: 32)
        openButton.frame = NSRect(x: width - 188, y: 52, width: 172, height: 32)
        loginButton.frame = NSRect(x: 16, y: 16, width: 260, height: 24)
        quitButton.frame = NSRect(x: width - 80, y: 12, width: 64, height: 32)
        layoutAccounts()
    }

    private func layoutAccounts() {
        let width = scrollView.contentSize.width
        accounts.setFrameSize(NSSize(width: width, height: accounts.fittingSize.height))
        accounts.layoutSubtreeIfNeeded()
    }

    func update(snapshot: RedlineSnapshotFile?, launchAtLogin: Bool) {
        loadViewIfNeeded()
        loginButton.state = launchAtLogin ? .on : .off
        let entries = snapshot?.entries ?? []
        let providers = Set(entries.map(\.adapterId)).count
        summaryLabel.stringValue = "\(providers) \(providers == 1 ? "provedor" : "provedores") · \(entries.count) \(entries.count == 1 ? "conta" : "contas")"
        if let snapshot {
            let stale = Date.now.timeIntervalSince1970 - snapshot.updatedAt / 1000 > staleThreshold
            freshnessLabel.stringValue = "Atualizado \(ageLabel(snapshot.updatedAt))\(stale ? " · Nexus offline" : "")"
        } else {
            freshnessLabel.stringValue = "Abra o Nexus para carregar suas cotas"
        }
        let best = snapshot?.ranking.values.flatMap { $0 }.max { $0.headroom < $1.headroom }
        recommendationLabel.stringValue = best.map {
            "Mais folga: \(providerName($0.adapterId)) · \($0.label) · \(Int(($0.headroom * 100).rounded()))%"
        } ?? "Uso por conta · role para ver todas"
        recommendationLabel.toolTip = recommendationLabel.stringValue

        // The file is polled every 2 seconds. An unchanged snapshot must not
        // rebuild the list or interrupt someone reading a lower account.
        for update in updateCountdowns { update() }
        guard !hasRendered || renderedSnapshot != snapshot else { return }
        let offset = scrollView.contentView.bounds.origin
        hasRendered = true
        renderedSnapshot = snapshot
        updateCountdowns.removeAll()
        for row in accounts.arrangedSubviews { accounts.removeArrangedSubview(row); row.removeFromSuperview() }
        if entries.isEmpty {
            addRow(label("Sem dados ainda. Abra o Nexus e atualize as cotas.", secondary: true))
        } else {
            for entry in entries { addRow(accountRow(entry)) }
        }
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: min(offset.y, max(0, accounts.frame.height - scrollView.contentSize.height))))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func addRow(_ row: NSView) {
        accounts.addArrangedSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.widthAnchor.constraint(equalTo: accounts.widthAnchor).isActive = true
    }

    private func label(_ text: String, secondary: Bool = false, bold: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: 12, weight: bold ? .semibold : .regular)
        field.textColor = secondary ? urgencyColor(forUsed: nil) : .labelColor
        field.preferredMaxLayoutWidth = 344
        field.maximumNumberOfLines = 0
        field.setContentCompressionResistancePriority(.required, for: .vertical)
        return field
    }

    private func accountRow(_ entry: RedlineEntry) -> NSView {
        let row = NSStackView()
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 4
        let provider = providerName(entry.adapterId)
        let title = entry.label.caseInsensitiveCompare(provider) == .orderedSame ? provider : "\(provider) · \(entry.label)"
        row.addArrangedSubview(label(title, bold: true))
        if let email = entry.emailMasked, !email.isEmpty, !entry.label.contains(email) {
            row.addArrangedSubview(label(email, secondary: true))
        }
        let state = accountState(entry)
        if !state.isEmpty {
            let statusLabel = label(state, secondary: true)
            row.addArrangedSubview(statusLabel)
            if entry.onCooldown {
                updateCountdowns.append { statusLabel.stringValue = accountState(entry) }
            }
        }

        if entry.windows.isEmpty { row.addArrangedSubview(label("Sem leitura de cota", secondary: true)) }
        for quota in entry.windows {
            let line = label("")
            // Gauge + leitura + reset na MESMA linha: com ~7 linhas por conta,
            // uma linha a menos por janela dobra as contas visíveis por tela.
            let render = {
                let text = NSMutableAttributedString()
                if let used = quota.usedRatio {
                    let bar = bars(for: used)
                    text.append(NSAttributedString(string: "\(bar.text)  ", attributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium),
                        .foregroundColor: bar.color,
                    ]))
                    var reading = "\(quota.label) · \(pct(used)) usado"
                    if quota.resetsAt != nil { reading += " · reseta em \(countdown(quota.resetsAt))" }
                    text.append(NSAttributedString(string: reading, attributes: [
                        .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor,
                    ]))
                } else {
                    text.append(NSAttributedString(string: "\(quota.label) · Sem leitura", attributes: [
                        .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor,
                    ]))
                }
                return text
            }
            line.attributedStringValue = render()
            row.addArrangedSubview(line)
            if quota.resetsAt != nil {
                updateCountdowns.append { line.attributedStringValue = render() }
            }
        }
        for child in row.arrangedSubviews {
            child.translatesAutoresizingMaskIntoConstraints = false
            child.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
        }
        return row
    }
}

private func accountState(_ entry: RedlineEntry) -> String {
    var states: [String] = []
    if entry.active { states.append("Conta ativa") }
    if entry.onCooldown { states.append("Em espera · \(countdown(entry.cooldownUntil))") }
    switch entry.excludedReason {
    case "no-credential": states.append("Sem credencial")
    case "needs-relogin": states.append("Sessão expirada")
    case "cooldown": if !entry.onCooldown { states.append("Em espera") }
    default: break
    }
    return states.joined(separator: " · ")
}

private func providerName(_ adapterId: String) -> String {
    switch adapterId {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "glm": return "GLM"
    case "opencode": return "OpenCode"
    case "agy", "antigravity": return "Antigravity"
    default: return adapterId.capitalized
    }
}
