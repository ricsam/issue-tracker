import AppKit

// Threadline's web brand: Lucide Layers (ISC; see ../Resources/NOTICE.txt),
// white on the same #7352D5 rounded purple square used by .brand-mark.
// Vector paths are rendered at every native icon size, never upscaled from a small PNG.
func layers() -> NSBezierPath {
    let path = NSBezierPath()
    path.move(to: NSPoint(x: 12.83, y: 2.18))
    path.curve(to: NSPoint(x: 11.17, y: 2.18), controlPoint1: NSPoint(x: 12.30, y: 1.94), controlPoint2: NSPoint(x: 11.70, y: 1.94))
    path.line(to: NSPoint(x: 2.6, y: 6.08))
    path.curve(to: NSPoint(x: 2.6, y: 7.91), controlPoint1: NSPoint(x: 1.80, y: 6.44), controlPoint2: NSPoint(x: 1.80, y: 7.55))
    path.line(to: NSPoint(x: 11.18, y: 11.82))
    path.curve(to: NSPoint(x: 12.84, y: 11.82), controlPoint1: NSPoint(x: 11.71, y: 12.06), controlPoint2: NSPoint(x: 12.31, y: 12.06))
    path.line(to: NSPoint(x: 21.42, y: 7.92))
    path.curve(to: NSPoint(x: 21.42, y: 6.09), controlPoint1: NSPoint(x: 22.22, y: 7.56), controlPoint2: NSPoint(x: 22.22, y: 6.45))
    path.close()
    for y: CGFloat in [12, 17] {
        path.move(to: NSPoint(x: 2, y: y))
        path.curve(to: NSPoint(x: 2.58, y: y + 0.91), controlPoint1: NSPoint(x: 2, y: y + 0.39), controlPoint2: NSPoint(x: 2.23, y: y + 0.75))
        path.line(to: NSPoint(x: 11.18, y: y + 4.82))
        path.curve(to: NSPoint(x: 12.83, y: y + 4.82), controlPoint1: NSPoint(x: 11.70, y: y + 5.06), controlPoint2: NSPoint(x: 12.30, y: y + 5.06))
        path.line(to: NSPoint(x: 21.41, y: y + 0.92))
        path.curve(to: NSPoint(x: 22, y: y), controlPoint1: NSPoint(x: 21.77, y: y + 0.76), controlPoint2: NSPoint(x: 22, y: y + 0.40))
    }
    path.lineWidth = 2
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    return path
}

func render(pixels: Int, template: Bool, to url: URL) throws {
    let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
    let size = CGFloat(pixels)
    if !template {
        NSColor(srgbRed: 115/255, green: 82/255, blue: 213/255, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: size * 0.10, y: size * 0.10, width: size * 0.80, height: size * 0.80),
                     xRadius: size * 0.19, yRadius: size * 0.19).fill()
    }
    let glyph = size * (template ? 1 : 0.54)
    let inset = (size - glyph) / 2
    let transform = AffineTransform(translationByX: inset, byY: size - inset)
    let native = NSAffineTransform(transform: transform)
    native.scaleX(by: glyph / 24, yBy: -glyph / 24)
    native.concat()
    (template ? NSColor.black : NSColor.white).setStroke()
    layers().stroke()
    NSGraphicsContext.restoreGraphicsState()
    try image.representation(using: .png, properties: [:])!.write(to: url)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let iconset = output.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        try render(pixels: points * scale, template: false,
                   to: iconset.appendingPathComponent("icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"))
    }
}
for scale in [1, 2] {
    try render(pixels: 18 * scale, template: true,
               to: output.appendingPathComponent("MenuBarIcon\(scale == 2 ? "@2x" : "").png"))
}
