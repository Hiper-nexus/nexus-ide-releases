import AppKit

/// A real usage fraction: the arc is consumed quota, the remaining track is free.
/// Unknown values stay empty and estimated values are explicitly announced.
final class QuotaOrbitView: NSView {
    private let ratio: Double?
    private let ink: NSColor
    private let track: NSColor
    private let value = NSTextField(labelWithString: "")
    private let unit = NSTextField(labelWithString: "usado")
    private let diameter: CGFloat = 64
    private let stroke: CGFloat = 5

    init(quota: RedlineWindow, ink: NSColor, track: NSColor, text: NSColor, muted: NSColor) {
        ratio = quota.usedRatio
        self.ink = ink
        self.track = track
        super.init(frame: .zero)
        value.stringValue = quota.usedRatio.map { "\(Int(($0 * 100).rounded()))%" } ?? "—"
        value.font = .monospacedDigitSystemFont(ofSize: 17, weight: .semibold)
        value.textColor = text
        value.alignment = .center
        unit.font = .systemFont(ofSize: 10, weight: .medium)
        unit.textColor = muted
        unit.alignment = .center
        unit.isHidden = ratio == nil
        addSubview(value)
        addSubview(unit)
        setAccessibilityElement(true)
        setAccessibilityLabel("\(quota.label), \(value.stringValue) usado\(quota.estimated == true ? ", estimado" : "")")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: NSSize { NSSize(width: diameter, height: diameter) }

    override func layout() {
        super.layout()
        value.frame = NSRect(x: 0, y: bounds.midY - (ratio == nil ? 11 : 3), width: bounds.width, height: 22)
        unit.frame = NSRect(x: 0, y: bounds.midY - 14, width: bounds.width, height: 12)
    }

    override func draw(_ dirtyRect: NSRect) {
        let circle = bounds.insetBy(dx: stroke, dy: stroke)
        let path = NSBezierPath(ovalIn: circle)
        path.lineWidth = stroke
        track.setStroke()
        path.stroke()
        guard let ratio, ratio > 0 else { return }
        let arc = NSBezierPath()
        arc.appendArc(withCenter: NSPoint(x: bounds.midX, y: bounds.midY),
                      radius: circle.width / 2, startAngle: 90,
                      endAngle: 90 - CGFloat(min(1, max(0, ratio))) * 360, clockwise: true)
        arc.lineWidth = stroke
        arc.lineCapStyle = .round
        ink.setStroke()
        arc.stroke()
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
