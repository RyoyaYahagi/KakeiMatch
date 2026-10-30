import SwiftUI

struct IncomeView: View {
    var onPayroll: () -> Void = {}
    var body: some View { KMEntryFormView(kind: .income, onPayroll: onPayroll) }
}
