import AppKit

// Painel escuro SEMPRE (tokens fixos do DESIGN.md): seguir o tema do macOS
// era o que deixava o painel branco e ilegível no claro — "nunca SaaS de
// cards brancos". A paleta da faixa na barra continua appearance-aware; a
// daqui não reusa urgencyColor porque a superfície é near-black fixa.

private func panelColor(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

private let panelText = panelColor(0xFAF7F9)
private let panelTextDim = panelColor(0xAAA2A8)
private let panelTextFaint = panelColor(0x928B90)
private let panelAccent = panelColor(0xFF4F8B)
private let panelWarn = panelColor(0xE5C07B)
private let panelOk = panelColor(0x7EE2A8)
private let panelDanger = panelColor(0xFF6B4A)
private let panelHairline = NSColor.white.withAlphaComponent(0.08)
private let panelHairlineStrong = NSColor.white.withAlphaComponent(0.16)

/// Respiro lateral das linhas de conta — o mesmo valor alimenta edgeInsets,
/// o separador e o pin de largura dos filhos. Se o pin pedir a largura cheia
/// da row, o Auto Layout honra um inset e quebra o outro (o filho desliza
/// ~16pt para a esquerda e o logo nasce clipado na borda do clip view).
private let rowHorizontalInset: CGFloat = 16

private func quotaInk(for used: Double?) -> NSColor {
    guard let used else { return panelTextFaint }
    if used >= 0.85 { return panelDanger }
    if used >= 0.60 { return panelWarn }
    return panelOk
}

/// Header e footer em #111013; a área rolável é recuada em #0d0b0f.
private final class PanelBackground: NSView {
    var surface = panelColor(0x111013)

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        surface.setFill()
        dirtyRect.fill()
    }
}

private final class Hairline: NSView {
    override func draw(_ dirtyRect: NSRect) {
        panelHairline.setFill()
        dirtyRect.fill()
    }
}

private final class AccountList: NSStackView {
    override var isFlipped: Bool { true }
}

/// Linha de conta: separador de hairline no pé (inset 16pt), nunca após a
/// última — hierarquia por espaçamento, não por cartões.
private final class AccountRow: NSStackView {
    var showsSeparator = true

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard showsSeparator else { return }
        panelHairline.setFill()
        // A linha não é flipped: y=0 é o pé visual da row. Inset simétrico.
        NSRect(x: rowHorizontalInset, y: 0,
               width: bounds.width - rowHorizontalInset * 2, height: 1).fill()
    }
}

/// Medidor DESENHADO (56×4, raio 2): trilho branco a 8%, preenchimento na cor
/// do estado com mínimo de 2pt quando há uso — sem glifo ▮ fazendo as vezes.
private final class GaugeView: NSView {
    var ratio: Double = 0
    var ink: NSColor = panelTextFaint

    override var intrinsicContentSize: NSSize { NSSize(width: 56, height: 4) }

    override func draw(_ dirtyRect: NSRect) {
        panelHairline.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2).fill()
        let clamped = min(1, max(0, ratio))
        guard clamped > 0 else { return }
        let width = max(2, bounds.width * clamped)
        ink.setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: width, height: bounds.height),
                     xRadius: 2, yRadius: 2).fill()
    }
}

/// Preenchimento real do botão do painel (nil quando transparente) — o gate de
/// contraste mede a tinta contra o próprio fundo, não contra o painel.
func panelButtonFill(_ button: NSButton) -> NSColor? {
    (button as? PanelButton)?.restingFill
}

/// Botão desenhado à mão: fill, borda e título vão pro draw() com a paleta
/// fixa; o NSButtonTextField que o AppKit injeta fica escondido e o
/// attributedTitle carrega a tinta REAL (é ela que o gate de contraste lê).
private final class PanelButton: NSButton {
    enum Style { case primary, secondary, ghost }

    private let style: Style
    private let buttonTitle: String
    private var hovering = false

    /// Fill em repouso — o que o contraste mede. Só a CTA primária tem fill.
    var restingFill: NSColor? {
        style == .primary ? panelColor(0xFAF7F9) : nil
    }

    private var ink: NSColor {
        switch style {
        case .primary: return panelColor(0x080709)
        case .secondary: return panelText
        case .ghost: return hovering ? panelTextDim : panelTextFaint
        }
    }

    init(title: String, style: Style, target: AnyObject?, action: Selector?) {
        self.style = style
        self.buttonTitle = title
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        isBordered = false
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: style == .ghost ? 11 : 12, weight: .medium),
            .foregroundColor: ink,
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        for field in subviews.compactMap({ $0 as? NSTextField }) { field.isHidden = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        let path = NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8)
        switch style {
        case .primary:
            panelColor(0xFAF7F9, hovering ? 0.85 : 1).setFill()
            path.fill()
        case .secondary:
            if hovering { NSColor.white.withAlphaComponent(0.04).setFill(); path.fill() }
            panelHairlineStrong.withAlphaComponent(hovering ? 0.24 : 0.16).setStroke()
            path.lineWidth = 1
            path.stroke()
        case .ghost:
            break
        }
        let text = NSAttributedString(string: buttonTitle, attributes: [
            .font: NSFont.systemFont(ofSize: style == .ghost ? 11 : 12, weight: .medium),
            .foregroundColor: ink,
        ])
        let size = text.size()
        text.draw(at: NSPoint(x: (bounds.width - size.width) / 2,
                              y: (bounds.height - size.height) / 2))
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds,
                                       options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
}

/// Lista vertical rolável de TODAS as contas. Só a lista rola; header e
/// footer (atualizar, abrir Nexus, login, sair) ficam fixos e visíveis.
final class QuotaPanelController: NSViewController {
    let surfaceColor = panelColor(0x111013)
    let listSurfaceColor = panelColor(0x0D0B0F)

    private let titleLabel = NSTextField(labelWithString: "Nexus Redline")
    private let summaryLabel = NSTextField(labelWithString: "")
    private let recommendationLabel = NSTextField(labelWithString: "")
    let scrollView = NSScrollView()
    private let accounts = AccountList()
    private let headerHairline = Hairline()
    private let footerHairline = Hairline()
    private let refreshButton: NSButton
    private let openButton: NSButton
    private let loginButton: NSButton
    private let quitButton: NSButton
    private var renderedSnapshot: RedlineSnapshotFile?
    private var hasRendered = false
    private var updateCountdowns: [() -> Void] = []

    init(target: AppDelegate) {
        refreshButton = PanelButton(title: "Atualizar agora", style: .primary,
                                    target: target, action: #selector(AppDelegate.requestRefresh))
        openButton = PanelButton(title: "Abrir no Nexus", style: .secondary,
                                 target: target, action: #selector(AppDelegate.openNexusApp))
        loginButton = NSButton(checkboxWithTitle: "Iniciar com o macOS", target: target,
                               action: #selector(AppDelegate.toggleLaunchAtLogin))
        quitButton = PanelButton(title: "Sair", style: .ghost,
                                 target: NSApp, action: #selector(NSApplication.terminate(_:)))
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = PanelBackground(frame: NSRect(x: 0, y: 0, width: 400, height: 600))
        (view as? PanelBackground)?.surface = surfaceColor
        // Escuro sempre, independente do tema do macOS.
        view.appearance = NSAppearance(named: .darkAqua)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = panelText
        summaryLabel.font = .systemFont(ofSize: 11)
        recommendationLabel.font = .systemFont(ofSize: 11)
        recommendationLabel.lineBreakMode = .byTruncatingTail

        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.scrollerStyle = .legacy
        scrollView.drawsBackground = true
        scrollView.backgroundColor = listSurfaceColor
        scrollView.setAccessibilityLabel("Contas e cotas de todos os provedores")
        accounts.orientation = .vertical
        accounts.alignment = .leading
        accounts.spacing = 0
        accounts.detachesHiddenViews = true
        scrollView.documentView = accounts

        refreshButton.keyEquivalent = "r"
        openButton.keyEquivalent = "o"
        quitButton.keyEquivalent = "q"
        loginButton.attributedTitle = NSAttributedString(string: "Iniciar com o macOS", attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: panelTextDim,
        ])

        for child in [titleLabel, summaryLabel, recommendationLabel,
                      scrollView, headerHairline, footerHairline,
                      refreshButton, openButton, loginButton, quitButton] {
            view.addSubview(child)
        }
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        let width = view.bounds.width
        let height = view.bounds.height
        titleLabel.frame = NSRect(x: 16, y: height - 34, width: width - 32, height: 20)
        summaryLabel.frame = NSRect(x: 16, y: height - 54, width: width - 32, height: 14)
        recommendationLabel.frame = NSRect(x: 16, y: height - 74, width: width - 32, height: 14)
        headerHairline.frame = NSRect(x: 0, y: height - 88, width: width, height: 1)
        footerHairline.frame = NSRect(x: 0, y: 96, width: width, height: 1)
        scrollView.frame = NSRect(x: 0, y: 97, width: width, height: max(24, height - 185))
        refreshButton.frame = NSRect(x: 16, y: 50, width: 172, height: 30)
        openButton.frame = NSRect(x: width - 188, y: 50, width: 172, height: 30)
        loginButton.frame = NSRect(x: 16, y: 18, width: 260, height: 20)
        quitButton.frame = NSRect(x: width - 80, y: 18, width: 64, height: 20)
        layoutAccounts()
    }

    private func layoutAccounts() {
        applyWrapWidths()
        let width = scrollView.contentSize.width
        accounts.setFrameSize(NSSize(width: width, height: accounts.fittingSize.height))
        accounts.layoutSubtreeIfNeeded()
    }

    func update(snapshot: RedlineSnapshotFile?, launchAtLogin: Bool) {
        loadViewIfNeeded()
        loginButton.state = launchAtLogin ? .on : .off
        let entries = snapshot?.entries ?? []
        let providers = Set(entries.map(\.adapterId)).count
        let summary = NSMutableAttributedString(
            string: "\(providers) \(providers == 1 ? "provedor" : "provedores") · \(entries.count) \(entries.count == 1 ? "conta" : "contas")",
            attributes: [.foregroundColor: panelTextDim])
        if let snapshot {
            let stale = Date.now.timeIntervalSince1970 - snapshot.updatedAt / 1000 > staleThreshold
            summary.append(NSAttributedString(
                string: " · atualizado \(ageLabel(snapshot.updatedAt))",
                attributes: [.foregroundColor: panelTextDim]))
            if stale {
                summary.append(NSAttributedString(
                    string: " · Nexus offline", attributes: [.foregroundColor: panelWarn]))
            }
        } else {
            summary.append(NSAttributedString(
                string: " · abra o Nexus para carregar", attributes: [.foregroundColor: panelTextDim]))
        }
        summaryLabel.attributedStringValue = summary

        let best = snapshot?.ranking.values.flatMap { $0 }.max { $0.headroom < $1.headroom }
        if let best {
            let text = NSMutableAttributedString(
                string: "Mais folga: \(providerName(best.adapterId)) · \(best.label) · ",
                attributes: [.foregroundColor: panelTextDim])
            text.append(NSAttributedString(
                string: "\(Int((best.headroom * 100).rounded()))%",
                attributes: [.foregroundColor: panelOk]))
            recommendationLabel.attributedStringValue = text
        } else {
            recommendationLabel.attributedStringValue = NSAttributedString(
                string: "Uso por conta · role para ver todas",
                attributes: [.foregroundColor: panelTextDim])
        }
        recommendationLabel.toolTip = recommendationLabel.stringValue

        // O arquivo é relido a cada 2s. Snapshot igual não reconstrói a lista
        // nem puxa quem está lendo uma conta mais abaixo — mas os cronômetros
        // continuam andando pelas closures registradas na montagem.
        for tick in updateCountdowns { tick() }
        guard !hasRendered || renderedSnapshot != snapshot else { return }
        let offset = scrollView.contentView.bounds.origin
        hasRendered = true
        renderedSnapshot = snapshot
        updateCountdowns.removeAll()
        wrapRoles.removeAll()
        for row in accounts.arrangedSubviews { accounts.removeArrangedSubview(row); row.removeFromSuperview() }
        if entries.isEmpty {
            let empty = AccountRow()
            empty.showsSeparator = false
            empty.edgeInsets = NSEdgeInsets(
                top: 12, left: rowHorizontalInset, bottom: 12, right: rowHorizontalInset)
            for child in [
                label("Sem dados ainda.", color: panelTextDim),
                label("Abra o Nexus e atualize as cotas para ver o painel.",
                      color: panelTextFaint, size: 11),
            ] {
                empty.addArrangedSubview(child)
                child.translatesAutoresizingMaskIntoConstraints = false
                child.widthAnchor.constraint(
                    equalTo: empty.widthAnchor, constant: -rowHorizontalInset * 2
                ).isActive = true
            }
            addRow(empty)
        } else {
            for (index, entry) in entries.enumerated() {
                let row = accountRow(entry)
                row.showsSeparator = index < entries.count - 1
                addRow(row)
            }
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

    /// Papel da linha dentro da row: quanto da coluna de conteúdo já está
    /// ocupado à esquerda do label (logo+chip, medidor+gap). O wrap real é
    /// aplicado no layout, quando contentSize.width é conhecido — um valor
    /// fixo grande demais subestima a altura e clipa texto na vertical.
    private enum WrapRole: CGFloat {
        case full = 0
        case head = 88  // logo 16 + gap 8 + chip "Ativa" ~64
        case quota = 66 // medidor 56 + gap 10
    }

    private var wrapRoles: [ObjectIdentifier: WrapRole] = [:]

    private func label(_ text: String, color: NSColor = panelText, size: CGFloat = 12,
                       weight: NSFont.Weight = .regular,
                       role: WrapRole = .full) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        wrapRoles[ObjectIdentifier(field)] = role
        field.maximumNumberOfLines = 0
        field.setContentCompressionResistancePriority(.required, for: .vertical)
        return field
    }

    private func applyWrapWidths() {
        let column = scrollView.contentSize.width - rowHorizontalInset * 2
        func walk(_ view: NSView) {
            if let field = view as? NSTextField,
               let role = wrapRoles[ObjectIdentifier(field)] {
                field.preferredMaxLayoutWidth = max(24, column - role.rawValue)
            }
            for child in view.subviews { walk(child) }
        }
        for row in accounts.arrangedSubviews { walk(row) }
    }

    private func accountRow(_ entry: RedlineEntry) -> AccountRow {
        let row = AccountRow()
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 4
        row.edgeInsets = NSEdgeInsets(
            top: 12, left: rowHorizontalInset, bottom: 12, right: rowHorizontalInset)

        // Linha 1: logo oficial + nome. O logo carrega o provider — o prefixo
        // "Provider · " era redundante, a não ser que o nome SEJA o provider.
        // Linha 1 alinhada no TOPO: com título quebrado em várias linhas, o
        // logo centrado no bloco flutuava no meio — ele pertence à primeira
        // linha (desce ~1pt para sentar na cap height).
        let head = NSStackView()
        head.orientation = .horizontal
        head.alignment = .top
        head.spacing = 8
        if let logo = RedlineAssets.logoView(for: entry.adapterId, tint: panelText) {
            let holder = NSView()
            holder.addSubview(logo)
            logo.frame = NSRect(x: 0, y: 0, width: 16, height: 16)
            holder.translatesAutoresizingMaskIntoConstraints = false
            holder.widthAnchor.constraint(equalToConstant: 16).isActive = true
            holder.heightAnchor.constraint(equalToConstant: 17).isActive = true
            head.addArrangedSubview(holder)
        }
        let provider = providerName(entry.adapterId)
        let title = entry.label.caseInsensitiveCompare(provider) == .orderedSame
            ? provider : entry.label
        // O título divide a linha com o logo (16+8) e o chip "Ativa".
        head.addArrangedSubview(label(title, color: panelText, weight: .semibold, role: .head))
        if entry.active {
            let dot = NSView()
            dot.wantsLayer = true
            dot.layer?.backgroundColor = panelAccent.cgColor
            dot.layer?.cornerRadius = 3
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
            dot.heightAnchor.constraint(equalToConstant: 6).isActive = true
            let live = NSStackView()
            live.orientation = .horizontal
            live.alignment = .centerY
            live.spacing = 5
            live.addArrangedSubview(dot)
            live.addArrangedSubview(label("Ativa", color: panelAccent, size: 10))
            head.addArrangedSubview(live)
        }
        row.addArrangedSubview(head)

        if let email = entry.emailMasked, !email.isEmpty, !entry.label.contains(email) {
            row.addArrangedSubview(label(email, color: panelTextFaint, size: 11))
        }

        let state = accountState(entry)
        if !state.isEmpty {
            // O estado viaja em palavras, nunca só em cor.
            let statusLabel = label(state, color: panelWarn, size: 11)
            row.addArrangedSubview(statusLabel)
            if entry.onCooldown {
                updateCountdowns.append { statusLabel.stringValue = accountState(entry) }
            }
        }

        if entry.windows.isEmpty { row.addArrangedSubview(label("Sem leitura de cota", color: panelTextFaint, size: 11)) }
        for quota in entry.windows {
            guard let used = quota.usedRatio else {
                row.addArrangedSubview(label("\(quota.label) · Sem leitura", color: panelTextFaint, size: 11))
                continue
            }
            let gauge = GaugeView()
            gauge.ratio = used
            gauge.ink = quotaInk(for: used)
            gauge.translatesAutoresizingMaskIntoConstraints = false
            gauge.widthAnchor.constraint(equalToConstant: 56).isActive = true
            gauge.heightAnchor.constraint(equalToConstant: 4).isActive = true

            // O texto fica depois do medidor (56) + gap (10).
            let text = label("", size: 11, role: .quota)
            let render = {
                let line = NSMutableAttributedString(
                    string: "\(quota.label) · ",
                    attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: panelTextDim])
                line.append(NSAttributedString(string: pct(used), attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
                    .foregroundColor: quotaInk(for: used),
                ]))
                line.append(NSAttributedString(
                    string: " usado",
                    attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: panelTextDim]))
                if quota.resetsAt != nil {
                    line.append(NSAttributedString(
                        string: " · reseta em \(countdown(quota.resetsAt))",
                        attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: panelTextFaint]))
                }
                return line
            }
            text.attributedStringValue = render()

            let line = NSStackView()
            line.orientation = .horizontal
            line.alignment = .centerY
            line.spacing = 10
            line.addArrangedSubview(gauge)
            line.addArrangedSubview(text)
            row.addArrangedSubview(line)
            if quota.resetsAt != nil {
                updateCountdowns.append { text.attributedStringValue = render() }
            }
        }
        for child in row.arrangedSubviews {
            child.translatesAutoresizingMaskIntoConstraints = false
            // Pin à largura do CONTEÚDO — a row inteira sobrescreveria os
            // edgeInsets e o texto encostaria na borda do painel.
            child.widthAnchor.constraint(
                equalTo: row.widthAnchor,
                constant: -(row.edgeInsets.left + row.edgeInsets.right)
            ).isActive = true
        }
        return row
    }
}

private func accountState(_ entry: RedlineEntry) -> String {
    var states: [String] = []
    // "Ativa" mora no chip de acento da linha 1 — aqui só vivem os avisos,
    // em warn, nunca um estado saudável pintado de âmbar.
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
