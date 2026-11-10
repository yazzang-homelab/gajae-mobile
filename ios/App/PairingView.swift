import AVFoundation
import GjcMobileCore
import SwiftUI

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onPaired: (PairedHost) -> Void

    @State private var manual = ""
    @State private var working = false
    @State private var error: String?
    @State private var cameraDenied = false
    @State private var pending: PendingPairing?

    private struct PendingPairing {
        let text: String
        let offer: PairingOffer
        let keyChanged: Bool
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    ZStack {
                        if cameraDenied {
                            Text("카메라 권한이 없습니다.\n설정에서 허용하거나 아래에 페어링 링크를 붙여 넣으세요.")
                                .multilineTextAlignment(.center).foregroundStyle(Palette.muted).padding()
                        } else {
                            QRScannerView { code in request(code, confirm: false) }
                        }
                        if working { ProgressView().controlSize(.large).tint(Palette.cream) }
                    }
                    .frame(height: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .card()

                    Text("호스트 터미널에서 `gjcm-bridge pair`를 실행하면 10분 동안 한 번 쓸 수 있는 QR 코드가 나옵니다.")
                        .font(.footnote).foregroundStyle(Palette.muted)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("또는 링크 붙여 넣기").font(.caption).foregroundStyle(Palette.muted)
                        TextField("gjcm://pair?o=…", text: $manual, axis: .vertical)
                            .font(.caption.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .padding(10).card()
                        Button("연결") { request(manual, confirm: false) }
                            .buttonStyle(.borderedProminent)
                            .disabled(manual.isEmpty || working)
                    }

                    if let error {
                        Text(error).font(.footnote).foregroundStyle(Palette.gajaeRed)
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
                Button("취소", role: .cancel) {}
                Button(request.keyChanged ? "교체" : "연결", role: request.keyChanged ? .destructive : nil) {
                    submit(request.text, replaceChangedKey: request.keyChanged)
                }
            } message: { request in
                Text(confirmationMessage(for: request))
            }
            .task {
                if let pending = model.pairingURL {
                    model.pairingURL = nil
                    let confirm = model.pairingNeedsConfirmation
                    model.pairingNeedsConfirmation = true
                    request(pending, confirm: confirm)
                }
                cameraDenied = !(await AVCaptureDevice.requestAccess(for: .video))
            }
        }
    }

    private func tryDemo() {
        guard !working else { return }
        error = nil
        Task {
            do {
                request(try await DemoHost.pairingLink(), confirm: false)
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
    /// here goes straight through unless it would replace a known host's key.
    private func request(_ text: String, confirm: Bool) {
        guard !working, confirm || pending == nil else { return }
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
        let keyChanged = offer.disposition(among: model.hosts) == .keyChanged
        if confirm || keyChanged {
            error = nil
            pending = PendingPairing(text: trimmed, offer: offer, keyChanged: keyChanged)
        } else {
            submit(trimmed)
        }
    }

    private func submit(_ text: String, replaceChangedKey: Bool = false) {
        guard !working else { return }
        working = true
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
