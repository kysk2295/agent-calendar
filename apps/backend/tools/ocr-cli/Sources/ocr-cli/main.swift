import AppKit
import Foundation
import Vision

struct TextBlock: Codable {
    let text: String
    let confidence: Float
    let boundingBox: CGRect
}

struct OcrResult: Codable {
    let ok: Bool
    let engine: String
    let blocks: [TextBlock]
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: ocr-cli <image-path>\n".utf8))
    exit(2)
}

let imageUrl = URL(fileURLWithPath: arguments[1])
guard let image = NSImage(contentsOf: imageUrl), let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("failed to read image\n".utf8))
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

let blocks = (request.results ?? []).compactMap { observation -> TextBlock? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    return TextBlock(
        text: candidate.string,
        confidence: candidate.confidence,
        boundingBox: observation.boundingBox
    )
}

let output = OcrResult(ok: true, engine: "apple-vision", blocks: blocks)
let data = try JSONEncoder().encode(output)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
