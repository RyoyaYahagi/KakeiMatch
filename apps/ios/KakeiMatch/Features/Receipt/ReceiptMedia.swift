import SwiftUI
import UIKit

/// Camera is the OS-specific replacement for PWA input[capture=environment].
struct KMReceiptCamera: UIViewControllerRepresentable {
    let completion: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.cameraDevice = .rear
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (Data?) -> Void
        init(completion: @escaping (Data?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            completion((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
        }
    }
}

struct KMReceiptImageViewer: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("タップした所を拡大します。もう一度タップすると戻ります。")
                    .font(KMTypography.note).foregroundStyle(KMColor.muted)
                Button("閉じる") { dismiss() }.frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("receipt.closeImage")
            }.padding(.horizontal, KMSpacing.space4)
            KMReceiptZoomImage(image: image)
        }.background(KMColor.bg).accessibilityElement(children: .contain).accessibilityIdentifier("receipt.imageViewer")
    }
}

private struct KMReceiptZoomImage: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = ReceiptScrollView(); scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 2.5
        let imageView = UIImageView(image: image); imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true; imageView.accessibilityLabel = "保存したレシート（拡大表示）"
        imageView.isUserInteractionEnabled = true; imageView.addGestureRecognizer(UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:))))
        scroll.addSubview(imageView); scroll.imageView = imageView; context.coordinator.imageView = imageView
        return scroll
    }
    func updateUIView(_ scroll: UIScrollView, context: Context) {
        scroll.setNeedsLayout()
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func tap(_ recognizer: UITapGestureRecognizer) {
            guard let imageView, let scroll = imageView.superview as? UIScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: false); scroll.setContentOffset(.zero, animated: false) }
            else {
                let point = recognizer.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: false)
            }
        }
    }
}

/// UIScrollView receives its final bounds after UIViewRepresentable.updateUIView.
private final class ReceiptScrollView: UIScrollView {
    weak var imageView: UIImageView?
    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1, let imageView, let image = imageView.image else { return }
        let size = CGSize(width: bounds.width, height: bounds.width * image.size.height / image.size.width)
        imageView.frame = CGRect(origin: .zero, size: size)
        contentSize = size
    }
}
