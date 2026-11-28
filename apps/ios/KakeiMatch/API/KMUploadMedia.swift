import CoreGraphics
import Foundation
import ImageIO
import UIKit

/// Receipt upload image: re-encoded to upright JPEG without EXIF/GPS metadata before upload.
struct KMUploadImage: Sendable {
    static let maxUploadBytes = KMVisionRedactor.maxUploadBytes
    static let maxReceiptInputBytes = KMVisionRedactor.maxReceiptInputBytes

    let data: Data
    let contentType: String

    init(data: Data, contentType: String) throws {
        guard !data.isEmpty, data.count <= Self.maxUploadBytes,
              Self.matches(data, contentType: contentType) else { throw KMAPIError.invalidRequest }
        self.data = data; self.contentType = contentType
    }

    static func prepareReceipt(data: Data, contentType: String, maxBytes: Int = maxUploadBytes) throws -> Self {
        do {
            let clean = try KMVisionRedactor.prepareJPEG(data: data, contentType: contentType, maxBytes: maxBytes)
            return try Self(data: clean, contentType: "image/jpeg")
        } catch {
            throw KMAPIError.invalidRequest
        }
    }

    static func matches(_ data: Data, contentType: String) -> Bool {
        KMVisionRedactor.matches(data, contentType: contentType)
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

struct KMRedactedReceiptImage: Sendable {
    let upload: KMUploadImage

    private init(upload: KMUploadImage) { self.upload = upload }

    static func prepare(data: Data, contentType: String) async throws -> Self {
        let clean = try KMUploadImage.prepareReceipt(data: data, contentType: contentType)
        let result = try await KMVisionRedactor.redactPreparedJPEG(clean.data)
        return try Self(upload: KMUploadImage(data: result.data, contentType: "image/jpeg"))
    }
}
