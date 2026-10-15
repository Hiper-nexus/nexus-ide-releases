// Native behavior tests (F-029), compiled with the production sources by main.test.ts.
//
// Fixture: 24 contas sintéticas em aparência clara. Os três defeitos do F-029
// são observáveis sem interação: a faixa da barra crescia por conta (medido:
// ~930pt com 6 contas, 148pt por conta), o detalhe vinha como item de menu
// desabilitado por janela, e o observador de effectiveAppearance não era
// retido — trocar de tema nunca repintava.

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.appearance = NSAppearance(named: .aqua)

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8)); exit(1) }
}

/// WCAG relative luminance, resolved in the drawing surface appearance.
func relativeLuminance(_ color: NSColor) -> Double {
    guard let srgb = color.usingColorSpace(.sRGB) else { return 0 }
    func channel(_ value: CGFloat) -> Double {
        let raw = Double(value)
        return raw <= 0.03928 ? raw / 12.92 : pow((raw + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(srgb.redComponent)
        + 0.7152 * channel(srgb.greenComponent)
        + 0.0722 * channel(srgb.blueComponent)
}

let now = Date.now.timeIntervalSince1970 * 1000
let fixtureEntries = (0..<24).map { index in
    RedlineEntry(
        id: "fixture-\(index)", adapterId: index % 2 == 0 ? "claude" : "codex",
        accountId: "account-\(index)", label: "Conta \(index + 1)", emailMasked: "te****@e**.com",
        active: index < 2, installed: true, onCooldown: false, cooldownUntil: nil,
        windows: [
            RedlineWindow(kind: "hours", label: "5 horas", usedRatio: 0.37, resetsAt: now + 3_600_000),
            // Contas fora da faixa (índice ≥ 6) têm a semana MAIS apertada: se a
            // barra varrer todas as contas em vez das que o quota-service
            // escolheu (statusBarEntryIds, teto de 6 — F-612), ela lê 99% e cai.
            RedlineWindow(kind: "weekly", label: "Semana", usedRatio: index < 6 ? 0.91 : 0.99,
                          resetsAt: now + 259_200_000),
        ], updatedAt: now, eligible: true, excludedReason: nil, headroom: 0.09, decisiveWindow: nil
    )
}

func snapshot(updatedAt: Double) -> RedlineSnapshotFile {
    RedlineSnapshotFile(
        formatVersion: 1, generatedBy: "nexus", updatedAt: updatedAt, worstUsedRatio: 0.91,
        entries: fixtureEntries, ranking: [:], statusBarEntryIds: fixtureEntries.prefix(6).map(\.id)
    )
}

let fixture = snapshot(updatedAt: now)
let testDelegate = AppDelegate()
testDelegate.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
testDelegate.snapshot = fixture
testDelegate.renderStatusItem()
guard let button = testDelegate.statusItem.button else {
    print("FAIL: status item has no button — is there a window server session?")
    exit(1)
}

// MARK: - A barra fica compacta e legível sem cor

let barTitle = button.attributedTitle
check(barTitle.length > 0, "the menu bar item must render something")
check(
    barTitle.size().width < 100,
    "24 accounts must not turn the menu bar item into a horizontal quota strip "
        + "(got \(String(format: "%.1f", barTitle.size().width))pt; the per-account strip measured ~930pt)"
)
check(
    !barTitle.string.contains("│"),
    "the menu bar item must not concatenate one segment per account (found the strip separator)"
)
// Redline existe para mostrar FOLGA no topo do Mac. Contagem de contas não
// responde "quanto me resta": a pior janela entre as contas que o
// quota-service escolheu responde, com número ao lado da barra.
check(
    barTitle.string.contains("91%"),
    "the bar must show the tightest quota among the bar accounts, not an account count "
        + "(expected 91%, got '\(barTitle.string)')"
)
check(
    !barTitle.string.contains("99%"),
    "the bar must read only the accounts the quota-service selected in statusBarEntryIds "
        + "(F-612), not every account in the snapshot"
)
check(
    barTitle.string.contains("▮"),
    "the 5-block gauge must stay next to the number (got '\(barTitle.string)')"
)
check(
    testDelegate.entriesForBar(fixture).count == 6,
    "the bar selection must honour statusBarEntryIds — the quota-service caps it at six "
        + "accounts (got \(testDelegate.entriesForBar(fixture).count))"
)

/// Evidência do "depois" da faixa, no mesmo fundo branco do "antes".
func captureTitle(_ name: String, _ text: NSAttributedString) {
    guard let directory = ProcessInfo.processInfo.environment["REDLINE_TEST_SCREENSHOTS"] else { return }
    let image = NSImage(size: NSSize(width: max(120, text.size().width + 24), height: 36))
    image.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: image.size).fill()
    text.draw(at: NSPoint(x: 12, y: 10))
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try! bitmap.representation(using: .png, properties: [:])!
        .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
}
captureTitle("after-status-light", barTitle)

// Snapshot velho acrescenta o marcador ◌: o teto de largura vale com ele também.
testDelegate.snapshot = snapshot(updatedAt: now - 7_200_000)
testDelegate.renderStatusItem()
check(
    button.attributedTitle.size().width < 100,
    "the stale marker must not push the menu bar item over budget "
        + "(got \(String(format: "%.1f", button.attributedTitle.size().width))pt)"
)
testDelegate.snapshot = fixture
testDelegate.renderStatusItem()

// MARK: - Uma lista vertical com rolagem alcança TODAS as contas

let panel = testDelegate.quotaPanel
panel.update(snapshot: fixture, launchAtLogin: false)
let testWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 720), styleMask: [.borderless], backing: .buffered, defer: false)
testWindow.contentView = panel.view
panel.view.layoutSubtreeIfNeeded()
let scroll = panel.scrollView
let document = scroll.documentView as! NSStackView
check(scroll.hasVerticalScroller && !scroll.hasHorizontalScroller, "accounts need vertical scrolling without horizontal overflow")
check(document.arrangedSubviews.count == 24, "the panel must include all accounts, not only the six bar entries")
check(document.frame.height > scroll.contentSize.height, "many accounts must extend below the bounded viewport")
check(scroll.verticalScroller?.isHidden == false && (scroll.verticalScroller?.knobProportion ?? 1) < 1,
      "a long account list must show a usable scrollbar")
check(document.frame.width <= scroll.contentSize.width, "account rows must fit the available width")
check(document.arrangedSubviews.last!.frame.maxY > document.arrangedSubviews.first!.frame.maxY, "accounts must stack downward")
check(scroll.frame.minY >= 84, "refresh and app controls must stay outside the scrollable area")

func fields(_ root: NSView) -> [NSTextField] {
    (root as? NSTextField).map { [$0] } ?? root.subviews.flatMap { fields($0) }
}
func descendants<T: NSView>(_ root: NSView, of type: T.Type) -> [T] {
    var found: [T] = []
    if let match = root as? T { found.append(match) }
    for child in root.subviews { found.append(contentsOf: descendants(child, of: type)) }
    return found
}
let renderedFields = fields(panel.view)
let readingFilter = descendants(panel.view, of: NSButton.self).first { $0.title.hasPrefix("Com leitura") }
check(readingFilter != nil, "the graphical overview must offer a working measured-quota filter")
check(renderedFields.contains { $0.stringValue.contains("Conta 24") }, "the last account must have a visible label")
check(renderedFields.contains { $0.stringValue == "37%" }, "usage must be readable without relying on color")
check(renderedFields.allSatisfy(\.isEnabled), "quota text must not be dimmed as disabled menu actions")
let panelButtons = descendants(panel.view, of: NSButton.self)
for title in ["Atualizar agora", "Abrir no Nexus", "Iniciar com o macOS", "Sair"] {
    check(panelButtons.contains { $0.title == title && $0.action != nil && $0.target != nil },
          "the panel must retain the working action: \(title)")
}

// O medidor é DESENHADO, não um glifo Unicode fazendo as vezes de ícone: no
// painel não pode sobrar bloco ▮ nem o ····· de "sem leitura" em texto.
for field in renderedFields {
    check(
        !field.stringValue.contains("▮") && !field.stringValue.contains("░")
            && !field.stringValue.contains("·····"),
        "the panel gauge must be drawn, not block glyphs (found '\(field.stringValue)')"
    )
}

// A marca de cada provedor é o logo oficial local, e as marcas monocromáticas
// precisam de tingimento de template — preto sobre near-black desaparece.
let logoViews = descendants(panel.view, of: NSImageView.self).filter { $0.image != nil }
check(
    logoViews.count >= 2,
    "each account row must carry its provider logo (got \(logoViews.count) images)"
)
check(
    logoViews.contains { $0.image?.isTemplate == true && $0.contentTintColor != nil },
    "monochrome provider marks must be template-tinted, or they vanish on the near-black surface"
)

func capture(_ name: String) {
    guard let directory = ProcessInfo.processInfo.environment["REDLINE_TEST_SCREENSHOTS"] else { return }
    panel.view.display()
    let bitmap = panel.view.bitmapImageRepForCachingDisplay(in: panel.view.bounds)!
    panel.view.cacheDisplay(in: panel.view.bounds, to: bitmap)
    try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent("after-" + name + ".png"))
}

/// Toda tinta REALMENTE desenhada: cor do atributo quando há string atribuída,
/// senão `textColor`. Deixar um label na `labelColor` do sistema é o bug —
/// no tema claro ela é quase preta e desaparece na superfície near-black.
func inks(_ field: NSTextField) -> [NSColor] {
    let attributed = field.attributedStringValue
    var colors: [NSColor] = []
    if attributed.length > 0 {
        attributed.enumerateAttribute(
            .foregroundColor, in: NSRange(location: 0, length: attributed.length)
        ) { value, _, _ in
            if let color = value as? NSColor { colors.append(color) }
        }
    }
    return colors.isEmpty ? [field.textColor ?? .labelColor] : colors
}

func contrastRatio(_ first: Double, _ second: Double) -> Double {
    (max(first, second) + 0.05) / (min(first, second) + 0.05)
}

func insideButton(_ view: NSView) -> Bool {
    var node: NSView? = view
    while let current = node {
        if current is NSButton { return true }
        node = current.superview
    }
    return false
}

// O painel é superfície Nexus ESCURA sempre. Seguir a aparência do sistema é
// exatamente o que o deixava branco e ilegível no tema claro do macOS, contra
// a identidade dark-first do DESIGN.md ("nunca SaaS de cards brancos").
// A aparência trocada aqui é a do APP (o sistema), não a do painel: o painel
// tem de recusá-la.
for appearance in [NSAppearance.Name.aqua, .darkAqua] {
    application.appearance = NSAppearance(named: appearance)
    panel.view.layoutSubtreeIfNeeded()
    check(
        panel.view.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua,
        "the panel must stay dark even with macOS in \(appearance.rawValue)"
    )
    panel.view.effectiveAppearance.performAsCurrentDrawingAppearance {
        let panelLuminance = relativeLuminance(panel.surfaceColor)
        let listLuminance = relativeLuminance(panel.listSurfaceColor)
        for (name, luminance) in [("painel", panelLuminance), ("lista", listLuminance)] {
            check(
                luminance < 0.02,
                "the \(name) surface must be near-black Nexus with macOS in \(appearance.rawValue), "
                    + "never the system window white (luminance \(luminance))"
            )
        }
        // Um label dentro de um botão é medido contra o PREENCHIMENTO do botão,
        // logo abaixo — não contra a superfície do painel. Sem essa exceção o
        // gate exigiria tinta clara na CTA branca, que é o oposto do certo.
        for field in fields(panel.view)
        where !field.stringValue.isEmpty && !field.isHidden && !insideButton(field) {
            for ink in inks(field) {
                let inkLuminance = relativeLuminance(ink)
                let worst = min(
                    contrastRatio(inkLuminance, panelLuminance),
                    contrastRatio(inkLuminance, listLuminance)
                )
                check(
                    worst >= 4.5,
                    "every label must clear AA on the dark surface with macOS in \(appearance.rawValue) — "
                        + "'\(field.stringValue.prefix(28))' paints \(String(format: "%.2f", worst)):1"
                )
            }
        }
    }
    capture(appearance == .aqua ? "panel-light" : "panel-dark")
}

// Cada botão carrega tinta explícita e é medido contra o PRÓPRIO fundo: a CTA
// primária é branca com tinta near-black (regra do DESIGN.md — a ação primária
// é a coisa mais clara da tela, o acento fica reservado a ESTADO).
for button in panelButtons {
    let explicit = button.attributedTitle.length > 0
        ? button.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        : nil
    guard let ink = explicit else {
        print("FAIL: the '\(button.title)' button must carry an explicit ink color")
        exit(1)
    }
    let backdrop = panelButtonFill(button) ?? panel.surfaceColor
    let ratio = contrastRatio(relativeLuminance(ink), relativeLuminance(backdrop))
    check(
        ratio >= 4.5,
        "the '\(button.title)' label must clear AA on its own fill (got \(String(format: "%.2f", ratio)):1)"
    )
}
check(
    panelButtons.contains { panelButtonFill($0)?.usingColorSpace(.sRGB)?.brightnessComponent ?? 0 > 0.9 },
    "the primary action must be the neutral white CTA, never the accent"
)

scroll.contentView.scroll(to: NSPoint(x: 0, y: document.frame.height - scroll.contentSize.height))
scroll.reflectScrolledClipView(scroll.contentView)
check(scroll.documentVisibleRect.intersects(document.arrangedSubviews.last!.frame), "scrolling to the bottom must reveal the last account")
let bottomOffset = scroll.contentView.bounds.origin.y
panel.update(snapshot: fixture, launchAtLogin: true)
check(abs(scroll.contentView.bounds.origin.y - bottomOffset) < 1, "polling must not jump back to the first account")
capture("panel-bottom")
panel.update(snapshot: snapshot(updatedAt: now + 1000), launchAtLogin: true)
check(abs(scroll.contentView.bounds.origin.y - bottomOffset) < 1, "a fresh quota snapshot must preserve the reading position")

let unknown = RedlineEntry(id: "unknown", adapterId: "kimi", accountId: nil,
    label: "Conta com nome muito longo para conferir a quebra de linha e manter a identificação completa dentro do painel",
    emailMasked: nil, active: false, installed: true, onCooldown: false, cooldownUntil: nil,
    windows: [RedlineWindow(kind: "monthly", label: "Mensal", usedRatio: nil, resetsAt: nil)],
    updatedAt: now, eligible: false, excludedReason: "unknown-usage", headroom: nil, decisiveWindow: nil)
panel.update(snapshot: RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now - 900_000,
    worstUsedRatio: nil, entries: [unknown], ranking: [:], statusBarEntryIds: []), launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue.contains("Sem leitura") }, "unknown quota must remain visible without inventing zero usage")
check(!fields(panel.view).contains { $0.stringValue.contains("0%") }, "unknown usage must not be presented as zero")
check(fields(panel.view).contains { $0.stringValue.contains("Nexus offline") }, "old snapshots must identify offline data")
check(scroll.contentView.bounds.origin.y == 0, "a shorter list must clamp its old scroll offset")
let longLabel = fields(document).first { $0.stringValue.contains("Conta com nome muito longo") }!
// NSTextField draws two points outside its Auto Layout alignment rect.
check(longLabel.frame.height > 20 && longLabel.alignmentRect(forFrame: longLabel.frame).width <= scroll.contentSize.width,
      "long account labels must wrap within the viewport")
application.appearance = NSAppearance(named: .aqua)
capture("panel-unknown")
let soon = Date.now.timeIntervalSince1970 * 1000 + 200
let timed = RedlineEntry(id: "timed", adapterId: "codex", accountId: nil, label: "Conta com reset",
    emailMasked: nil, active: true, installed: true, onCooldown: true, cooldownUntil: soon,
    windows: [RedlineWindow(kind: "hours", label: "5 horas", usedRatio: 0.37, resetsAt: soon)],
    updatedAt: now, eligible: false, excludedReason: "cooldown", headroom: nil, decisiveWindow: nil)
let timedSnapshot = RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.37, entries: [timed], ranking: [:], statusBarEntryIds: [])
panel.update(snapshot: timedSnapshot, launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue == "1m" }, "the reset should start in the future, beside the graphical gauge")
Thread.sleep(forTimeInterval: 0.25)
panel.update(snapshot: timedSnapshot, launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue == "agora" }, "reset countdown must advance even without new snapshot data")
check(fields(panel.view).contains { $0.stringValue.contains("Em espera · agora") }, "cooldown countdown must advance without rebuilding accounts")
panel.update(snapshot: nil, launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue.contains("Sem dados ainda") }, "missing snapshots must explain how to load data")
capture("panel-empty")
// MARK: - Ampliar: TODAS as contas numa vista só (print)
//
// O painel compacto tem rolagem interna, então um print nunca pega todas as
// contas. O modo ampliado reparte as contas em colunas de largura fixa, na
// ordem do snapshot, e só rola quando nem o máximo de colunas cabe na tela.

// Plano de colunas (puro, sem AppKit): partição contígua que minimiza a coluna mais alta.
check(balancedColumns(heights: [], columns: 3).ranges.isEmpty, "no rows means no columns")
check(
    balancedColumns(heights: [100, 100, 100, 100, 100, 100], columns: 3).ranges == [0..<2, 2..<4, 4..<6],
    "equal rows must split evenly across columns, in the original order"
)
let lopsided = balancedColumns(heights: [300, 50, 50, 50, 50], columns: 2)
check(lopsided.ranges == [0..<1, 1..<5] && lopsided.tallest == 300,
      "a tall row must get a column of its own instead of unbalancing the list (got \(lopsided.ranges))")
check(balancedColumns(heights: [10, 10], columns: 4).columnCount == 2,
      "never more columns than rows: an empty column is just a hole in the print")
let tenRows = [CGFloat](repeating: 100, count: 10)
check(planColumns(heights: tenRows, availableHeight: 500, minColumns: 2, maxColumns: 4).columnCount == 2,
      "the smallest column count that fits must win")
check(planColumns(heights: tenRows, availableHeight: 400, minColumns: 2, maxColumns: 4).columnCount == 3,
      "one more column when two do not fit")
let overflow = planColumns(heights: tenRows, availableHeight: 100, minColumns: 2, maxColumns: 4)
check(overflow.columnCount == 4 && !overflow.fits(in: 100),
      "when even the maximum does not fit the plan must report it, so the panel falls back to scrolling")

let bigScreen = NSSize(width: 1728, height: 1080)
let entries19 = Array(fixtureEntries.prefix(19))
let snapshot19 = RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.91, entries: entries19, ranking: [:], statusBarEntryIds: [])

let wide = QuotaPanelController(target: testDelegate)
wide.availableScreenSize = bigScreen
wide.update(snapshot: snapshot19, launchAtLogin: false)
check(!wide.isExpanded, "the panel must open compact")
check(wide.preferredContentSize() == NSSize(width: 460, height: 720), "the compact overview has room for the graphical meters")
check(descendants(wide.view, of: NSButton.self).contains { $0.title == "Ampliar" },
      "the header must offer Ampliar")

var announcements = 0
wide.onPreferredSizeChange = { announcements += 1 }
wide.toggleExpanded()
check(wide.isExpanded && announcements == 1, "toggling must flip the mode and tell the popover owner exactly once")
let expandedSize = wide.preferredContentSize()
check(expandedSize.width > 400, "the expanded panel must be wider than the compact one (got \(expandedSize.width))")
check(expandedSize.height <= bigScreen.height - 32, "the expanded panel must fit the screen with its margin")
check((2...4).contains(wide.expandedColumnCount), "expanded mode uses 2 to 4 columns (got \(wide.expandedColumnCount))")

let bigWindow = NSWindow(contentRect: NSRect(origin: .zero, size: expandedSize), styleMask: [.borderless], backing: .buffered, defer: false)
bigWindow.contentView = wide.view
wide.view.setFrameSize(expandedSize)
wide.view.layoutSubtreeIfNeeded()
let wideScroll = wide.scrollView
let columnsDocument = wideScroll.documentView!
check(!wideScroll.hasVerticalScroller, "when every account fits there must be no inner scrollbar to hide the rest")
check(columnsDocument.frame.height <= wideScroll.contentSize.height + 0.5,
      "all rows must be visible without scrolling at a 1080pt-tall screen")
check(columnsDocument.frame.width <= wideScroll.contentSize.width + 0.5, "the columns must fit the panel width")

let columnStacks = columnsDocument.subviews.compactMap { $0 as? NSStackView }
check(columnStacks.count == wide.expandedColumnCount, "one stack per planned column")
check(columnsDocument.subviews.count == columnStacks.count * 2 - 1, "a hairline between columns, none at the edges")
let allRows = columnStacks.flatMap { column in column.arrangedSubviews.map { (column: column, row: $0) } }
check(allRows.count == 19, "every account must be laid out (got \(allRows.count) of 19)")
let rowFrames = allRows.map { $0.column.convert($0.row.frame, to: columnsDocument) }
for frame in rowFrames {
    check(columnsDocument.bounds.insetBy(dx: -0.5, dy: -0.5).contains(frame),
          "a row must stay inside the document (row \(frame), document \(columnsDocument.bounds))")
}
for first in 0..<rowFrames.count {
    for second in (first + 1)..<rowFrames.count {
        check(!rowFrames[first].insetBy(dx: 0.5, dy: 0.5).intersects(rowFrames[second]),
              "rows must never overlap (\(rowFrames[first]) vs \(rowFrames[second]))")
    }
}
let expandedFields = fields(wide.view)
for number in 1...19 {
    check(expandedFields.contains { $0.stringValue == "Conta \(number)" }, "account \(number) must be readable in the expanded view")
}
for field in fields(columnsDocument) where !field.stringValue.isEmpty {
    check(field.frame.height + 1 >= field.intrinsicContentSize.height,
          "text must not be clipped vertically: '\(field.stringValue.prefix(24))'")
}
check(!descendants(wide.view, of: NSButton.self).contains { $0.title == "Ampliar" }
      && descendants(wide.view, of: NSButton.self).contains { $0.title == "Reduzir" },
      "the header button must flip to Reduzir")
let wideButtons = descendants(wide.view, of: NSButton.self)
for title in ["Atualizar agora", "Abrir no Nexus", "Iniciar com o macOS", "Sair"] {
    guard let control = wideButtons.first(where: { $0.title == title }) else {
        print("FAIL: the expanded panel must keep the action: \(title)"); exit(1)
    }
    check(control.action != nil && control.target != nil, "the expanded panel must keep the working action: \(title)")
    check(control.frame.maxY <= wideScroll.frame.minY + 0.5 && control.frame.minX >= 0 && control.frame.maxX <= wide.view.bounds.width,
          "the footer control '\(title)' must sit below the list and inside the panel")
}
for control in wideButtons where control.title == "Reduzir" {
    check(control.target === wide && control.action != nil, "Reduzir must be wired to the panel")
    let ink = control.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
    check(ink != nil, "the header button must carry an explicit ink color")
    check(contrastRatio(relativeLuminance(ink!), relativeLuminance(wide.surfaceColor)) >= 4.5,
          "the header button label must clear AA on the dark surface")
}
let expandedDocumentBefore = wideScroll.documentView
wide.update(snapshot: snapshot19, launchAtLogin: false)
check(wideScroll.documentView === expandedDocumentBefore, "polling with the same snapshot must not rebuild the expanded columns")
check(announcements == 1, "an unchanged snapshot must not resize the popover")
if let directory = ProcessInfo.processInfo.environment["REDLINE_TEST_SCREENSHOTS"] {
    wide.view.display()
    let bitmap = wide.view.bitmapImageRepForCachingDisplay(in: wide.view.bounds)!
    wide.view.cacheDisplay(in: wide.view.bounds, to: bitmap)
    try! bitmap.representation(using: .png, properties: [:])!
        .write(to: URL(fileURLWithPath: directory).appendingPathComponent("after-panel-expanded.png"))
}

// Dados novos com altura diferente: o popover ampliado acompanha.
wide.update(snapshot: RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.91, entries: Array(fixtureEntries.prefix(4)), ranking: [:], statusBarEntryIds: []),
    launchAtLogin: false)
check(announcements == 2, "a snapshot that changes the layout must resize the expanded popover")

// Voltar: o compacto é o painel de sempre, reconstruído mesmo com snapshot igual.
wide.update(snapshot: snapshot19, launchAtLogin: false)
wide.toggleExpanded()
check(!wide.isExpanded, "Reduzir must go back to the compact panel")
check(wide.preferredContentSize() == NSSize(width: 460, height: 720), "reduced size is the compact popover")
check(wideScroll.documentView is NSStackView && wideScroll.hasVerticalScroller,
      "the compact panel must be a vertical scrolling list again")
check(descendants(wide.view, of: NSButton.self).contains { $0.title == "Ampliar" }, "the header button must flip back to Ampliar")
check(wide.expandedColumnCount == 0, "no stale columns once compact")

// Reabrir sempre compacto, sem avisar o popover (o dono define o tamanho a seguir).
wide.toggleExpanded()
let announcedBeforeReset = announcements
wide.resetToCompact()
check(!wide.isExpanded && announcements == announcedBeforeReset, "resetToCompact must be silent")

// Tela pequena: nem o máximo de colunas cabe → rolagem vertical, sem cortar conta.
let tight = QuotaPanelController(target: testDelegate)
tight.availableScreenSize = NSSize(width: 1280, height: 720)
tight.update(snapshot: snapshot(updatedAt: now), launchAtLogin: false)
tight.toggleExpanded()
let tightSize = tight.preferredContentSize()
check(tightSize.height == 720 - 32, "a screen too small for every row must cap the popover at the screen (got \(tightSize.height))")
check(tightSize.width <= 1280 - 32, "the expanded panel must never be wider than the screen")
let tightWindow = NSWindow(contentRect: NSRect(origin: .zero, size: tightSize), styleMask: [.borderless], backing: .buffered, defer: false)
tightWindow.contentView = tight.view
tight.view.setFrameSize(tightSize)
tight.view.layoutSubtreeIfNeeded()
check(tight.scrollView.hasVerticalScroller, "when the columns do not fit the list must scroll instead of cutting accounts")
check(tight.scrollView.documentView!.frame.height > tight.scrollView.contentSize.height, "the overflowing list extends below the viewport")
check(tight.scrollView.documentView!.frame.width <= tight.scrollView.contentSize.width + 0.5,
      "the scroller must not steal width from the columns")

// O popover do app acompanha o modo: ampliado não fecha com clique fora (print).
testDelegate.quotaPanel.availableScreenSize = bigScreen
testDelegate.quotaPanel.update(snapshot: snapshot19, launchAtLogin: false)
testDelegate.popover.behavior = .transient
testDelegate.quotaPanel.toggleExpanded()
check(testDelegate.popover.behavior == .applicationDefined,
      "an expanded popover must stay open while the screenshot tool takes the capture")
check(testDelegate.popover.contentSize.width > 400, "the popover must grow with the panel")
testDelegate.quotaPanel.toggleExpanded()
check(testDelegate.popover.behavior == .transient, "reducing must restore the click-outside-to-close behavior")
check(testDelegate.popover.contentSize == NSSize(width: 460, height: 720), "reducing must restore the compact popover size")

// Exercise the on-disk contract: old companions silently discarded these fields.
func decodeEntry(_ extra: [String: Any], windows: [[String: Any]]) -> RedlineEntry {
    var object = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(fixtureEntries[0])) as! [String: Any]
    object.merge(extra) { _, value in value }
    object["windows"] = windows
    return try! JSONDecoder().decode(RedlineEntry.self, from: JSONSerialization.data(withJSONObject: object))
}
let monthlyCursor = decodeEntry(["adapterId": "cursor-agent", "label": "Cursor Agent"], windows: [
    ["kind": "hours", "label": "5 Horas"], ["kind": "weekly", "label": "Semanal"],
    ["kind": "monthly", "label": "Mensal", "usedRatio": 0.42],
])
func showEntry(_ entry: RedlineEntry) {
    panel.update(snapshot: RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
        worstUsedRatio: nil, entries: [entry], ranking: [:], statusBarEntryIds: nil), launchAtLogin: false)
    panel.view.layoutSubtreeIfNeeded()
}
showEntry(monthlyCursor)
check(!fields(panel.view).contains { $0.stringValue.contains("5 Horas") || $0.stringValue.contains("Semanal") },
      "Cursor's monthly allowance must not be preceded by imaginary five-hour/weekly failures")
let connectedNoQuota = decodeEntry(["readHint": "quota-key-required", "excludedReason": "unknown-usage"], windows: [])
showEntry(connectedNoQuota)
check(fields(panel.view).contains { $0.stringValue.contains("Conectado") && $0.stringValue.contains("cota") },
      "a connected account that needs a quota source must keep its actionable diagnosis")
let connectionRepair = descendants(panel.view, of: NSButton.self).first { $0.title == "Resolver no Nexus" }
check(connectionRepair?.target != nil && connectionRepair?.action == #selector(AppDelegate.openNexusApp),
      "an unreadable account must offer a real route to its quota settings")
let estimated = decodeEntry([:], windows: [["kind": "weekly", "label": "Semanal", "usedRatio": 0.99, "estimated": true]])
showEntry(estimated)
check(fields(panel.view).contains { $0.stringValue.localizedCaseInsensitiveContains("estimad") },
      "low-confidence percentages must be explicitly labelled as estimates")
testDelegate.snapshot = RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: nil, entries: [estimated], ranking: [:], statusBarEntryIds: nil)
testDelegate.renderStatusItem()
check(!testDelegate.statusItem.button!.attributedTitle.string.contains("99%"),
      "an estimated percentage must never become the measured status-bar usage")
let measuredCredits = decodeEntry([:], windows: [["kind": "credits", "label": "Token Plan", "usedRatio": 0.34]])
testDelegate.snapshot = RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.34, entries: [measuredCredits], ranking: [:], statusBarEntryIds: nil)
testDelegate.renderStatusItem()
check(testDelegate.statusItem.button!.attributedTitle.string.contains("34%"),
      "a measured Token Plan credit pool must participate in the status-bar summary")

let zeroReading = decodeEntry(["id": "zero-reading"], windows: [["kind": "monthly", "label": "Mensal", "usedRatio": 0]])
let filterSnapshot = RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.42, entries: [monthlyCursor, zeroReading, connectedNoQuota, estimated], ranking: [:], statusBarEntryIds: nil)
panel.update(snapshot: filterSnapshot, launchAtLogin: false)
descendants(panel.view, of: NSButton.self).first { $0.title.hasPrefix("Com leitura") }!.performClick(nil)
check(document.arrangedSubviews.count == 2 && fields(document).contains { $0.stringValue == "42%" }
      && fields(document).contains { $0.stringValue == "0%" },
      "the measured filter must keep confirmed zero/nonzero measurements and exclude estimates and missing data")
descendants(panel.view, of: NSButton.self).first { $0.title.hasPrefix("Resolver  ") }!.performClick(nil)
check(document.arrangedSubviews.count == 2 && !fields(document).contains { $0.stringValue == "42%" },
      "the attention filter must expose missing and estimated quota without borrowing known account readings")
descendants(panel.view, of: NSButton.self).first { $0.title.hasPrefix("Todas") }!.performClick(nil)
check(document.arrangedSubviews.count == 4, "returning to all must restore every account")

// A filter can reduce an expanded grid to one column or an empty state.
let small = QuotaPanelController(target: testDelegate)
small.update(snapshot: filterSnapshot, launchAtLogin: false)
small.toggleExpanded()
let smallWindow = NSWindow(contentRect: NSRect(origin: .zero, size: small.preferredContentSize()),
                           styleMask: [.borderless], backing: .buffered, defer: false)
smallWindow.contentView = small.view
for snapshotEntries in [[monthlyCursor], []] {
    small.update(snapshot: RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
        worstUsedRatio: nil, entries: snapshotEntries, ranking: [:], statusBarEntryIds: nil), launchAtLogin: false)
    smallWindow.setContentSize(small.preferredContentSize())
    small.view.setFrameSize(small.preferredContentSize())
    small.view.layoutSubtreeIfNeeded()
    let controls = descendants(small.view, of: NSButton.self).filter {
        ["Atualizar agora", "Abrir no Nexus", "Iniciar com o macOS", "Sair"].contains($0.title)
    }
    for (index, first) in controls.enumerated() {
        check(first.frame.minX >= 0 && first.frame.maxX <= small.view.bounds.width,
              "expanded filtering must keep every footer action inside the panel")
        for second in controls.dropFirst(index + 1) {
            check(!first.frame.intersects(second.frame), "expanded filtering must not overlap footer controls")
        }
    }
}
let nearReset = decodeEntry(["id": "near-reset", "label": "Near reset"], windows: [
    ["kind": "weekly", "label": "Semanal", "usedRatio": 0.9, "resetsAt": now + 60_000],
])
panel.update(snapshot: RedlineSnapshotFile(formatVersion: 1, generatedBy: "nexus", updatedAt: now,
    worstUsedRatio: 0.9, entries: [nearReset, monthlyCursor], ranking: ["claude": [
        RedlineRankingRow(entryId: "near-reset", adapterId: "claude", label: "Near reset", emailMasked: nil,
                          headroom: 0.99, decisiveWindow: nil, minutesToReset: 1),
    ]], statusBarEntryIds: nil), launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue == "58% livre" },
      "the visible free percentage must use measured consumption, never early reset credit")
let expiredEstimate = decodeEntry(["excludedReason": "needs-relogin"], windows: [
    ["kind": "weekly", "label": "Semanal", "usedRatio": 0.2, "estimated": true],
])
showEntry(expiredEstimate)
check(fields(panel.view).contains { $0.stringValue.contains("Sessão expirada") },
      "estimated-only quota must not hide an expired login")
check(descendants(panel.view, of: NSButton.self).contains { $0.title == "Resolver no Nexus" },
      "estimated-only quota with an expired login must offer recovery")
let cooldownEnd = Date.now.timeIntervalSince1970 * 1000 + 200
let waitingUnknown = decodeEntry(["onCooldown": true, "cooldownUntil": cooldownEnd, "excludedReason": "cooldown"], windows: [])
showEntry(waitingUnknown)
check(fields(panel.view).contains { $0.stringValue == "Em espera · 1m" }, "unknown quota must retain its cooldown")
Thread.sleep(forTimeInterval: 0.3)
showEntry(waitingUnknown)
check(fields(panel.view).contains { $0.stringValue == "Em espera · agora" }, "unknown quota cooldown must advance on unchanged snapshot polls")

NSStatusBar.system.removeStatusItem(testDelegate.statusItem)
print("Redline UI checks passed")
