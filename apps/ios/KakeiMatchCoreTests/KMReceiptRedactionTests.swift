import CoreGraphics
import CoreImage
import CoreText
import Foundation
import ImageIO
import Testing
@testable import KakeiMatchCore

struct KMReceiptRedactionTests {
    @Test(arguments: [false, true])
    func syntheticCoverage(degraded: Bool) async throws {
        let fixture = try Self.receipt(degraded: degraded)
        let result = try await KMVisionRedactor.redact(fixture.data)
        let source = try #require(CGImageSourceCreateWithData(result.data as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        for region in fixture.sensitive {
            let coverage = try Self.darkFraction(image, region: region)
            #expect(coverage >= 0.95)
        }
        for region in fixture.retained {
            let normalized = CGRect(x: region.minX / 900, y: region.minY / 990,
                                    width: region.width / 900, height: region.height / 990)
            #expect(result.masks.allSatisfy { $0.intersection(normalized).isEmpty })
            #expect(try Self.darkFraction(image, region: region) < 0.75)
        }
    }

    @Test
    func rulesCoverSensitiveValuesAndPreserveFields() {
        for text in ["4111 1111 1111 1111", "03-1234-5678", "receipt@example.com", "会員番号：１２３４",
                     "承認番号 096532", "田中 太郎 様", "123-4567", "https://example.com", "******1234",
                     "VISA 1234", "12345678"] {
            #expect(!KMRedactionRules.ranges(in: text, confidence: 1, afterLabel: false).isEmpty)
        }
        for text in ["2026/11/24", "2026年11月24日", "12:34:59", "¥10000000", "12,345,678円", "2個"] {
            #expect(KMRedactionRules.ranges(in: text, confidence: 0.5, afterLabel: false).isEmpty)
        }
        #expect(KMRedactionRules.expectsValue("会員番号："))
        #expect(!KMRedactionRules.ranges(in: "A041", confidence: 1, afterLabel: true).isEmpty)
        #expect(!KMRedactionRules.ranges(in: "4321", confidence: 0.5, afterLabel: false).isEmpty)
        let branded = "VISA 1234"
        let brandMasks = KMRedactionRules.ranges(in: branded, confidence: 1, afterLabel: false)
        #expect(brandMasks.map { String(branded[$0]) } == [" 1234"])
    }

    @Test
    func detectionFailureCannotReturnSendableResult() async throws {
        let data = try Self.receipt(degraded: false).data
        let detectorFailure: (CGImage) async throws -> KMVisionRedactor.Detection = { _ in
            throw CocoaError(.fileReadCorruptFile)
        }
        await #expect(throws: KMVisionRedactor.Failure.self) {
            _ = try await KMVisionRedactor.redact(data, detect: detectorFailure)
        }
        await #expect(throws: KMVisionRedactor.Failure.self) {
            _ = try await KMVisionRedactor.redact(Data())
        }
    }

    @Test
    func residualSensitiveRegionsStopAfterOneRetry() async throws {
        let data = try Self.receipt(degraded: false).data
        let region = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.1)
        var calls = 0
        do {
            _ = try await KMVisionRedactor.redact(data) { _ in
                calls += 1
                return .init(regions: [region], lines: [region], text: [], readable: true)
            }
            Issue.record("Verification returned uploadable data with a residual region")
        } catch let failure as KMVisionRedactor.Failure {
            #expect(failure.preview != nil)
        }
        #expect(calls == 3)
    }

    @Test
    func tooLittleTextStopsWithPreview() async throws {
        let data = try Self.receipt(degraded: false).data
        do {
            _ = try await KMVisionRedactor.redact(data) { _ in
                .init(regions: [], lines: [], text: [], readable: false)
            }
            Issue.record("Verification accepted unreadable text")
        } catch let failure as KMVisionRedactor.Failure {
            #expect(failure.preview != nil)
        }
    }

    private static func receipt(degraded: Bool) throws -> (data: Data, sensitive: [CGRect], retained: [CGRect]) {
        let bounds = CGRect(x: 0, y: 0, width: 900, height: 990)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try #require(CGContext(data: nil, width: 900, height: 990, bitsPerComponent: 8,
            bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(gray: degraded ? 0.85 : 1, alpha: 1)
        context.fill(bounds)
        let foreground = CGColor(gray: degraded ? 0.22 : 0, alpha: 1)
        let font = CTFontCreateWithName("Helvetica" as CFString, 46, nil)
        var sensitive: [CGRect] = []
        var retained: [CGRect] = []
        let rows = ["Synthetic Market", "2026/11/24", "Apples 2", "TOTAL 1200", "4111 1111 1111 1111",
                    "03-1234-5678", "receipt@example.com", "Member ID: A12345"]
        for (index, text) in rows.enumerated() {
            let position = CGPoint(x: 50, y: CGFloat(900 - index * 78))
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): foreground,
            ]))
            context.textPosition = .zero
            let box = CTLineGetImageBounds(line, context).offsetBy(dx: position.x, dy: position.y).integral
            context.textPosition = position
            CTLineDraw(line, context)
            if index < 4 { retained.append(box) }
            else { sensitive.append(box) }
        }

        let ci = CIContext(options: [.useSoftwareRenderer: true])
        for (index, generator) in ["CIQRCodeGenerator", "CICode128BarcodeGenerator"].enumerated() {
            let filter = try #require(CIFilter(name: generator))
            filter.setValue(Data("SYNTHETIC-012345".utf8), forKey: "inputMessage")
            if index == 1 { filter.setValue(0, forKey: "inputQuietSpace") }
            let barcode = try #require(filter.outputImage)
            let pixels = try #require(ci.createCGImage(barcode, from: barcode.extent))
            let rect = index == 0 ? CGRect(x: 50, y: 55, width: 175, height: 175)
                : CGRect(x: 310, y: 80, width: 480, height: 100)
            context.interpolationQuality = .none
            context.draw(pixels, in: rect)
            if index == 0 {
                // Core Image includes a one-module quiet zone in the QR raster.
                sensitive.append(rect.insetBy(dx: ceil(rect.width / CGFloat(pixels.width)),
                                             dy: ceil(rect.height / CGFloat(pixels.height))))
            } else {
                sensitive.append(rect.insetBy(dx: 5, dy: 5))
            }
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try #require(context.makeImage()),
            [kCGImageDestinationLossyCompressionQuality: degraded ? 0.4 : 0.95] as CFDictionary)
        try #require(CGImageDestinationFinalize(destination))
        return (data as Data, sensitive, retained)
    }

    private static func darkFraction(_ image: CGImage, region: CGRect) throws -> Double {
        let slice = try #require(image.cropping(to: CGRect(x: region.minX, y: CGFloat(image.height) - region.maxY,
                                                         width: region.width, height: region.height)))
        let count = slice.width * slice.height
        var pixels = [UInt8](repeating: 0, count: count)
        try pixels.withUnsafeMutableBytes { buffer in
            let context = try #require(CGContext(data: buffer.baseAddress, width: slice.width, height: slice.height,
                bitsPerComponent: 8, bytesPerRow: slice.width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue))
            context.draw(slice, in: CGRect(x: 0, y: 0, width: slice.width, height: slice.height))
        }
        return Double(pixels.filter { $0 < 24 }.count) / Double(count)
    }
}
