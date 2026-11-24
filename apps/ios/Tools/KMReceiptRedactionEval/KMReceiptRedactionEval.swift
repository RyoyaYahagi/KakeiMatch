import CoreGraphics
import Foundation
import KakeiMatchCore

// GT boxes use normalized coordinates with the origin at the bottom left.
private struct Sample: Decodable {
    struct Field: Decodable {
        let kind: String
        let text: String
    }

    let file: String
    let fields: [Field]
    let sensitive: [CGRect]
}

private struct Score: Encodable {
    var total = 0
    var retained = 0
}

private struct Report: Encodable {
    var samples = 0
    var stopped = 0
    var leaks = 0
    var p95Seconds = 0.0
    var retention: [String: Score] = [:]
    var meetsThresholds = false
}

@main
enum KMReceiptRedactionEval {
    static func main() async {
        do {
            try await run()
        } catch {
            FileHandle.standardError.write(Data("Evaluation failed. Usage: km-receipt-redaction-eval IMAGE_DIRECTORY GT.json\n".utf8))
            exit(2)
        }
    }

    private static func run() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { throw CocoaError(.fileReadInvalidFileName) }
        let directory = URL(fileURLWithPath: arguments[1], isDirectory: true)
        let samples = try JSONDecoder().decode([Sample].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[2])))
        guard !samples.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
        var report = Report()
        var durations: [Double] = []
        let clock = ContinuousClock()
        for sample in samples {
            guard let file = URL(string: sample.file, relativeTo: directory),
                  file.isFileURL, file.standardizedFileURL.path.hasPrefix(directory.standardizedFileURL.path + "/"),
                  sample.sensitive.allSatisfy({ !$0.isEmpty && CGRect(x: 0, y: 0, width: 1, height: 1).contains($0) }) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let data = try Data(contentsOf: file)
            let start = clock.now
            let result: KMVisionRedactor.Result?
            do {
                result = try await KMVisionRedactor.redact(data)
            } catch is KMVisionRedactor.Failure {
                result = nil
                report.stopped += 1
            }
            let elapsed = (clock.now - start).components
            durations.append(Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18)
            report.samples += 1
            if let result {
                report.leaks += sample.sensitive.filter { !covered($0, by: result.masks) }.count
            }
            let output = normalize(result?.finalText.joined(separator: "\n") ?? "")
            for field in sample.fields {
                let expected = normalize(field.text)
                guard !expected.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
                report.retention[field.kind, default: Score()].total += 1
                if output.contains(expected) {
                    report.retention[field.kind, default: Score()].retained += 1
                }
            }
        }
        report.p95Seconds = durations.sorted()[Int(ceil(Double(durations.count) * 0.95)) - 1]
        let thresholds = ["total": 99, "date": 98, "merchant": 97, "item": 95]
        report.meetsThresholds = report.leaks == 0 && report.p95Seconds <= 3 && thresholds.allSatisfy { kind, threshold in
            guard let score = report.retention[kind], score.total > 0 else { return false }
            return score.retained * 100 >= threshold * score.total
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        FileHandle.standardOutput.write(try encoder.encode(report) + Data([10]))
        if !report.meetsThresholds { exit(1) }
    }

    private static func normalize(_ text: String) -> String {
        text.folding(options: [.widthInsensitive, .caseInsensitive], locale: nil)
            .filter { !$0.isWhitespace }
    }

    private static func covered(_ target: CGRect, by masks: [CGRect]) -> Bool {
        let intersections = masks.map { $0.intersection(target) }.filter { !$0.isEmpty }
        let edges = ([target.minX, target.maxX] + intersections.flatMap { [$0.minX, $0.maxX] }).sorted()
        for (left, right) in zip(edges, edges.dropFirst()) where left < right {
            var end = target.minY
            for rect in intersections.sorted(by: { $0.minY < $1.minY })
                where rect.minX <= left && rect.maxX >= right && rect.minY <= end {
                end = max(end, rect.maxY)
            }
            if end < target.maxY { return false }
        }
        return true
    }
}
