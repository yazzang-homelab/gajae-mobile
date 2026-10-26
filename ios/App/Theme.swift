import SwiftUI

/// Colors measured from the gajae-code hero/logo art (brand/PALETTE.md). Dark theme only.
enum Palette {
    static let gajaeRed = Color(hex: 0xEA4523)
    static let strawGold = Color(hex: 0xED9324)
    static let visorGreen = Color(hex: 0x25DF87)
    static let cream = Color(hex: 0xF7E7D1)
    static let ink = Color(hex: 0x0A0707)
    static let shell = Color(hex: 0x1A1110)
    static let shellLine = Color(hex: 0x3A2420)
    static let muted = Color(hex: 0xA8968A)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

struct CardBackground: ViewModifier {
    var stroke: Color = Palette.shellLine

    func body(content: Content) -> some View {
        content
            .background(Palette.shell, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(stroke, lineWidth: 1))
    }
}

extension View {
    func card(stroke: Color = Palette.shellLine) -> some View { modifier(CardBackground(stroke: stroke)) }
}
