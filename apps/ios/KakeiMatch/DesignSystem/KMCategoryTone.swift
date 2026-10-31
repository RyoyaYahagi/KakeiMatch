import SwiftUI

/// Colors for the Data-layer tone mapping. Category names/hash live in Data/Aggregation.
extension KMCategoryTone {
    var foreground: Color {
        switch self {
        case .food: KMColor.cFood
        case .daily: KMColor.cDaily
        case .transport: KMColor.cTransport
        case .fun: KMColor.cFun
        case .util: KMColor.cUtil
        case .comm: KMColor.cComm
        case .other: KMColor.cOther
        }
    }
    var background: Color {
        switch self {
        case .food: KMColor.cFoodSoft
        case .daily: KMColor.cDailySoft
        case .transport: KMColor.cTransportSoft
        case .fun: KMColor.cFunSoft
        case .util: KMColor.cUtilSoft
        case .comm: KMColor.cCommSoft
        case .other: KMColor.cOtherSoft
        }
    }
}
