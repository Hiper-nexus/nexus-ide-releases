import AppKit

// Logos reais dos providers, rasterizados por scripts/build-redline-logos.mjs
// (AppKit/CoreSVG renderiza os SVGs quase em branco — medido: gemini-color
// virava 14 pixels opacos em 1024). Fora de um .app, o harness aponta
// REDLINE_ASSETS_DIR para native/menubar-redline/assets; dentro do bundle,
// os PNGs moram em Contents/Resources/provider-logos/.

struct RedlineLogoInfo: Codable {
    let file: String
    let mono: Bool?
}

enum RedlineAssets {
    static let directory: URL? = {
        if let env = ProcessInfo.processInfo.environment["REDLINE_ASSETS_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return Bundle.main.resourceURL
    }()

    static let manifest: [String: RedlineLogoInfo] = {
        guard let url = directory?.appendingPathComponent("provider-logos/manifest.json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([String: RedlineLogoInfo].self, from: data)
        else { return [:] }
        return decoded
    }()

    /// Marca oficial do provider. `mono` pede tingimento template — marca
    /// preta sobre superfície near-black some sem isso. Sem logo mapeado, a
    /// linha fica só no texto: nunca um substituto Unicode fingindo marca.
    static func logoView(for adapterId: String, tint: NSColor) -> NSImageView? {
        guard let info = manifest[adapterId], let base = directory else { return nil }
        let url = base.appendingPathComponent("provider-logos/\(info.file)")
        guard let image = NSImage(contentsOf: url) else { return nil }
        let view = NSImageView(image: image)
        if info.mono == true {
            image.isTemplate = true
            view.contentTintColor = tint
        }
        return view
    }
}
