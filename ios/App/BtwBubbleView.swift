import GjcMobileCore
import SwiftUI

/// The `/btw` side chat as a speech bubble floating over the chat: its own composer, answered from the
/// session's visible conversation (`turn.btw`) and never written to the transcript.
/// Close drops it, the composer asks a follow-up, 포크 continues it in a copy of the session.
struct BtwBubbleView: View {
    @Bindable var chat: ChatModel
    let conversation: BtwConversation
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
                .onTapGesture { focused = false }
            VStack(spacing: 0) {
                header
                Divider().overlay(Palette.shellLine)
                exchanges
                Divider().overlay(Palette.shellLine)
                composer
            }
            .background(Palette.shell, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Palette.strawGold.opacity(0.7), lineWidth: 1))
            .overlay(alignment: .bottomLeading) { tail }
            .padding(.horizontal, 20)
            .frame(maxHeight: 520)
            .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
        }
        .onAppear { focused = conversation.exchanges.isEmpty }
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "bubble.left.and.text.bubble.right").foregroundStyle(Palette.strawGold)
            VStack(alignment: .leading, spacing: 1) {
                Text("/btw 사이드 대화").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.cream)
                Text("본 대화를 참고하지만 기록에는 남지 않습니다").font(.caption2).foregroundStyle(Palette.muted)
            }
            Spacer()
            Button { Task { await chat.forkBtw() } } label: { Label("포크", systemImage: "arrow.triangle.branch") }
                .font(.caption).buttonStyle(.bordered).tint(Palette.strawGold)
                .disabled(!conversation.hasAnswer || conversation.isPending || chat.sending)
                .accessibilityHint("세션을 복제하고 이 대화를 새 세션의 입력창에 넣습니다")
            Button { withAnimation(.easeOut(duration: 0.15)) { chat.closeBtw() } } label: {
                Image(systemName: "xmark.circle.fill").font(.title3).foregroundStyle(Palette.muted)
            }
            .accessibilityLabel("사이드 대화 닫기")
        }
        .padding(14)
    }

    private var exchanges: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if conversation.exchanges.isEmpty {
                        Text("진행 중인 작업을 멈추지 않고 잠깐 물어볼 수 있습니다.")
                            .font(.caption).foregroundStyle(Palette.muted)
                    }
                    ForEach(conversation.exchanges) { exchange in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Spacer(minLength: 40)
                                Text(exchange.question).font(.callout).foregroundStyle(Palette.ink)
                                    .padding(10).background(Palette.cream, in: RoundedRectangle(cornerRadius: 14))
                            }
                            if let answer = exchange.answer {
                                SelectableText(text: RichText.markdown(answer, style: .callout, color: Palette.cream))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } else if let error = exchange.error {
                                Text(error).font(.caption).foregroundStyle(Palette.gajaeRed)
                            } else {
                                HStack(spacing: 6) {
                                    ProgressView().tint(Palette.strawGold)
                                    Text("답변 중").font(.caption).foregroundStyle(Palette.muted)
                                }
                            }
                        }
                        .id(exchange.id)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
            .onChange(of: conversation) { _, new in
                guard let last = new.exchanges.last?.id else { return }
                withAnimation { proxy.scrollTo(last, anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(conversation.exchanges.isEmpty ? "잠깐 물어볼 것" : "이어서 묻기", text: $chat.btwDraft, axis: .vertical)
                .lineLimit(1 ... 4)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .padding(10)
                .card(stroke: focused ? Palette.strawGold : Palette.shellLine)
            Button { Task { await chat.askBtw() } } label: {
                Image(systemName: conversation.isPending ? "hourglass" : "arrow.up.circle.fill").font(.title)
                    .foregroundStyle(canAsk ? Palette.strawGold : Palette.muted)
            }
            .disabled(!canAsk)
            .accessibilityLabel("사이드 질문 보내기")
        }
        .padding(12)
    }

    private var canAsk: Bool {
        chat.connected && !conversation.isPending && !chat.btwDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The speech-bubble tail, pointing back at the composer the question came from.
    private var tail: some View {
        Path { p in
            p.move(to: CGPoint(x: 0, y: 0))
            p.addLine(to: CGPoint(x: 18, y: 0))
            p.addLine(to: CGPoint(x: 4, y: 16))
            p.closeSubpath()
        }
        .fill(Palette.shell)
        .frame(width: 18, height: 16)
        .offset(x: 48, y: 15)
        .accessibilityHidden(true)
    }
}
