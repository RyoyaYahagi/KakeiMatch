import Foundation
import ImageIO
import UIKit

/// Receipt parity: original JPEG/PNG/WebP bytes, no automatic resize or masking.
struct KMUploadImage: Sendable {
    let data: Data
    let contentType: String

    init(data: Data, contentType: String) throws {
        guard !data.isEmpty, data.count <= 6 * 1024 * 1024,
              Self.matches(data, contentType: contentType) else { throw KMAPIError.invalidRequest }
        self.data = data; self.contentType = contentType
    }

    static func matches(_ data: Data, contentType: String) -> Bool {
        let bytes = Array(data.prefix(12))
        switch contentType {
        case "image/jpeg": return bytes.starts(with: [0xff, 0xd8, 0xff])
        case "image/png": return bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        case "image/webp": return bytes.count >= 12 && String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF" && String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP"
        default: return false
        }
    }
}

/// Cannot construct from an unmasked upload; use prepare after explicit confirmation.
struct KMMaskedPayrollImage: Sendable {
    let upload: KMUploadImage
    private init(upload: KMUploadImage) { self.upload = upload }

    /// Same normalized two-corner rectangles as financial-image.ts. No OCR/redaction guesswork.
    @MainActor
    static func prepare(data: Data, contentType: String, masks: [CGRect], maskingConfirmed: Bool) throws -> Self {
        let normalizedMasks = masks.map(\.standardized)
        guard maskingConfirmed, !data.isEmpty, data.count <= 20 * 1024 * 1024,
              KMUploadImage.matches(data, contentType: contentType), masks.count <= 100,
              masks.allSatisfy({ $0.origin.x.isFinite && $0.origin.y.isFinite && $0.width.isFinite && $0.height.isFinite &&
                  $0.minX >= 0 && $0.minY >= 0 && $0.maxX <= 1 && $0.maxY <= 1 }) else { throw KMAPIError.invalidRequest }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1800,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { throw KMAPIError.invalidRequest }
        let size = CGSize(width: image.width, height: image.height)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let output = renderer.jpegData(withCompressionQuality: 0.9) { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
            UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
            UIColor.black.setFill()
            for rect in normalizedMasks {
                context.fill(CGRect(x: rect.minX * size.width, y: rect.minY * size.height,
                                    width: max(0.005, rect.width) * size.width, height: max(0.005, rect.height) * size.height))
            }
        }
        // New JPEG raster has no original EXIF/GPS metadata.
        return try Self(upload: KMUploadImage(data: output, contentType: "image/jpeg"))
    }
}

struct KMUploadAudio: Sendable {
    let data: Data
    let contentType: String
    init(data: Data, contentType: String) throws {
        guard !data.isEmpty, data.count <= 2 * 1024 * 1024 else { throw KMAPIError.invalidRequest }
        let b = Array(data.prefix(12))
        let valid: Bool
        switch contentType {
        case "audio/mp4": valid = b.count >= 8 && String(bytes: b[4..<8], encoding: .ascii) == "ftyp"
        case "audio/webm": valid = b.starts(with: [0x1a, 0x45, 0xdf, 0xa3])
        case "audio/ogg": valid = b.starts(with: Array("OggS".utf8))
        case "audio/wav": valid = b.count >= 12 && b.starts(with: Array("RIFF".utf8)) && String(bytes: b[8..<12], encoding: .ascii) == "WAVE"
        case "audio/mpeg": valid = b.starts(with: Array("ID3".utf8)) || (b.count >= 2 && b[0] == 0xff && b[1] & 0xe0 == 0xe0)
        default: valid = false
        }
        guard valid else { throw KMAPIError.invalidRequest }
        self.data = data; self.contentType = contentType
    }
}
