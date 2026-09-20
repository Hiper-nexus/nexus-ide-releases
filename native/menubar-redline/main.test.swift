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
let testWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
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
check(renderedFields.contains { $0.stringValue.contains("Conta 24") }, "the last account must have a visible label")
check(renderedFields.contains { $0.stringValue.contains("37% usado") }, "usage must be readable without relying on color")
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
check(fields(panel.view).contains { $0.stringValue.contains("Mensal · Sem leitura") }, "unknown quota must remain visible without inventing zero usage")
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
check(fields(panel.view).contains { $0.stringValue.contains("reseta em 1m") }, "the reset should start in the future, on the same line as the gauge")
Thread.sleep(forTimeInterval: 0.25)
panel.update(snapshot: timedSnapshot, launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue.contains("reseta em agora") }, "reset countdown must advance even without new snapshot data")
check(fields(panel.view).contains { $0.stringValue.contains("Em espera · agora") }, "cooldown countdown must advance without rebuilding accounts")
panel.update(snapshot: nil, launchAtLogin: false)
check(fields(panel.view).contains { $0.stringValue.contains("Sem dados ainda") }, "missing snapshots must explain how to load data")
capture("panel-empty")
NSStatusBar.system.removeStatusItem(testDelegate.statusItem)
print("Redline UI checks passed")
