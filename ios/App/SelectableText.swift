import SwiftUI
import UIKit

/// Read-only `UITextView`: long-press/drag selects any range and copies just that, and links (markdown
/// `[label](url)` or bare URLs) open in the default browser. SwiftUI `Text.textSelection` on iOS only
/// offers "copy the whole string", which is useless for long answers.
struct SelectableText: UIViewRepresentable {
    let text: NSAttributedString
    /// false: lay out on one line per paragraph (code blocks inside a horizontal ScrollView).
    var wraps = true

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = [.link]
        view.linkTextAttributes = [
            .foregroundColor: UIColor(Palette.strawGold),
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        // Reassigning identical text would drop an in-progress selection on every SwiftUI update.
        if !view.attributedText.isEqual(to: text) { view.attributedText = text }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: UITextView, context: Context) -> CGSize? {
        let limit = wraps ? (proposal.width ?? .greatestFiniteMagnitude) : .greatestFiniteMagnitude
        let used = text.boundingRect(
            with: CGSize(width: limit, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        // Hug short text (chat bubbles) but never exceed the offered width.
        let width = min(ceil(used.width), limit)
        let height = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: ceil(height))
    }
}

/// UIKit attributed strings for `SelectableText`, styled like the SwiftUI views they replace.
@MainActor
enum RichText {
    static func font(_ style: UIFont.TextStyle, monospaced: Bool = false) -> UIFont {
        let base = UIFont.preferredFont(forTextStyle: style)
        return monospaced ? UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: .regular) : base
    }

    static func plain(_ text: String, font: UIFont, color: Color) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: UIColor(color)])
    }

    /// Inline markdown (bold, italic, `code`, ~~strike~~, links) with whitespace and line breaks preserved.
    static func markdown(_ source: String, style: UIFont.TextStyle = .body, color: Color) -> NSAttributedString {
        var attributed = (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(source)
        let base = font(style)
        let mono = font(style, monospaced: true)
        for run in attributed.runs {
            let intent = run.inlinePresentationIntent ?? []
            var runFont = intent.contains(.code) ? mono : base
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty,
               let descriptor = runFont.fontDescriptor.withSymbolicTraits(runFont.fontDescriptor.symbolicTraits.union(traits))
            {
                runFont = UIFont(descriptor: descriptor, size: 0)
            }
            attributed[run.range].uiKit.font = runFont
            attributed[run.range].uiKit.foregroundColor = UIColor(intent.contains(.code) ? Palette.strawGold : color)
            if intent.contains(.strikethrough) { attributed[run.range].uiKit.strikethroughStyle = .single }
        }
        return (try? NSAttributedString(attributed, including: \.uiKit)) ?? plain(source, font: base, color: color)
    }
}
