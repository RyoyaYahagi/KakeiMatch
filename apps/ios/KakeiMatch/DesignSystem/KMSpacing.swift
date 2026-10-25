import CoreGraphics

/// CSS px → pt is 1:1. --space-1 → space1, etc.
enum KMSpacing {
    static let space1: CGFloat = 4
    static let space2: CGFloat = 8
    static let space3: CGFloat = 12
    static let space4: CGFloat = 16
    static let space5: CGFloat = 20
    static let space6: CGFloat = 24
    static let space8: CGFloat = 32
}

/// Component measurements in style.css (not new global spacing steps).
enum KMLayout {
    static let contentMax: CGFloat = 640
    static let navHeight: CGFloat = 64 // --nav-height, plus OS bottom safe area
    static let minimumHit: CGFloat = 44
    static let navIcon: CGFloat = 24
    static let addSize: CGFloat = 56
    static let recordHeight: CGFloat = 60 // .record-row, not DESIGN's older 56
    static let recordIcon: CGFloat = 36
    static let entryHeight: CGFloat = 52
    static let entryKeyWidth: CGFloat = 72
}
