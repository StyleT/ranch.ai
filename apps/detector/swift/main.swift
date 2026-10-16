// Core ML detector runner. Native process so the Neural Engine is reachable (it is not from a container).
// Loads one model, then reads JSON lines {"id":..., "path":...} on stdin and writes one JSON line per image:
// {"id","path","ms","detections":[{"label","confidence","x","y","w","h"}]} with boxes normalized to the
// image, origin top-left. A .mlpackage is compiled on first use with the Core ML framework's own compiler
// (no Xcode needed) and cached next to the model as <name>.mlmodelc.
//
// Build on the mini:  swiftc -O -o detector main.swift      (Swift 6.4 from the Command Line Tools)
// Run:                ./detector --model yolo11n.mlpackage --compute ane [--threshold 0.25]
import Foundation
import CoreML
import Vision
import ImageIO

struct Args { var model = ""; var compute = "all"; var threshold: Float = 0.25; var warmup = 3; var labels = ""; var topk = 300 }
func parseArgs() -> Args {
    var a = Args(); var it = CommandLine.arguments.dropFirst().makeIterator()
    while let k = it.next() {
        switch k {
        case "--model": a.model = it.next() ?? ""
        case "--compute": a.compute = it.next() ?? "all"
        case "--threshold": a.threshold = Float(it.next() ?? "0.25") ?? 0.25
        case "--warmup": a.warmup = Int(it.next() ?? "3") ?? 3
        case "--labels": a.labels = it.next() ?? ""
        case "--topk": a.topk = Int(it.next() ?? "300") ?? 300
        default: FileHandle.standardError.write("unknown arg \(k)\n".data(using: .utf8)!); exit(2)
        }
    }
    if a.model.isEmpty { FileHandle.standardError.write("usage: detector --model <.mlpackage|.mlmodelc> [--compute all|ane|gpu|cpu] [--threshold 0.25] [--labels classes.json]\n".data(using: .utf8)!); exit(2) }
    return a
}

func computeUnits(_ s: String) -> MLComputeUnits {
    switch s { case "ane": return .cpuAndNeuralEngine; case "gpu": return .cpuAndGPU; case "cpu": return .cpuOnly; default: return .all }
}

func compiledURL(for model: URL) throws -> URL {
    if model.pathExtension == "mlmodelc" { return model }
    let cached = model.deletingPathExtension().appendingPathExtension("mlmodelc")
    let fm = FileManager.default
    if fm.fileExists(atPath: cached.path) {
        let srcDate = (try? fm.attributesOfItem(atPath: model.path)[.modificationDate] as? Date) ?? .distantPast
        let dstDate = (try? fm.attributesOfItem(atPath: cached.path)[.modificationDate] as? Date) ?? .distantPast
        if dstDate >= srcDate { return cached }
        try fm.removeItem(at: cached)
    }
    let t0 = Date()
    let tmp = try MLModel.compileModel(at: model)
    try fm.moveItem(at: tmp, to: cached)
    emit(["compiled": cached.lastPathComponent, "ms": Int(Date().timeIntervalSince(t0) * 1000)])
    return cached
}

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func rssMB() -> Int {
    var info = mach_task_basic_info(); var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
    let kr = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: 1) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) } }
    return kr == KERN_SUCCESS ? Int(info.resident_size / 1048576) : -1
}

extension MLMultiArray {
    /// Copy another array's values into this (float32) array, element by element.
    func filled(from src: MLMultiArray) throws -> MLMultiArray {
        let n = self.count
        for i in 0..<n { self[i] = NSNumber(value: src[i].floatValue) }
        return self
    }
}

let args = parseArgs()
let modelURL = URL(fileURLWithPath: args.model)
let cfg = MLModelConfiguration(); cfg.computeUnits = computeUnits(args.compute)
let mlModel: MLModel
do { mlModel = try MLModel(contentsOf: try compiledURL(for: modelURL), configuration: cfg) }
catch { emit(["error": "load failed: \(error)"]); exit(1) }
let vnModel: VNCoreMLModel
do { vnModel = try VNCoreMLModel(for: mlModel) } catch { emit(["error": "VNCoreMLModel: \(error)"]); exit(1) }

struct Det { let label: String; let conf: Float; let x: Float; let y: Float; let w: Float; let h: Float }

// Class-id → name table for models that return raw logits (RF-DETR). JSON array; index = class id.
let classNames: [String] = {
    guard !args.labels.isEmpty, let d = FileManager.default.contents(atPath: args.labels),
          let arr = try? JSONSerialization.jsonObject(with: d) as? [String] else { return [] }
    return arr
}()
@inline(__always) func sigmoid(_ v: Float) -> Float { 1 / (1 + exp(-v)) }

// RF-DETR style decode: boxes (Q,4) as normalized cx,cy,w,h and logits (Q,C) with independent per-class
// sigmoids. Mirrors rfdetr's PostProcess: flatten (Q,C), take the top-k pairs, then threshold.
func decodeDETR(boxes: MLMultiArray, logits: MLMultiArray) -> [Det] {
    let q = logits.shape[logits.shape.count - 2].intValue, c = logits.shape[logits.shape.count - 1].intValue
    let lp = UnsafeMutablePointer<Float>(OpaquePointer(logits.dataPointer)), bp = UnsafeMutablePointer<Float>(OpaquePointer(boxes.dataPointer))
    var pairs: [(Float, Int, Int)] = []
    pairs.reserveCapacity(q * 2)
    for i in 0..<q { for j in 0..<c { let s = sigmoid(lp[i * c + j]); if s >= args.threshold { pairs.append((s, i, j)) } } }
    pairs.sort { $0.0 > $1.0 }
    return pairs.prefix(args.topk).map { (s, i, j) in
        let cx = bp[i * 4], cy = bp[i * 4 + 1], w = bp[i * 4 + 2], h = bp[i * 4 + 3]
        let name = j < classNames.count ? classNames[j] : "class_\(j)"
        return Det(label: name, conf: s, x: cx - w / 2, y: cy - h / 2, w: w, h: h)
    }
}

func detect(path: String) throws -> [Det] {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw NSError(domain: "detector", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot decode \(path)"])
    }
    let req = VNCoreMLRequest(model: vnModel)
    req.imageCropAndScaleOption = .scaleFill
    try VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:]).perform([req])
    var out: [Det] = []
    var arrays: [MLMultiArray] = []
    for r in req.results ?? [] {
        if let o = r as? VNRecognizedObjectObservation, let top = o.labels.first, top.confidence >= args.threshold {
            // Vision boxes are normalized with origin bottom-left; flip to top-left.
            let b = o.boundingBox
            out.append(Det(label: top.identifier, conf: top.confidence, x: Float(b.minX), y: Float(1 - b.maxY), w: Float(b.width), h: Float(b.height)))
        } else if let f = r as? VNCoreMLFeatureValueObservation, let arr = f.featureValue.multiArrayValue {
            arrays.append(arr)
        }
    }
    if out.isEmpty, arrays.count == 2 {
        // Raw-output model: the array whose last dim is 4 holds boxes, the other holds class logits.
        if let bi = arrays.firstIndex(where: { $0.shape.last?.intValue == 4 }) {
            let boxes = arrays[bi], logits = arrays[1 - bi]
            let b32 = boxes.dataType == .float32 ? boxes : try MLMultiArray(shape: boxes.shape, dataType: .float32).filled(from: boxes)
            let l32 = logits.dataType == .float32 ? logits : try MLMultiArray(shape: logits.shape, dataType: .float32).filled(from: logits)
            out = decodeDETR(boxes: b32, logits: l32)
        }
    }
    return out.sorted { $0.conf > $1.conf }
}

let desc = mlModel.modelDescription
emit(["ready": true, "model": modelURL.lastPathComponent, "compute": args.compute, "threshold": args.threshold,
      "inputs": Array(desc.inputDescriptionsByName.keys), "outputs": Array(desc.outputDescriptionsByName.keys), "rss_mb": rssMB()])

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    var id = "", path = line
    if let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        id = (obj["id"] as? String) ?? ""; path = (obj["path"] as? String) ?? ""
    }
    let t0 = Date()
    do {
        let dets = try detect(path: path)
        let ms = Date().timeIntervalSince(t0) * 1000
        emit(["id": id, "path": path, "ms": (ms * 100).rounded() / 100, "rss_mb": rssMB(),
              "detections": dets.map { ["label": $0.label, "confidence": $0.conf, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] }])
    } catch {
        emit(["id": id, "path": path, "error": "\(error)"])
    }
}
