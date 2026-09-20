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
let renderedFields = fields(panel.view)
check(renderedFields.contains { $0.stringValue.contains("Conta 24") }, "the last account must have a visible label")
check(renderedFields.contains { $0.stringValue.contains("37% usado") }, "usage must be readable without relying on color")
check(renderedFields.allSatisfy(\.isEnabled), "quota text must not be dimmed as disabled menu actions")
for title in ["Atualizar agora", "Abrir no Nexus", "Iniciar com o macOS", "Sair"] {
    check(panel.view.subviews.compactMap { $0 as? NSButton }.contains { $0.title == title && $0.action != nil && $0.target != nil },
          "the panel must retain the working action: \(title)")
}

func capture(_ name: String) {
    guard let directory = ProcessInfo.processInfo.environment["REDLINE_TEST_SCREENSHOTS"] else { return }
    panel.view.display()
    let bitmap = panel.view.bitmapImageRepForCachingDisplay(in: panel.view.bounds)!
    panel.view.cacheDisplay(in: panel.view.bounds, to: bitmap)
    try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent("after-" + name + ".png"))
}

// Change the appearance of the same live view without rebuilding its labels.
for appearance in [NSAppearance.Name.aqua, .darkAqua] {
    panel.view.appearance = NSAppearance(named: appearance)
    panel.view.effectiveAppearance.performAsCurrentDrawingAppearance {
        let background = relativeLuminance(.windowBackgroundColor)
        for ink in [NSColor.labelColor, urgencyColor(forUsed: nil), urgencyColor(forUsed: 0.2), urgencyColor(forUsed: 0.7), urgencyColor(forUsed: 0.9)] {
            let foreground = relativeLuminance(ink)
            let contrast = (max(background, foreground) + 0.05) / (min(background, foreground) + 0.05)
            check(contrast >= 4.5, "small quota text must retain AA contrast in \(appearance.rawValue): \(contrast)")
        }
    }
    capture(appearance == .aqua ? "panel-light" : "panel-dark")
}

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
panel.view.appearance = NSAppearance(named: .aqua)
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
