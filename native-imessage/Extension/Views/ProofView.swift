import AVFoundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

struct ProofView: View {
    @EnvironmentObject var model: AppModel
    let betID: String
    let canUpload: Bool
    @State private var references: [ProofReference] = []
    @State private var selected: PrivateProof?
    @State private var player: AVAudioPlayer?
    @State private var importing = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        SectionTitle(text: "Optional proof")
        if canUpload {
            Button("Choose photo or audio proof") { importing = true }
                .frame(minHeight: 44).disabled(busy).accessibilityIdentifier("proof.choose")
            Footnote(text: "Only the file you choose is uploaded. Photos are resized and their metadata removed. Audio must be under 512 KiB and may retain file metadata. Proof is visible only to eligible group members after reveal.")
        }
        ForEach(references) { reference in
            Button(reference.contentType == "audio/mp4" ? "Open audio proof" : "Open photo proof") { Task { await read(reference) } }
                .frame(minHeight: 44).disabled(busy).accessibilityIdentifier("proof.open.\(reference.id)")
        }
        if let selected {
            if selected.contentType == "audio/mp4" {
                Button("Play authorized audio") { player?.play() }.frame(minHeight: 44)
                Button("Stop audio") { player?.stop() }.frame(minHeight: 44)
            } else if let image = UIImage(data: selected.bytes.data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 300)
                    .accessibilityLabel("Photo proof selected by the subject")
            }
        }
        if busy { ProgressView() }
        ErrorText(text: error)
            .task(id: betID) { await load() }
            .onDisappear { clear() }
            .onChange(of: model.isActive) { _, active in if !active { clear() } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.jpeg, .png, .mpeg4Audio], allowsMultipleSelection: false) { result in
                switch result {
                case .success(let urls): if let url = urls.first { Task { await upload(url) } }
                case .failure: error = "Couldn't open that file. No proof was uploaded."
                }
            }
    }

    private func clear() {
        player?.stop()
        player = nil
        selected = nil
    }

    private func load() async {
        guard let token = model.token, model.isActive else { return }
        do {
            let result: [ProofReference]? = try await API.query("v0Proof:list", ["token": token, "betId": betID])
            guard model.token == token, model.isActive else { return }
            references = result ?? []
        } catch { references = []; clear(); self.error = error.localizedDescription; model.handle(error) }
    }

    private func read(_ reference: ProofReference) async {
        guard let token = model.token, model.isActive, !busy else { return }
        busy = true
        defer { busy = false }
        clear()
        do {
            let result: PrivateProof? = try await API.action("v0Proof:read", ["token": token, "proofId": reference.id])
            guard model.token == token, model.isActive else { return }
            guard let result, result.id == reference.id, result.contentType == reference.contentType,
                  ["image/jpeg", "image/png", "audio/mp4"].contains(result.contentType) else { throw NativeError.invalidLink }
            if result.contentType == "audio/mp4" { player = try AVAudioPlayer(data: result.bytes.data) }
            selected = result
            error = nil
        } catch { clear(); self.error = error.localizedDescription; model.handle(error) }
    }

    private func upload(_ url: URL) async {
        guard let token = model.token, model.isActive, canUpload, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let prepared = try await Task.detached(priority: .userInitiated) { try ProofPreparation.prepare(url) }.value
            guard model.token == token, model.isActive else { return }
            let _: ProofReference? = try await API.action("v0Proof:upload", [
                "token": token, "betId": betID, "contentType": prepared.contentType,
                "bytes": prepared.bytes, "requestId": UUID().uuidString,
            ])
            await load()
            error = nil
        } catch { self.error = error.localizedDescription; model.handle(error) }
    }
}

private enum ProofPreparation {
    struct Prepared { let bytes: Data; let contentType: String }

    static func prepare(_ url: URL) throws -> Prepared {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let properties = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        guard let size = properties.fileSize, size > 0, size <= 12 * 1024 * 1024 else {
            throw APIError(code: "INVALID_INPUT")
        }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let bytes = try handle.read(upToCount: 12 * 1024 * 1024 + 1) ?? Data()
        guard bytes.count <= 12 * 1024 * 1024 else { throw APIError(code: "INVALID_INPUT") }
        if properties.contentType?.conforms(to: .image) == true {
            guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1024,
                  ] as CFDictionary) else { throw APIError(code: "INVALID_INPUT") }
            for quality in [0.8, 0.6, 0.4] {
                let output = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
                    throw APIError(code: "INVALID_INPUT")
                }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                if CGImageDestinationFinalize(destination), output.length <= 512 * 1024 {
                    return Prepared(bytes: output as Data, contentType: "image/jpeg")
                }
            }
        } else if properties.contentType?.conforms(to: .mpeg4Audio) == true, bytes.count <= 512 * 1024 {
            return Prepared(bytes: bytes, contentType: "audio/mp4")
        }
        throw APIError(code: "INVALID_INPUT")
    }
}
