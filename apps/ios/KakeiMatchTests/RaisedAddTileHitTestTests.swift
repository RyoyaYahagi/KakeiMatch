import SwiftUI
import Testing
import UIKit
@testable import KakeiMatch

struct RaisedAddTileHitTestTests {
    @Test @MainActor func hitTestViewMatchesRenderedContinuousRoundedRectangleBoundary() {
        let bounds = CGRect(x: 0, y: 0, width: KMLayout.addSize, height: KMLayout.addSize)
        let view = KMAddTileHitTestView(frame: bounds)
        let renderedPath = RoundedRectangle(cornerRadius: KMRadius.xl, style: .continuous).path(in: bounds)

        var low: CGFloat = 0
        var high = KMLayout.addSize / 2
        for _ in 0..<24 {
            let mid = (low + high) / 2
            if renderedPath.contains(CGPoint(x: mid, y: mid)) {
                high = mid
            } else {
                low = mid
            }
        }
        let diagonalEdge = high
        #expect(diagonalEdge > 2 && diagonalEdge < KMRadius.xl)

        let margin: CGFloat = 0.5
        let cornerCases: [(CGPoint, CGPoint)] = [
            (CGPoint(x: diagonalEdge + margin, y: diagonalEdge + margin),
             CGPoint(x: diagonalEdge - margin, y: diagonalEdge - margin)),
            (CGPoint(x: bounds.width - (diagonalEdge + margin), y: diagonalEdge + margin),
             CGPoint(x: bounds.width - (diagonalEdge - margin), y: diagonalEdge - margin)),
            (CGPoint(x: diagonalEdge + margin, y: bounds.height - (diagonalEdge + margin)),
             CGPoint(x: diagonalEdge - margin, y: bounds.height - (diagonalEdge - margin))),
            (CGPoint(x: bounds.width - (diagonalEdge + margin), y: bounds.height - (diagonalEdge + margin)),
             CGPoint(x: bounds.width - (diagonalEdge - margin), y: bounds.height - (diagonalEdge - margin))),
        ]

        for (inside, outside) in cornerCases {
            #expect(renderedPath.contains(inside))
            #expect(view.point(inside: inside, with: nil))
            #expect(view.hitTest(inside, with: nil) === view)

            #expect(!renderedPath.contains(outside))
            #expect(!view.point(inside: outside, with: nil))
            #expect(view.hitTest(outside, with: nil) == nil)
        }

        // Sample vertical boundary crossings across the continuous corner curve where a
        // circular arc diverges from SwiftUI's .continuous profile.
        for x in [CGFloat(2), 6, 10, 14, 18, 22] {
            var yLow: CGFloat = 0
            var yHigh = KMLayout.addSize / 2
            for _ in 0..<24 {
                let yMid = (yLow + yHigh) / 2
                if renderedPath.contains(CGPoint(x: x, y: yMid)) {
                    yHigh = yMid
                } else {
                    yLow = yMid
                }
            }
            let topInside = CGPoint(x: x, y: yHigh + margin)
            let topOutside = CGPoint(x: x, y: yHigh - margin)
            let bottomInside = CGPoint(x: bounds.width - x, y: bounds.height - (yHigh + margin))
            let bottomOutside = CGPoint(x: bounds.width - x, y: bounds.height - (yHigh - margin))

            for point in [topInside, bottomInside] {
                #expect(renderedPath.contains(point))
                #expect(view.point(inside: point, with: nil))
            }
            for point in [topOutside, bottomOutside] {
                #expect(!renderedPath.contains(point))
                #expect(!view.point(inside: point, with: nil))
            }
        }

        let emptyView = KMAddTileHitTestView(frame: .zero)
        #expect(!emptyView.point(inside: .zero, with: nil))
    }
}
