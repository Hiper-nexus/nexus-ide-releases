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
private let rowHorizontalInset: CGFloat = 20

/// Compacto gráfico (460 × 720); o ampliado reparte as contas em colunas.
private let compactPanelWidth: CGFloat = 460
private let compactPanelMaxHeight: CGFloat = 720
private let expandedColumnWidth: CGFloat = 360
private let expandedMaxColumns = 4
/// Respiro que o popover precisa dos cantos da tela (era o `- 32` do togglePanel).
private let screenMargin: CGFloat = 32
private let panelHeaderHeight: CGFloat = 190
private let compactFooterHeight: CGFloat = 96
/// Ampliado: uma faixa só (botões + início automático + Sair), mais enxuta no print.
private let expandedFooterHeight: CGFloat = 57

private func quotaInk(for used: Double?) -> NSColor {
    guard let used else { return panelTextFaint }
    if used >= 0.8 { return panelDanger }
    if used >= 0.5 { return panelWarn }
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
        // `bounds`, não `dirtyRect`: numa captura (cacheDisplay) o dirtyRect vem
        // sem recorte e o fio pintaria o painel inteiro.
        panelHairline.setFill()
        bounds.fill()
    }
}

private final class AccountList: NSStackView {
    override var isFlipped: Bool { true }
}

/// Documento do modo ampliado: as colunas ficam lado a lado, posicionadas à
/// mão (frames), porque a altura de cada uma já foi MEDIDA para repartir as
/// contas. Flipped: a coluna mais curta encosta no topo, como a lista compacta.
private final class ColumnsDocument: NSView {
    override var isFlipped: Bool { true }
}

/// Fio vertical de 1pt entre colunas — mesma hierarquia por hairline das rows.
private final class VerticalHairline: NSView {
    override func draw(_ dirtyRect: NSRect) {
        panelHairline.setFill()
        bounds.fill()
    }
}

/// Superfície de conta com espaço para os medidores gráficos e a identidade.
private final class AccountRow: NSStackView {

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 4), xRadius: 12, yRadius: 12)
        panelColor(0x16151A).setFill()
        outline.fill()
        panelHairline.setStroke()
        outline.lineWidth = 1
        outline.stroke()
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
    private var buttonTitle: String
    private var hovering = false
    var isSelected = false { didSet { state = isSelected ? .on : .off; needsDisplay = true } }

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
        attributedTitle = titleText(title)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func titleText(_ text: String) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: style == .ghost ? 11 : 12, weight: .medium),
            .foregroundColor: ink,
        ])
    }

    /// Troca o rótulo (Ampliar ⇄ Reduzir) mantendo a tinta explícita que o
    /// gate de contraste lê no attributedTitle.
    func setLabel(_ text: String) {
        buttonTitle = text
        title = text
        attributedTitle = titleText(text)
        needsDisplay = true
    }

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
            if hovering || isSelected {
                NSColor.white.withAlphaComponent(isSelected ? 0.10 : 0.04).setFill()
                path.fill()
            }
            panelHairlineStrong.withAlphaComponent(hovering ? 0.24 : 0.16).setStroke()
            path.lineWidth = 1
            path.stroke()
        case .ghost:
            break
        }
        if window?.firstResponder === self {
            panelAccent.setStroke()
            let focus = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 6, yRadius: 6)
            focus.lineWidth = 2
            focus.stroke()
        }
        let text = titleText(buttonTitle)
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
    private let freshnessLabel = NSTextField(labelWithString: "")
    private let recommendationLabel = NSTextField(labelWithString: "")
    private let recommendationValue = NSTextField(labelWithString: "")
    private let recommendationCaption = NSTextField(labelWithString: "Mais folga agora")
    private let fleetStrip = QuotaFleetStrip()
    private let allFilter = PanelButton(title: "Todas", style: .secondary, target: nil, action: nil)
    private let measuredFilter = PanelButton(title: "Com leitura", style: .secondary, target: nil, action: nil)
    private let attentionFilter = PanelButton(title: "Resolver", style: .secondary, target: nil, action: nil)
    private enum AccountFilter { case all, measured, attention }
    private var accountFilter = AccountFilter.all
    let scrollView = NSScrollView()
    private let accounts = AccountList()
    private let headerHairline = Hairline()
    private let footerHairline = Hairline()
    private let refreshButton: NSButton
    private let openButton: NSButton
    private let loginButton: NSButton
    private let quitButton: NSButton
    private let expandButton = PanelButton(title: "Ampliar", style: .secondary,
                                            target: nil, action: nil)
    private var renderedSnapshot: RedlineSnapshotFile?
    /// Último snapshot recebido (renderizado ou não): trocar de modo reconstrói
    /// a lista com ele, sem esperar o próximo ciclo de 2s do poll.
    private var latestSnapshot: RedlineSnapshotFile?
    private var hasRendered = false
    private var updateCountdowns: [() -> Void] = []
    /// Linhas atualmente na tela (compacto: na pilha; ampliado: nas colunas).
    private var currentRows: [AccountRow] = []

    /// Modo ampliado: todas as contas em colunas, sem rolagem quando cabem.
    private(set) var isExpanded = false
    /// visibleFrame da tela do status item. O AppDelegate atualiza antes de abrir;
    /// o padrão é um notebook comum.
    var availableScreenSize = NSSize(width: 1440, height: 900)
    /// Avisa o dono do popover (tamanho e comportamento dependem do modo).
    var onPreferredSizeChange: (() -> Void)?
    private var announcedSize: NSSize?

    private struct ExpandedLayout {
        let columns: Int
        let contentWidth: CGFloat
        let listHeight: CGFloat
        /// Nem com o máximo de colunas cabe: cai para a rolagem vertical.
        let scrolls: Bool
    }
    private var expandedLayout: ExpandedLayout?
    var expandedColumnCount: Int { expandedLayout?.columns ?? 0 }

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
        // O alvo é o próprio controlador: só existe depois do super.init.
        expandButton.target = self
        expandButton.action = #selector(toggleExpanded)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = PanelBackground(frame: NSRect(x: 0, y: 0, width: compactPanelWidth, height: compactPanelMaxHeight))
        (view as? PanelBackground)?.surface = surfaceColor
        // Escuro sempre, independente do tema do macOS.
        view.appearance = NSAppearance(named: .darkAqua)

        titleLabel.font = .systemFont(ofSize: 22, weight: .semibold)
        titleLabel.textColor = panelText
        summaryLabel.font = .systemFont(ofSize: 11)
        summaryLabel.lineBreakMode = .byTruncatingTail
        freshnessLabel.font = .systemFont(ofSize: 11)
        freshnessLabel.textColor = panelTextFaint
        recommendationLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        recommendationLabel.lineBreakMode = .byTruncatingTail
        recommendationCaption.font = .systemFont(ofSize: 10, weight: .medium)
        recommendationCaption.textColor = panelTextDim
        recommendationValue.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        recommendationValue.textColor = panelOk
        recommendationValue.alignment = .right
        for (button, action) in [(allFilter, #selector(showAllAccounts)),
                                 (measuredFilter, #selector(showMeasuredAccounts)),
                                 (attentionFilter, #selector(showAttentionAccounts))] {
            button.target = self
            button.action = action
        }

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
        expandButton.keyEquivalent = "e"
        syncExpandButton()
        loginButton.attributedTitle = NSAttributedString(string: "Iniciar com o macOS", attributes: [
            .font: NSFont.systemFont(ofSize: 11), .foregroundColor: panelTextDim,
        ])

        for child in [titleLabel, summaryLabel, freshnessLabel, recommendationLabel,
                      recommendationValue, recommendationCaption, fleetStrip, allFilter, measuredFilter, attentionFilter,
                      scrollView, headerHairline, footerHairline, expandButton,
                      refreshButton, openButton, loginButton, quitButton] {
            view.addSubview(child)
        }
    }

    private var usesWideFooter: Bool { isExpanded && (expandedLayout?.columns ?? 0) > 1 }
    private var footerHeight: CGFloat { usesWideFooter ? expandedFooterHeight : compactFooterHeight }

    override func viewDidLayout() {
        super.viewDidLayout()
        let width = view.bounds.width
        let height = view.bounds.height
        // O botão de ampliar divide o topo com o título.
        let expandWidth: CGFloat = 76
        titleLabel.frame = NSRect(x: 20, y: height - 42, width: width - 40 - expandWidth - 8, height: 28)
        expandButton.frame = NSRect(x: width - 16 - expandWidth, y: height - 40, width: expandWidth, height: 28)
        summaryLabel.frame = NSRect(x: 20, y: height - 62, width: width - 40, height: 14)
        fleetStrip.frame = NSRect(x: 20, y: height - 81, width: width - 40, height: 7)
        freshnessLabel.frame = NSRect(x: 20, y: height - 101, width: width - 40, height: 14)
        recommendationCaption.frame = NSRect(x: 20, y: height - 122, width: width - 168, height: 12)
        recommendationLabel.frame = NSRect(x: 20, y: height - 142, width: width - 168, height: 18)
        recommendationValue.frame = NSRect(x: width - 140, y: height - 143, width: 120, height: 30)
        let filterWidth = (width - 48) / 3
        for (index, filter) in [allFilter, measuredFilter, attentionFilter].enumerated() {
            filter.frame = NSRect(x: 20 + CGFloat(index) * (filterWidth + 4), y: height - 180,
                                  width: filterWidth, height: 28)
        }
        headerHairline.frame = NSRect(x: 0, y: height - panelHeaderHeight, width: width, height: 1)
        footerHairline.frame = NSRect(x: 0, y: footerHeight, width: width, height: 1)
        scrollView.frame = NSRect(x: 0, y: footerHeight + 1, width: width,
                                  height: max(24, height - panelHeaderHeight - footerHeight - 1))
        if usesWideFooter {
            // Uma faixa só: ações à esquerda, início automático e Sair à direita.
            refreshButton.frame = NSRect(x: 16, y: 14, width: 172, height: 30)
            openButton.frame = NSRect(x: 196, y: 14, width: 172, height: 30)
            quitButton.frame = NSRect(x: width - 80, y: 19, width: 64, height: 20)
            loginButton.frame = NSRect(x: width - 80 - 12 - 190, y: 19, width: 190, height: 20)
        } else {
            let buttonWidth = (width - 44) / 2
            refreshButton.frame = NSRect(x: 16, y: 46, width: buttonWidth, height: 36)
            openButton.frame = NSRect(x: width - 16 - buttonWidth, y: 46, width: buttonWidth, height: 36)
            loginButton.frame = NSRect(x: 16, y: 18, width: 260, height: 20)
            quitButton.frame = NSRect(x: width - 80, y: 18, width: 64, height: 20)
        }
        layoutAccounts()
    }

    private func layoutAccounts() {
        applyWrapWidths()
        // Ampliado: o documento já nasceu com o tamanho exato das colunas.
        guard !isExpanded || expandedLayout == nil else { return }
        let width = scrollView.contentSize.width
        accounts.setFrameSize(NSSize(width: width, height: accounts.fittingSize.height))
        accounts.layoutSubtreeIfNeeded()
    }

    // MARK: Modo ampliado

    /// Tamanho que o popover deve ter agora. Compacto: o painel de sempre.
    /// Ampliado: largura das colunas (+ rolagem, se não couber) e altura da
    /// coluna mais alta — limitadas à tela do status item.
    func preferredContentSize() -> NSSize {
        let maxHeight = max(240, availableScreenSize.height - screenMargin)
        guard isExpanded, let layout = expandedLayout else {
            return NSSize(width: compactPanelWidth, height: min(compactPanelMaxHeight, maxHeight))
        }
        let scroller = layout.scrolls
            ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        let chrome = panelHeaderHeight + footerHeight + 1
        let height = layout.scrolls ? maxHeight : min(maxHeight, layout.listHeight + chrome)
        return NSSize(width: max(compactPanelWidth, layout.contentWidth + scroller), height: height)
    }

    @objc func toggleExpanded() {
        loadViewIfNeeded()
        isExpanded.toggle()
        syncExpandButton()
        // Troca de modo SEMPRE reconstrói: o snapshot igual não basta para pular.
        hasRendered = false
        apply(snapshot: latestSnapshot, launchAtLogin: loginButton.state == .on, announce: false)
        announcedSize = isExpanded ? preferredContentSize() : nil
        onPreferredSizeChange?()
    }

    /// Volta ao compacto sem avisar o popover: quem chama (abrir o painel) já
    /// define o tamanho logo em seguida.
    func resetToCompact() {
        guard isExpanded else { return }
        isExpanded = false
        expandedLayout = nil
        announcedSize = nil
        hasRendered = false
        if isViewLoaded { syncExpandButton() }
    }

    private func syncExpandButton() {
        expandButton.setLabel(isExpanded ? "Reduzir" : "Ampliar")
        expandButton.toolTip = isExpanded
            ? "Voltar ao painel compacto"
            : "Ampliar para ver todas as contas de uma vez, ótimo para print"
        expandButton.setAccessibilityLabel(isExpanded
            ? "Reduzir o painel de cotas"
            : "Ampliar o painel para ver todas as contas de uma vez")
    }

    func update(snapshot: RedlineSnapshotFile?, launchAtLogin: Bool) {
        apply(snapshot: snapshot, launchAtLogin: launchAtLogin, announce: true)
    }

    @objc private func showAllAccounts() { selectFilter(.all) }
    @objc private func showMeasuredAccounts() { selectFilter(.measured) }
    @objc private func showAttentionAccounts() { selectFilter(.attention) }

    private func selectFilter(_ filter: AccountFilter) {
        guard accountFilter != filter else { return }
        accountFilter = filter
        hasRendered = false
        scrollView.contentView.scroll(to: .zero)
        apply(snapshot: latestSnapshot, launchAtLogin: loginButton.state == .on, announce: true)
    }

    private func hasMeasurement(_ entry: RedlineEntry) -> Bool {
        entry.windows.contains { $0.usedRatio != nil && $0.estimated != true }
    }

    private func apply(snapshot: RedlineSnapshotFile?, launchAtLogin: Bool, announce: Bool) {
        loadViewIfNeeded()
        latestSnapshot = snapshot
        loginButton.state = launchAtLogin ? .on : .off
        let entries = snapshot?.entries ?? []
        let providers = Set(entries.map(\.adapterId)).count
        let measured = entries.filter(hasMeasurement).count
        let summary = NSAttributedString(
            string: "\(providers) \(providers == 1 ? "provedor" : "provedores") · \(entries.count) \(entries.count == 1 ? "conta" : "contas")",
            attributes: [.foregroundColor: panelTextDim])
        let freshness = NSMutableAttributedString(string: "", attributes: [.foregroundColor: panelTextFaint])
        if let snapshot {
            let stale = Date.now.timeIntervalSince1970 - snapshot.updatedAt / 1000 > staleThreshold
            freshness.append(NSAttributedString(
                string: "\(measured) com leitura · \(entries.count - measured) sem dados · \(ageLabel(snapshot.updatedAt))",
                attributes: [.foregroundColor: panelTextFaint]))
            if stale {
                freshness.append(NSAttributedString(
                    string: " · Nexus offline", attributes: [.foregroundColor: panelWarn]))
            }
        } else {
            freshness.append(NSAttributedString(
                string: "Abra o Nexus para carregar as cotas", attributes: [.foregroundColor: panelTextDim]))
        }
        summaryLabel.attributedStringValue = summary
        freshnessLabel.attributedStringValue = freshness
        fleetStrip.inks = entries.map { entry in
            quotaInk(for: entry.windows.filter { $0.estimated != true }.compactMap(\.usedRatio).max())
        }
        fleetStrip.setAccessibilityElement(true)
        fleetStrip.setAccessibilityLabel("\(measured) contas com leitura; \(entries.count - measured) sem dados. Uma faixa por conta.")
        allFilter.setLabel("Todas  \(entries.count)")
        measuredFilter.setLabel("Com leitura  \(measured)")
        attentionFilter.setLabel("Resolver  \(entries.count - measured)")
        allFilter.isSelected = accountFilter == .all
        measuredFilter.isSelected = accountFilter == .measured
        attentionFilter.isSelected = accountFilter == .attention

        // The ranking includes prospective reset credit; this graphic describes
        // quota available now, using only measured consumption of eligible rows.
        let best = entries.filter(\.eligible).compactMap { entry -> (entry: RedlineEntry, headroom: Double)? in
            guard let used = entry.windows.filter({ $0.estimated != true }).compactMap(\.usedRatio).max() else { return nil }
            return (entry, max(0, 1 - used))
        }.max { $0.headroom < $1.headroom }
        if let best {
            let text = NSAttributedString(string: best.entry.label, attributes: [.foregroundColor: panelText])
            recommendationLabel.attributedStringValue = text
            recommendationValue.stringValue = "\(Int((best.headroom * 100).rounded()))% livre"
            recommendationValue.setAccessibilityLabel("\(recommendationValue.stringValue) de folga")
            recommendationCaption.stringValue = "Mais folga agora"
        } else {
            recommendationLabel.attributedStringValue = NSAttributedString(
                string: "Cotas por conta",
                attributes: [.foregroundColor: panelTextDim])
            recommendationValue.stringValue = "—"
            recommendationCaption.stringValue = "Aguardando leitura"
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
        currentRows = []
        let shown = entries.filter { entry in
            switch accountFilter {
            case .all: return true
            case .measured: return hasMeasurement(entry)
            case .attention: return !hasMeasurement(entry)
            }
        }
        if shown.isEmpty {
            expandedLayout = nil
            showEmptyRow()
        } else if isExpanded {
            showExpandedColumns(shown)
        } else {
            expandedLayout = nil
            showCompactRows(shown)
        }
        view.needsLayout = true
        view.layoutSubtreeIfNeeded()
        let documentHeight = scrollView.documentView?.frame.height ?? 0
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: min(offset.y, max(0, documentHeight - scrollView.contentSize.height))))
        scrollView.reflectScrolledClipView(scrollView.contentView)
        if announce && isExpanded { announceSizeIfChanged() }
    }

    /// A lista pode mudar de altura com um snapshot novo (conta que entra, texto
    /// que quebra): o popover ampliado precisa acompanhar.
    private func announceSizeIfChanged() {
        let size = preferredContentSize()
        guard size != announcedSize else { return }
        announcedSize = size
        onPreferredSizeChange?()
    }

    private func showEmptyRow() {
        scrollView.documentView = accounts
        scrollView.hasVerticalScroller = true
        let empty = AccountRow()
        empty.orientation = .vertical
        empty.alignment = .leading
        empty.spacing = 8
        empty.edgeInsets = NSEdgeInsets(
            top: 16, left: rowHorizontalInset, bottom: 16, right: rowHorizontalInset)
        let isFiltered = !(latestSnapshot?.entries.isEmpty ?? true)
        for child in [
            label(isFiltered ? "Nenhuma conta neste filtro." : "Sem dados ainda.", color: panelTextDim),
            label(isFiltered ? "Escolha Todas para ver suas conexões." : "Abra o Nexus e atualize as cotas para ver o painel.",
                  color: panelTextFaint, size: 11),
        ] {
            empty.addArrangedSubview(child)
            child.translatesAutoresizingMaskIntoConstraints = false
            child.widthAnchor.constraint(
                equalTo: empty.widthAnchor, constant: -rowHorizontalInset * 2
            ).isActive = true
        }
        currentRows = [empty]
        addRow(empty, to: accounts)
    }

    private func showCompactRows(_ entries: [RedlineEntry]) {
        scrollView.documentView = accounts
        scrollView.hasVerticalScroller = true
        for entry in entries {
            let row = accountRow(entry)
            currentRows.append(row)
            addRow(row, to: accounts)
        }
    }

    /// Ampliado: as MESMAS linhas do compacto (accountRow não muda), repartidas
    /// em colunas de largura fixa. A altura de cada linha é medida numa pilha
    /// de prova na largura da coluna, e só então o plano decide quantas colunas
    /// e onde cortar — assim o que aparece no print é o que foi medido.
    private func showExpandedColumns(_ entries: [RedlineEntry]) {
        let rows = entries.map { accountRow($0) }
        let probe = AccountList()
        probe.orientation = .vertical
        probe.alignment = .leading
        probe.spacing = 0
        probe.frame = NSRect(x: 0, y: 0, width: expandedColumnWidth, height: 10)
        for row in rows { addRow(row, to: probe) }
        applyWrapWidths(to: rows, rowWidth: expandedColumnWidth)
        probe.setFrameSize(NSSize(width: expandedColumnWidth, height: probe.fittingSize.height))
        probe.layoutSubtreeIfNeeded()
        let heights = rows.map { $0.frame.height }

        let maxHeight = max(240, availableScreenSize.height - screenMargin)
        let perColumn = expandedColumnWidth + 1
        let maxColumns = max(1, min(expandedMaxColumns,
                                    Int((availableScreenSize.width - screenMargin + 1) / perColumn)))
        let plannedFooter = maxColumns > 1 && entries.count > 1 ? expandedFooterHeight : compactFooterHeight
        let availableList = maxHeight - (panelHeaderHeight + plannedFooter + 1)
        let plan = planColumns(heights: heights, availableHeight: availableList,
                               minColumns: min(2, maxColumns), maxColumns: maxColumns)

        for row in rows { probe.removeArrangedSubview(row); row.removeFromSuperview() }
        let document = ColumnsDocument()
        var x: CGFloat = 0
        for (index, range) in plan.ranges.enumerated() {
            let column = AccountList()
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 0
            for rowIndex in range {
                addRow(rows[rowIndex], to: column)
            }
            let height = heights[range].reduce(0, +)
            column.frame = NSRect(x: x, y: 0, width: expandedColumnWidth, height: height)
            column.layoutSubtreeIfNeeded()
            document.addSubview(column)
            x += expandedColumnWidth
            if index < plan.ranges.count - 1 {
                document.addSubview(VerticalHairline(frame: NSRect(x: x, y: 0, width: 1, height: plan.tallest)))
                x += 1
            }
        }
        document.frame = NSRect(x: 0, y: 0, width: x, height: plan.tallest)
        currentRows = rows
        let scrolls = !plan.fits(in: availableList)
        expandedLayout = ExpandedLayout(columns: plan.columnCount, contentWidth: x,
                                        listHeight: plan.tallest, scrolls: scrolls)
        scrollView.hasVerticalScroller = scrolls
        scrollView.documentView = document
    }

    private func addRow(_ row: NSView, to stack: NSStackView) {
        stack.addArrangedSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }

    /// Papel da linha dentro da row: quanto da coluna de conteúdo já está
    /// ocupado à esquerda do label (logo+chip, medidor+gap). O wrap real é
    /// aplicado no layout, quando contentSize.width é conhecido — um valor
    /// fixo grande demais subestima a altura e clipa texto na vertical.
    private enum WrapRole: CGFloat {
        case full = 0
        case head = 100 // logo 24 + gap 8 + chip Ativa
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
        // Ampliado: a coluna tem largura fixa, independente do popover.
        let width = expandedLayout != nil ? expandedColumnWidth : scrollView.contentSize.width
        applyWrapWidths(to: currentRows, rowWidth: width)
    }

    private func applyWrapWidths(to rows: [AccountRow], rowWidth: CGFloat) {
        let column = rowWidth - rowHorizontalInset * 2
        func walk(_ view: NSView) {
            if let field = view as? NSTextField,
               let role = wrapRoles[ObjectIdentifier(field)] {
                field.preferredMaxLayoutWidth = max(24, column - role.rawValue)
            }
            for child in view.subviews { walk(child) }
        }
        for row in rows { walk(row) }
    }

    private func accountRow(_ entry: RedlineEntry) -> AccountRow {
        let row = AccountRow()
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(
            top: 16, left: rowHorizontalInset, bottom: 16, right: rowHorizontalInset)

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
            logo.frame = NSRect(x: 0, y: 0, width: 24, height: 24)
            holder.translatesAutoresizingMaskIntoConstraints = false
            holder.widthAnchor.constraint(equalToConstant: 24).isActive = true
            holder.heightAnchor.constraint(equalToConstant: 24).isActive = true
            head.addArrangedSubview(holder)
        }
        let provider = providerName(entry.adapterId)
        let title = entry.label.caseInsensitiveCompare(provider) == .orderedSame
            ? provider : entry.label
        // O título divide a linha com o logo (16+8) e o chip "Ativa".
        head.addArrangedSubview(label(title, color: panelText, size: 13, weight: .semibold, role: .head))
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
        if !state.isEmpty && entry.windows.contains(where: { $0.usedRatio != nil }) {
            // O estado viaja em palavras, nunca só em cor.
            let statusLabel = label(state, color: panelWarn, size: 11)
            row.addArrangedSubview(statusLabel)
            if entry.onCooldown {
                updateCountdowns.append { statusLabel.stringValue = accountState(entry) }
            }
        }

        addQuotaWindows(entry, to: row)
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

    private func addQuotaWindows(_ entry: RedlineEntry, to row: AccountRow) {
        let known = entry.windows.filter { $0.usedRatio != nil }
        guard !known.isEmpty else {
            row.addArrangedSubview(missingQuota(entry))
            return
        }
        for start in stride(from: 0, to: known.count, by: 2) {
            let pair = NSStackView()
            pair.orientation = .horizontal
            pair.distribution = .fillEqually
            pair.alignment = .centerY
            pair.spacing = 16
            for quota in known[start..<min(start + 2, known.count)] {
                pair.addArrangedSubview(quotaMetric(quota))
            }
            row.addArrangedSubview(pair)
        }
        if !hasMeasurement(entry) && !accountState(entry).isEmpty {
            let actions = NSStackView(views: [connectionButton(entry)])
            actions.orientation = .horizontal
            row.addArrangedSubview(actions)
        }
        let missing = entry.windows.filter { $0.usedRatio == nil }
        if !missing.isEmpty {
            row.toolTip = missing.map(\.label).joined(separator: ", ") + " · não informada pelo provedor"
        }
    }

    private func quotaMetric(_ quota: RedlineWindow) -> NSStackView {
        let metric = NSStackView()
        metric.orientation = .vertical
        metric.alignment = .leading
        metric.spacing = 4
        let heading = NSStackView()
        heading.orientation = .horizontal
        heading.distribution = .fill
        heading.alignment = .firstBaseline
        heading.spacing = 8
        let caption = NSTextField(wrappingLabelWithString: quota.label)
        caption.font = .systemFont(ofSize: 11, weight: .medium)
        caption.textColor = panelTextDim
        caption.preferredMaxLayoutWidth = 90
        caption.maximumNumberOfLines = 3
        caption.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let value = NSTextField(labelWithString: pct(quota.usedRatio))
        value.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        value.textColor = panelText
        value.setContentCompressionResistancePriority(.required, for: .horizontal)
        heading.addArrangedSubview(caption)
        heading.addArrangedSubview(value)
        let gauge = QuotaMeterView(quota: quota,
                                  ink: quota.estimated == true ? panelTextDim : quotaInk(for: quota.usedRatio),
                                  track: panelHairlineStrong)
        for child in [heading, gauge] {
            metric.addArrangedSubview(child)
            child.translatesAutoresizingMaskIntoConstraints = false
            child.widthAnchor.constraint(equalTo: metric.widthAnchor).isActive = true
        }
        metric.addArrangedSubview(quotaTiming(quota))
        return metric
    }

    private func quotaTiming(_ quota: RedlineWindow) -> NSStackView {
        let timing = NSStackView()
        timing.orientation = .horizontal
        timing.alignment = .centerY
        timing.spacing = 4
        if quota.estimated == true {
            timing.addArrangedSubview(label("Estimado", color: panelTextDim, size: 10))
        }
        guard quota.resetsAt != nil else { return timing }
        let reset = NSTextField(labelWithString: countdown(quota.resetsAt))
        reset.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        reset.textColor = panelTextFaint
        reset.setAccessibilityLabel("Renova em \(reset.stringValue)")
        if let image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Renova em") {
            let icon = NSImageView(image: image)
            icon.contentTintColor = panelTextFaint
            icon.widthAnchor.constraint(equalToConstant: 10).isActive = true
            icon.heightAnchor.constraint(equalToConstant: 10).isActive = true
            timing.addArrangedSubview(icon)
        }
        timing.addArrangedSubview(reset)
        updateCountdowns.append {
            reset.stringValue = countdown(quota.resetsAt)
            reset.setAccessibilityLabel("Renova em \(reset.stringValue)")
        }
        return timing
    }

    private func missingQuota(_ entry: RedlineEntry) -> NSStackView {
        let content = NSStackView()
        content.orientation = .horizontal
        content.alignment = .centerY
        content.spacing = 12
        if let image = NSImage(systemSymbolName: "antenna.radiowaves.left.and.right.slash", accessibilityDescription: "Sem leitura") {
            let icon = NSImageView(image: image)
            icon.contentTintColor = panelTextFaint
            icon.widthAnchor.constraint(equalToConstant: 28).isActive = true
            icon.heightAnchor.constraint(equalToConstant: 28).isActive = true
            content.addArrangedSubview(icon)
        }
        let detail = NSStackView()
        detail.orientation = .vertical
        detail.alignment = .leading
        detail.spacing = 4
        let state = accountState(entry)
        let status = label(state.isEmpty ? quotaReadMessage(entry) : state, color: panelTextDim, size: 11)
        detail.addArrangedSubview(status)
        if entry.onCooldown { updateCountdowns.append { status.stringValue = accountState(entry) } }
        detail.addArrangedSubview(connectionButton(entry))
        content.addArrangedSubview(detail)
        return content
    }

    private func connectionButton(_ entry: RedlineEntry) -> NSButton {
        let resolve = PanelButton(title: "Resolver no Nexus", style: .secondary,
                                  target: openButton.target as AnyObject?, action: openButton.action)
        resolve.setAccessibilityLabel("Resolver a conexão de \(entry.label) no Nexus")
        resolve.widthAnchor.constraint(equalToConstant: 132).isActive = true
        resolve.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return resolve
    }

}

private func quotaReadMessage(_ entry: RedlineEntry) -> String {
    switch entry.readHint {
    case "quota-key-required": return "Conectado · cota pendente"
    case "cli-missing": return "CLI não encontrada"
    case "unavailable": return "Cota indisponível"
    default: return "Sem leitura de cota"
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
