import AVFoundation
import GjcMobileCore
import SwiftUI

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPaired: (PairedHost) -> Void

    @State private var codeText = ""
    @State private var manual = ""
    @State private var working = false
    @State private var workingWithCode = false
    @State private var retryable = false
    @State private var error: String?
    @State private var showScanner = false
    @State private var showLink = false
    @State private var cameraDenied = false
    @State private var pending: PendingPairing?

    private struct PendingPairing {
        let text: String
        let offer: PairingOffer
        let keyChanged: Bool
        /// The offer came from a device code: confirming goes back to the code flow, cancelling drops the held offer.
        var isCode = false
    }

    private var progressText: String? {
        guard working, workingWithCode else { return nil }
        switch model.codeStage {
        case .connecting: return "연결 중…"
        case let .verifying(left):
            guard let left else { return "확인 중…" }
            return "확인 중 · 남은 시도 \(left)회"
        case nil: return "등록 중…"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    codeSection

                    Text("호스트 터미널에서 `gjcm-bridge pair`를 실행하면 15분 동안 한 번 쓸 수 있는 코드와 QR이 나옵니다.")
                        .font(.footnote).foregroundStyle(Palette.muted)

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(Palette.gajaeRed)
                    }

                    HStack(spacing: 12) {
                        Button { showScanner.toggle() } label: {
                            Label("QR 스캔", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered).tint(showScanner ? Palette.strawGold : Palette.cream)
                        Button { showLink.toggle() } label: {
                            Label("링크 붙여 넣기", systemImage: "link").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered).tint(showLink ? Palette.strawGold : Palette.cream)
                    }
                    .disabled(working)

                    if showScanner {
                        ZStack {
                            if cameraDenied {
                                Text("카메라 권한이 없습니다.\n설정에서 허용하거나 코드를 입력하세요.")
                                    .multilineTextAlignment(.center).foregroundStyle(Palette.muted).padding()
                            } else {
                                QRScannerView { code in if pending == nil { request(code, fromLink: false) } }
                            }
                            if working { ProgressView().controlSize(.large).tint(Palette.cream) }
                        }
                        .frame(height: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .card()
                    }

                    if showLink {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("gjcm://pair?o=…", text: $manual, axis: .vertical)
                                .font(.caption.monospaced())
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(10).card()
                            Button("연결") { request(manual, fromLink: false) }
                                .buttonStyle(.borderedProminent)
                                .disabled(manual.isEmpty || working)
                        }
                    }

                    if DemoHost.offerURL != nil {
                        VStack(spacing: 6) {
                            Divider().overlay(Palette.shellLine)
                            Button { tryDemo() } label: {
                                Label("데모 호스트로 체험하기", systemImage: "play.circle").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered).tint(Palette.strawGold)
                            .disabled(working)
                            Text("컴퓨터가 없어도 정해진 응답을 돌려주는 데모 호스트에 연결해 기능을 둘러볼 수 있습니다. 데모 호스트에서는 아무 명령도 실행되지 않습니다.")
                                .font(.caption2).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        }
                    }
                }
                .padding()
            }
            .background(Palette.ink)
            .navigationTitle("호스트 페어링")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
            .alert(
                pending?.keyChanged == true ? "호스트 교체" : "이 호스트에 연결할까요?",
                isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                presenting: pending
            ) { request in
                Button("취소", role: .cancel) { if request.isCode { model.discardCodeOffer() } }
                Button(request.keyChanged ? "교체" : "연결", role: request.keyChanged ? .destructive : nil) {
                    if request.isCode {
                        submitCode(replaceChangedKey: true)
                    } else {
                        submit(request.text, replaceChangedKey: request.keyChanged)
                    }
                }
            } message: { request in
                Text(confirmationMessage(for: request))
            }
            .onChange(of: codeText) { _, text in
                error = nil
                retryable = false
                // Rewrite the field with the normalized text; formatting is idempotent, so this settles at once.
                let display = CodeInputFormatter.format(text).display
                if display != text { codeText = display }
            }
            .onChange(of: error) { _, message in
                if let message { AccessibilityNotification.Announcement(message).post() }
            }
            .onChange(of: progressText) { _, message in
                if let message { AccessibilityNotification.Announcement(message).post() }
            }
            .onChange(of: showScanner) { _, scanning in
                guard scanning else { return }
                Task { cameraDenied = !(await AVCaptureDevice.requestAccess(for: .video)) }
            }
            .task {
                if let link = model.pairingLink {
                    model.pairingLink = nil
                    request(link.text, fromLink: link.fromLink)
                }
            }
        }
    }

    private var codeSection: some View {
        let input = CodeInputFormatter.format(codeText)
        return VStack(alignment: .leading, spacing: 8) {
            Text("호스트에 표시된 코드 입력").font(.caption).foregroundStyle(Palette.muted)
            TextField("호스트 코드", text: $codeText, prompt: Text("K7M2-9QXD-HP"))
                .accessibilityHint("0, O, 1, I는 쓰이지 않습니다")
                .font(.title2.monospaced())
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .submitLabel(.go)
                .onSubmit { if codeIsReady(input) { submitCode() } }
                .padding(12).card(stroke: input.invalidPosition == nil ? Palette.shellLine : Palette.gajaeRed)
            if let position = input.invalidPosition, let character = input.invalidCharacter {
                Text("\(position)번째 글자 ‘\(String(character))’을(를) 확인하세요. 코드에는 0·O·1·I가 쓰이지 않습니다.")
                    .font(.footnote).foregroundStyle(Palette.gajaeRed)
            }
            HStack {
                Button(retryable ? "다시 시도" : "연결") { submitCode() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!codeIsReady(input) || working)
                if let progressText {
                    ProgressView().tint(Palette.cream)
                    Text(progressText).font(.footnote).foregroundStyle(Palette.muted)
                }
            }
        }
    }

    private func codeIsReady(_ input: CodeInputState) -> Bool {
        !input.code.isEmpty && input.invalidPosition == nil
    }

    /// The code flow: the host answers with the offer, a known host's key change is confirmed, then the hello pairs.
    private func submitCode(replaceChangedKey: Bool = false) {
        guard !working else { return }
        working = true
        workingWithCode = true
        error = nil
        retryable = false
        Task {
            defer { working = false }
            do {
                onPaired(try await model.pair(code: codeText, replaceChangedKey: replaceChangedKey))
            } catch PairingRefused.keyChanged {
                if let offer = model.pendingCodeOffer {
                    pending = PendingPairing(text: "", offer: offer, keyChanged: true, isCode: true)
                }
            } catch let failure as CodePairingError {
                error = failure.errorDescription
                retryable = failure.isRetryable
            } catch let parse as PairingOffer.ParseError {
                error = parseErrorMessage(parse)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    private func tryDemo() {
        guard !working else { return }
        error = nil
        Task {
            do {
                request(try await DemoHost.pairingLink(), fromLink: false)
            } catch {
                self.error = DemoHost.failure
            }
        }
    }

    private func parseErrorMessage(_ parse: PairingOffer.ParseError) -> String {
        switch parse {
        case .expired: "QR 코드가 만료됐습니다. 호스트에서 다시 `gjcm-bridge pair`를 실행하세요."
        case .unsupportedVersion: "이 앱보다 새 버전의 브리지입니다. 앱을 업데이트하세요."
        default: "가재코드 페어링 QR이 아닙니다."
        }
    }

    private func confirmationMessage(for request: PendingPairing) -> String {
        let name = request.offer.name.isEmpty ? request.offer.hostId : request.offer.name
        let target = ([name] + request.offer.endpoints).joined(separator: "\n")
        guard request.keyChanged else { return target }
        return "이미 등록된 호스트의 키가 바뀌었습니다\n믿을 수 있는 호스트가 아니라면 교체하지 마세요. 교체하면 이후 지시문과 첨부 파일이 이 호스트로 갑니다.\n\n" + target
    }

    /// A link that arrived from outside the app is always confirmed first; an offer the user scanned or pasted
    /// here goes straight through unless it would replace a known host's key. A new request replaces a pending
    /// one, so a confirmation that failed to appear never blocks pasting (the scanner just ignores codes while one
    /// is pending, so a second QR cannot swap the target under a shown alert).
    private func request(_ text: String, fromLink: Bool) {
        guard !working else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let offer: PairingOffer
        do {
            offer = try PairingOffer.parse(trimmed)
        } catch let parse as PairingOffer.ParseError {
            error = parseErrorMessage(parse)
            return
        } catch {
            self.error = error.localizedDescription
            return
        }
        let confirmation = offer.confirmation(among: model.hosts, fromLink: fromLink)
        if confirmation != .none {
            error = nil
            pending = PendingPairing(text: trimmed, offer: offer, keyChanged: confirmation == .replaceKey)
        } else {
            submit(trimmed)
        }
    }

    private func submit(_ text: String, replaceChangedKey: Bool = false) {
        guard !working else { return }
        working = true
        workingWithCode = false
        error = nil
        Task {
            defer { working = false }
            do {
                onPaired(try await model.pair(with: text.trimmingCharacters(in: .whitespacesAndNewlines), replaceChangedKey: replaceChangedKey))
            } catch let parse as PairingOffer.ParseError {
                error = parseErrorMessage(parse)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// The public review demo host (bridge/demo): scripted replies, nothing executed. Its `GET /offer` hands out a
/// reusable pairing link, so App Store and Google Play reviewers can try every feature without a computer.
enum DemoHost {
    static let offerURL = (Bundle.main.object(forInfoDictionaryKey: "GJCMDemoOfferURL") as? String).flatMap(URL.init(string:))
    static let failure = "데모 호스트에 연결하지 못했습니다. 잠시 후 다시 시도하세요."

    static func pairingLink() async throws -> String {
        guard let offerURL else { throw URLError(.unsupportedURL) }
        var request = URLRequest(url: offerURL)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let link = try JSONDecoder().decode([String: String].self, from: data)["url"]
        else { throw URLError(.badServerResponse) }
        return link
    }
}

/// Minimal AVFoundation QR reader; reports each distinct payload once.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
    }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        // AVCaptureSession is thread-safe for start/stop; Apple recommends starting it off the main thread.
        nonisolated(unsafe) private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var lastCode: String?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            DispatchQueue.global(qos: .userInitiated).async { [self] in session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session.stopRunning()
        }

        // Delivered on the main queue (setMetadataObjectsDelegate(self, queue: .main)).
        nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard let code = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            MainActor.assumeIsolated {
                guard code != lastCode else { return }
                lastCode = code
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                onCode?(code)
            }
        }
    }
}
