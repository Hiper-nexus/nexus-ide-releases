import AppKit

/// Instrument-style segmented consumption meter; no fill is fabricated for unknown usage.
final class QuotaMeterView: NSView {
    private let ratio: Double?
    private let ink: NSColor
    private let track: NSColor
    private let segmentCount = 28
    private let segmentGap: CGFloat = 2
    private let barHeight: CGFloat = 13
    private let scaleHeight: CGFloat = 7

    init(quota: RedlineWindow, ink: NSColor, track: NSColor) {
        ratio = quota.usedRatio
        self.ink = ink
        self.track = track
        super.init(frame: .zero)
        setAccessibilityElement(true)
        let percent = quota.usedRatio.map { "\(Int(($0 * 100).rounded()))% usado" } ?? "sem leitura"
        setAccessibilityLabel("\(quota.label), \(percent)\(quota.estimated == true ? ", estimado" : "")")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: barHeight + scaleHeight) }

    private func segments(_ fill: NSColor) {
        let width = (bounds.width - CGFloat(segmentCount - 1) * segmentGap) / CGFloat(segmentCount)
        guard width > 0 else { return }
        let bevel = min(CGFloat(3), width / 3)
        fill.setFill()
        for index in 0..<segmentCount {
            let x = CGFloat(index) * (width + segmentGap)
            let path = NSBezierPath()
            path.move(to: NSPoint(x: x, y: scaleHeight))
            path.line(to: NSPoint(x: x + width - bevel, y: scaleHeight))
            path.line(to: NSPoint(x: x + width, y: scaleHeight + barHeight))
            path.line(to: NSPoint(x: x + bevel, y: scaleHeight + barHeight))
            path.close()
            path.fill()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        segments(track)
        if let ratio, ratio > 0 {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: NSRect(x: 0, y: 0, width: bounds.width * CGFloat(min(1, max(0, ratio))), height: bounds.height)).addClip()
            segments(ink)
            NSGraphicsContext.restoreGraphicsState()
        }
        track.setStroke()
        let scale = NSBezierPath()
        for step in 0...4 {
            let x = max(0.5, min(bounds.width - 0.5, bounds.width * CGFloat(step) / 4))
            scale.move(to: NSPoint(x: x, y: 0))
            scale.line(to: NSPoint(x: x, y: step.isMultiple(of: 2) ? 4 : 2))
        }
        scale.lineWidth = 1
        scale.stroke()
    }
}

/// Each segment is one real account, colored by its highest measured window.
final class QuotaFleetStrip: NSView {
    var inks: [NSColor] = [] { didSet { needsDisplay = true } }
    override func draw(_ dirtyRect: NSRect) {
        guard !inks.isEmpty else { return }
        let gap = min(CGFloat(3), bounds.width / CGFloat(inks.count * 3))
        let width = max(1, (bounds.width - gap * CGFloat(inks.count - 1)) / CGFloat(inks.count))
        for (index, ink) in inks.enumerated() {
            ink.setFill()
            NSBezierPath(roundedRect: NSRect(x: CGFloat(index) * (width + gap), y: 0,
                                           width: width, height: bounds.height), xRadius: 2, yRadius: 2).fill()
        }
    }
}
