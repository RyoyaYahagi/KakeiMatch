import CoreGraphics
import Foundation
import ImageIO
import Vision

public enum KMVisionRedactor {
    static let maxUploadBytes = 6 * 1024 * 1024
    static let maxReceiptInputBytes = 20 * 1024 * 1024
    private static let maxReceiptPixelDimension = 20_000
    private static let maxReceiptPixelCount: Int64 = 100_000_000
    private static let receiptJPEGQuality: CGFloat = 0.9
    private static let maxResizeAttempts = 12

    public struct Failure: Error {
        public let preview: Data?
    }

    public struct Result: Sendable {
        public let data: Data
        public let masks: [CGRect]
        public let finalText: [String]
    }

    struct Detection {
        let regions: [CGRect]
        let lines: [CGRect]
        let text: [String]
        let readable: Bool
    }

    public static func redact(_ data: Data) async throws -> Result {
        let bytes = Array(data.prefix(12))
        let contentType: String
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { contentType = "image/jpeg" }
        else if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { contentType = "image/png" }
        else { contentType = "image/webp" }
        let prepared = try prepareJPEG(data: data, contentType: contentType)
        return try await redactPreparedJPEG(prepared)
    }

    static func redactPreparedJPEG(_ data: Data) async throws -> Result {
        try await redact(data, detect: detect)
    }

    static func redact(
        _ data: Data,
        detect: (CGImage) async throws -> Detection
    ) async throws -> Result {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
              let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
              (1...maxReceiptPixelDimension).contains(width), (1...maxReceiptPixelDimension).contains(height),
              Int64(width) * Int64(height) <= maxReceiptPixelCount,
              let original = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(width, height),
              ] as CFDictionary) else { throw Failure(preview: nil) }

        var preview: Data?
        do {
            try Task.checkCancellation()
            let initial = try await detect(original)
            var masks = initial.regions
            for attempt in 0...1 {
                let appliedMasks = try masks.map { try padded($0, for: original) }
                let output = try render(original, masks: appliedMasks)
                preview = output
                guard let encoded = CGImageSourceCreateWithData(output as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(encoded, 0, nil) else {
                    throw Failure(preview: preview)
                }
                let verification = try await detect(image)
                if initial.readable, verification.readable, verification.regions.isEmpty {
                    guard output.count <= maxUploadBytes else { throw Failure(preview: preview) }
                    return Result(data: output, masks: appliedMasks, finalText: verification.text)
                }
                guard attempt == 0, !verification.regions.isEmpty else { break }
                masks = initial.lines + verification.lines
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw Failure(preview: preview ?? (try? render(original, masks: [CGRect(x: 0, y: 0, width: 1, height: 1)])))
        }
        throw Failure(preview: preview)
    }

    private static func detect(_ image: CGImage) async throws -> Detection {
        var textRequest = RecognizeTextRequest()
        textRequest.recognitionLevel = .accurate
        textRequest.recognitionLanguages = [Locale.Language(identifier: "ja-JP"), Locale.Language(identifier: "en-US")]
        textRequest.usesLanguageCorrection = false
        let observations = try await textRequest.perform(on: image)
        let barcodes = try await DetectBarcodesRequest().perform(on: image)
        var regions = barcodes.map { $0.boundingBox.cgRect }
        var lines = regions
        var text: [String] = []
        var precedingLabel = false
        for observation in observations.sorted(by: { $0.boundingBox.cgRect.midY > $1.boundingBox.cgRect.midY }) {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let line = observation.boundingBox.cgRect
            let ranges = KMRedactionRules.ranges(in: candidate.string, confidence: candidate.confidence, afterLabel: precedingLabel)
            precedingLabel = KMRedactionRules.expectsValue(candidate.string)
            text.append(candidate.string)
            guard !ranges.isEmpty else { continue }
            lines.append(line)
            for range in ranges {
                regions.append(candidate.boundingBox(for: range)?.boundingBox.cgRect ?? line)
            }
        }
        return Detection(regions: regions, lines: lines, text: text,
                         readable: text.joined().filter { $0.isLetter || $0.isNumber }.count >= 16)
    }

    private static func padded(_ mask: CGRect, for image: CGImage) throws -> CGRect {
        guard !mask.isEmpty, !mask.isNull, !mask.isInfinite else { throw Failure(preview: nil) }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let rect = CGRect(x: mask.minX * width, y: mask.minY * height,
                          width: mask.width * width, height: mask.height * height)
            .insetBy(dx: -6, dy: -6).integral
            .intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !rect.isEmpty, !rect.isNull else { throw Failure(preview: nil) }
        return CGRect(x: rect.minX / width, y: rect.minY / height,
                      width: rect.width / width, height: rect.height / height)
    }

    private static func render(_ image: CGImage, masks: [CGRect]) throws -> Data {
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        guard let context = CGContext(data: nil, width: image.width, height: image.height,
                                      bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw Failure(preview: nil)
        }
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(bounds)
        context.draw(image, in: bounds)
        context.setFillColor(gray: 0, alpha: 1)
        for mask in masks {
            guard !mask.isEmpty, !mask.isNull, !mask.isInfinite else { throw Failure(preview: nil) }
            let pixels = CGRect(x: mask.minX * width, y: mask.minY * height,
                                width: mask.width * width, height: mask.height * height)
            context.fill(pixels.integral.intersection(bounds))
        }
        let data = NSMutableData()
        guard let raster = context.makeImage(),
              let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
            throw Failure(preview: nil)
        }
        CGImageDestinationAddImage(destination, raster, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure(preview: nil) }
        return try stripJPEGMetadata(data as Data)
    }

    /// Redraws receipt JPEG/PNG/WebP into an upright JPEG raster without metadata, downscaling only if > maxBytes.
    static func prepareJPEG(data: Data, contentType: String, maxBytes: Int = maxUploadBytes) throws -> Data {
        guard maxBytes > 0, maxBytes <= Self.maxUploadBytes,
              !data.isEmpty, data.count <= Self.maxReceiptInputBytes,
              Self.matches(data, contentType: contentType) else {
            throw Failure(preview: nil)
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let rawWidth = (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.intValue,
              let rawHeight = (properties[kCGImagePropertyPixelHeight as String] as? NSNumber)?.intValue,
              (1...Self.maxReceiptPixelDimension).contains(rawWidth),
              (1...Self.maxReceiptPixelDimension).contains(rawHeight),
              Int64(rawWidth) * Int64(rawHeight) <= Self.maxReceiptPixelCount else {
            throw Failure(preview: nil)
        }
        guard let upright = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(rawWidth, rawHeight),
            kCGImageSourceShouldCacheImmediately: true
        ] as CFDictionary),
              upright.width > 0, upright.height > 0 else {
            throw Failure(preview: nil)
        }

        var width = upright.width
        var height = upright.height
        var output = try Self.encodeCleanJPEG(upright, width: width, height: height, quality: Self.receiptJPEGQuality)

        for _ in 0..<Self.maxResizeAttempts where output.count > maxBytes && (width > 1 || height > 1) {
            let ratio = sqrt(Double(maxBytes) / Double(output.count)) * 0.9
            let scale = min(0.85, max(0.5, ratio))
            var nextWidth = max(1, Int((Double(width) * scale).rounded(.down)))
            var nextHeight = max(1, Int((Double(height) * scale).rounded(.down)))
            if nextWidth == width && width > 1 { nextWidth = width - 1 }
            if nextHeight == height && height > 1 { nextHeight = height - 1 }
            width = nextWidth
            height = nextHeight
            output = try Self.encodeCleanJPEG(upright, width: width, height: height, quality: Self.receiptJPEGQuality)
        }

        guard output.count <= maxBytes else {
            throw Failure(preview: nil)
        }
        return output
    }

    private static func encodeCleanJPEG(_ image: CGImage, width: Int, height: Int, quality: CGFloat) throws -> Data {
        try autoreleasepool {
            let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
            guard let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else {
                throw Failure(preview: nil)
            }
            context.interpolationQuality = .high
            let bounds = CGRect(x: 0, y: 0, width: width, height: height)
            context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            context.fill(bounds)
            context.draw(image, in: bounds)
            guard let flattened = context.makeImage() else {
                throw Failure(preview: nil)
            }
            let destinationData = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                destinationData,
                "public.jpeg" as CFString,
                1,
                nil
            ) else {
                throw Failure(preview: nil)
            }
            let options: [CFString: Any] = [
                kCGImageDestinationLossyCompressionQuality: quality
            ]
            CGImageDestinationAddImage(destination, flattened, options as CFDictionary)
            guard CGImageDestinationFinalize(destination) else {
                throw Failure(preview: nil)
            }
            return try stripJPEGMetadata(destinationData as Data)
        }
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

    /// Removes APP1 (EXIF/XMP), APP3-13, APP15, and COM segments (including ImageIO's minimal sRGB APP1) before SOS.
    private static func stripJPEGMetadata(_ data: Data) throws -> Data {
        try data.withUnsafeBytes { rawBuffer in
            let bytes = rawBuffer.bindMemory(to: UInt8.self)
            guard bytes.count >= 4, bytes[0] == 0xff, bytes[1] == 0xd8 else {
                throw Failure(preview: nil)
            }
            var output = Data()
            output.reserveCapacity(bytes.count)
            output.append(contentsOf: [0xff, 0xd8])

            var index = 2
            var sawStartOfScan = false
            while index < bytes.count {
                guard bytes[index] == 0xff else { throw Failure(preview: nil) }
                while index < bytes.count, bytes[index] == 0xff { index += 1 }
                guard index < bytes.count else { throw Failure(preview: nil) }
                let marker = bytes[index]
                index += 1

                if marker == 0x00 { throw Failure(preview: nil) }
                if marker == 0xd9 {
                    output.append(contentsOf: [0xff, 0xd9])
                    break
                }
                if marker == 0xda {
                    sawStartOfScan = true
                    output.append(contentsOf: [0xff, 0xda])
                    if let base = bytes.baseAddress, index < bytes.count {
                        output.append(base.advanced(by: index), count: bytes.count - index)
                    }
                    break
                }
                if (0xd0...0xd7).contains(marker) || marker == 0x01 || marker == 0xd8 {
                    output.append(contentsOf: [0xff, marker])
                    continue
                }

                guard index + 2 <= bytes.count else { throw Failure(preview: nil) }
                let length = (Int(bytes[index]) << 8) | Int(bytes[index + 1])
                guard length >= 2, index + length <= bytes.count else { throw Failure(preview: nil) }

                let isMetadata = marker == 0xe1 || (0xe3...0xed).contains(marker) || marker == 0xef || marker == 0xfe
                if !isMetadata, let base = bytes.baseAddress {
                    output.append(contentsOf: [0xff, marker])
                    output.append(base.advanced(by: index), count: length)
                }
                index += length
            }

            guard sawStartOfScan else { throw Failure(preview: nil) }
            return output
        }
    }

}
