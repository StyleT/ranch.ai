// Core ML detector runner. Native process so the Neural Engine is reachable (it is not from a container).
// Loads one model, then reads JSON lines on stdin and writes one JSON line per image or video frame:
//   {"id","path"}            -> {"id","path","ms","detections":[{"label","confidence","x","y","w","h"}]}
//   {"id","video","stride"}  -> one line per processed frame {"id","video","frame_no","pts_s","decode_ms","ms","detections"}
//                               then {"id","video","done":true,"frames","processed","wall_s",...}
// Boxes are normalized to the image, origin top-left. A .mlpackage is compiled on first use with the Core ML
// framework's own compiler (no Xcode needed) and cached next to the model as <name>.mlmodelc.
//
// Decoders, chosen from the model description at load (--decoder overrides):
//   vision  Apple's NMS pipeline (outputs `confidence` + `coordinates`): VNRecognizedObjectObservation, and the
//           RF-DETR raw-output case (two arrays) decoded here. Scaling by Vision: --scale fill (stretch, the default
//           for this decoder) or fit (letterbox; Vision maps the boxes back itself).
//   e2e     YOLO26's NMS-free head: one `detections` output (1, max_det, 6) = x1 y1 x2 y2 score class in pixels of the
//           network input. The frame is letterboxed (--scale fit, the default: the way the model was trained, gray
//           114 pad) or stretched (fill) into the input size read from the model, run through MLModel.prediction, and
//           the rows above --threshold are unmapped by gain and pad. No NMS.
// Video (--video or a stdin line with "video"): AVAssetReader decodes the H.264 through VideoToolbox into BGRA
// buffers; every --stride-th frame goes through the same decoder as a still; decode_ms is the decode time spent
// since the previous processed frame (skipped frames are still decoded), ms the inference.
//
// Build on the mini:  swiftc -O -o detector main.swift      (Swift 6.4 from the Command Line Tools)
// Run:                ./detector --model yolo26s.mlpackage --compute ane [--threshold 0.05] [--scale fit|fill]
//                     ./detector --model yolo26s-e2e-384x640.mlpackage --labels yolo26s-e2e-384x640.labels.json --video clip.mp4 --stride 2
import AVFoundation
import CoreGraphics
import CoreML
import Foundation
import ImageIO
import VideoToolbox
import Vision

struct Args {
    var model = ""; var compute = "all"; var threshold: Float = 0.25; var warmup = 3; var labels = ""; var topk = 300
    var decoder = "auto"; var scale = "auto"; var video = ""; var stride = 1
}
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
        case "--decoder": a.decoder = it.next() ?? "auto"
        case "--scale": a.scale = it.next() ?? "auto"
        case "--video": a.video = it.next() ?? ""
        case "--stride": a.stride = max(1, Int(it.next() ?? "1") ?? 1)
        default: FileHandle.standardError.write("unknown arg \(k)\n".data(using: .utf8)!); exit(2)
        }
    }
    if a.model.isEmpty {
        FileHandle.standardError.write("usage: detector --model <.mlpackage|.mlmodelc> [--compute all|ane|gpu|cpu] [--threshold 0.25] [--labels classes.json] [--decoder auto|vision|e2e] [--scale auto|fit|fill] [--video file.mp4 --stride 1]\n".data(using: .utf8)!)
        exit(2)
    }
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

func pct(_ xs: [Double], _ p: Double) -> Double {
    guard !xs.isEmpty else { return 0 }
    let s = xs.sorted(); return s[min(s.count - 1, Int(Double(s.count) * p))]
}
func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

extension MLMultiArray {
    /// Copy another array's values into this (float32) array, element by element.
    func filled(from src: MLMultiArray) throws -> MLMultiArray {
        let n = self.count
        for i in 0..<n { self[i] = NSNumber(value: src[i].floatValue) }
        return self
    }
}

struct DetectorError: Error, CustomStringConvertible { let description: String }

let args = parseArgs()
let modelURL = URL(fileURLWithPath: args.model).absoluteURL // Core ML's compiler wants an absolute path
let cfg = MLModelConfiguration(); cfg.computeUnits = computeUnits(args.compute)
let mlModel: MLModel
do { mlModel = try MLModel(contentsOf: try compiledURL(for: modelURL), configuration: cfg) }
catch { emit(["error": "load failed: \(error)"]); exit(1) }
let desc = mlModel.modelDescription

// Decoder: the model says which head it carries.
let outputNames = Array(desc.outputDescriptionsByName.keys).sorted()
let isE2E: Bool = {
    if desc.metadata[.creatorDefinedKey].flatMap({ ($0 as? [String: String])?["end2end"] }) == "True" { return true }
    if outputNames.count == 1, let o = desc.outputDescriptionsByName[outputNames[0]], let c = o.multiArrayConstraint, c.shape.last?.intValue == 6 { return true }
    return false
}()
let decoder = args.decoder == "auto" ? (isE2E ? "e2e" : "vision") : args.decoder
let scale = args.scale == "auto" ? (decoder == "e2e" ? "fit" : "fill") : args.scale
// The image input (the NMS pipeline also takes confidenceThreshold and iouThreshold).
let inputName = desc.inputDescriptionsByName.sorted { $0.key < $1.key }.first { $0.value.imageConstraint != nil }?.key ?? "image"
let inputConstraint = desc.inputDescriptionsByName[inputName]?.imageConstraint
let inputW = inputConstraint?.pixelsWide ?? 0, inputH = inputConstraint?.pixelsHigh ?? 0
if decoder == "e2e" && inputConstraint == nil { emit(["error": "e2e decoder needs an image input, model has \(inputName) of another type"]); exit(1) }

let vnModel: VNCoreMLModel? = decoder == "vision" ? (try? VNCoreMLModel(for: mlModel)) : nil
if decoder == "vision" && vnModel == nil { emit(["error": "VNCoreMLModel failed"]); exit(1) }

struct Det { let label: String; let conf: Float; let x: Float; let y: Float; let w: Float; let h: Float }

// Class-id -> name table for models that return class indexes (RF-DETR, the e2e head). JSON array; index = class id.
let classNames: [String] = {
    guard !args.labels.isEmpty, let d = FileManager.default.contents(atPath: args.labels),
          let arr = try? JSONSerialization.jsonObject(with: d) as? [String] else { return [] }
    return arr
}()
@inline(__always) func sigmoid(_ v: Float) -> Float { 1 / (1 + exp(-v)) }
func className(_ j: Int) -> String { j >= 0 && j < classNames.count ? classNames[j] : "class_\(j)" }

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
        return Det(label: className(j), conf: s, x: cx - w / 2, y: cy - h / 2, w: w, h: h)
    }
}

func detectVision(_ cg: CGImage) throws -> [Det] {
    let req = VNCoreMLRequest(model: vnModel!)
    req.imageCropAndScaleOption = scale == "fit" ? .scaleFit : .scaleFill
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

/// The network input for the e2e head: a BGRA pixel buffer of the model's size with the frame letterboxed (fit: aspect
/// kept, centred, gray 114 pad, the training-time geometry) or stretched (fill). Returns the per-axis gains and pads
/// that map input pixels back to frame pixels: frame_x = (x - padX) / gainX.
func makeInput(_ cg: CGImage) throws -> (CVPixelBuffer, gainX: CGFloat, gainY: CGFloat, padX: CGFloat, padY: CGFloat) {
    var pb: CVPixelBuffer?
    let attrs: [CFString: Any] = [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true]
    guard CVPixelBufferCreate(kCFAllocatorDefault, inputW, inputH, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb) == kCVReturnSuccess, let buf = pb else {
        throw DetectorError(description: "CVPixelBufferCreate failed")
    }
    CVPixelBufferLockBaseAddress(buf, [])
    defer { CVPixelBufferUnlockBaseAddress(buf, []) }
    guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: inputW, height: inputH, bitsPerComponent: 8,
                              bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
        throw DetectorError(description: "CGContext failed")
    }
    ctx.interpolationQuality = .medium
    let iw = CGFloat(cg.width), ih = CGFloat(cg.height), W = CGFloat(inputW), H = CGFloat(inputH)
    if scale == "fit" {
        ctx.setFillColor(CGColor(red: 114 / 255, green: 114 / 255, blue: 114 / 255, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        let g = min(W / iw, H / ih)
        let dw = (iw * g).rounded(), dh = (ih * g).rounded()
        let px = ((W - dw) / 2).rounded(.down), py = ((H - dh) / 2).rounded(.down)
        ctx.draw(cg, in: CGRect(x: px, y: py, width: dw, height: dh))
        return (buf, dw / iw, dh / ih, px, py)
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
    return (buf, W / iw, H / ih, 0, 0)
}

func detectE2E(_ cg: CGImage) throws -> [Det] {
    let (buf, gx, gy, px, py) = try makeInput(cg)
    let out = try mlModel.prediction(from: MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: buf)]))
    guard let name = outputNames.first, let arr = out.featureValue(for: name)?.multiArrayValue, arr.shape.count == 3 else {
        throw DetectorError(description: "e2e output missing or not rank 3: \(outputNames)")
    }
    let n = arr.shape[1].intValue
    let iw = Float(cg.width), ih = Float(cg.height)
    var dets: [Det] = []
    for i in 0..<n {
        let at = { (j: Int) -> Float in arr[[0, i, j] as [NSNumber]].floatValue } // subscripting honours strides and dtype
        let s = at(4)
        if s < args.threshold { continue }
        // input pixels -> frame pixels -> normalized, clamped
        let x1 = max(0, min(1, (at(0) - Float(px)) / Float(gx) / iw)), y1 = max(0, min(1, (at(1) - Float(py)) / Float(gy) / ih))
        let x2 = max(0, min(1, (at(2) - Float(px)) / Float(gx) / iw)), y2 = max(0, min(1, (at(3) - Float(py)) / Float(gy) / ih))
        if x2 <= x1 || y2 <= y1 { continue }
        dets.append(Det(label: className(Int(at(5).rounded())), conf: s, x: x1, y: y1, w: x2 - x1, h: y2 - y1))
    }
    dets.sort { $0.conf > $1.conf }
    return Array(dets.prefix(args.topk))
}

func detect(_ cg: CGImage) throws -> [Det] { decoder == "e2e" ? try detectE2E(cg) : try detectVision(cg) }

func detect(path: String) throws -> [Det] {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw DetectorError(description: "cannot decode \(path)")
    }
    return try detect(cg)
}

func detsJSON(_ dets: [Det]) -> [[String: Any]] {
    dets.map { ["label": $0.label, "confidence": $0.conf, "x": $0.x, "y": $0.y, "w": $0.w, "h": $0.h] }
}

/// Decode a video with AVAssetReader (VideoToolbox) and run every `stride`-th frame; one line per processed frame and
/// a summary line at the end.
func runVideo(id: String, path: String, stride: Int) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    guard let track = asset.tracks(withMediaType: .video).first else { emit(["id": id, "video": path, "error": "no video track"]); return }
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) } catch { emit(["id": id, "video": path, "error": "\(error)"]); return }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { emit(["id": id, "video": path, "error": "startReading: \(String(describing: reader.error))"]); return }
    let t0 = Date()
    var frameNo = 0, processed = 0
    var decodeAcc = 0.0
    var decodeMs: [Double] = [], inferMs: [Double] = []
    while true {
        let td = Date()
        guard let sb = output.copyNextSampleBuffer() else { break }
        decodeAcc += Date().timeIntervalSince(td) * 1000
        if frameNo % stride == 0, let pb = CMSampleBufferGetImageBuffer(sb) {
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            var cg: CGImage?
            VTCreateCGImageFromCVPixelBuffer(pb, options: nil, imageOut: &cg)
            if let cg {
                let ti = Date()
                do {
                    let dets = try detect(cg)
                    let ms = Date().timeIntervalSince(ti) * 1000
                    decodeMs.append(decodeAcc); inferMs.append(ms); processed += 1
                    emit(["id": id, "video": path, "frame_no": frameNo, "pts_s": round2(pts * 1000) / 1000, "decode_ms": round2(decodeAcc), "ms": round2(ms),
                          "width": cg.width, "height": cg.height, "detections": detsJSON(dets)])
                } catch {
                    emit(["id": id, "video": path, "frame_no": frameNo, "error": "\(error)"])
                }
            }
            decodeAcc = 0
        }
        frameNo += 1
    }
    let wall = Date().timeIntervalSince(t0)
    emit(["id": id, "video": path, "done": true, "frames": frameNo, "processed": processed, "stride": stride, "wall_s": round2(wall),
          "fps_wall": round2(Double(frameNo) / max(wall, 1e-9)), "nominal_fps": round2(Double(track.nominalFrameRate)),
          "decode_ms": ["p50": round2(pct(decodeMs, 0.5)), "p95": round2(pct(decodeMs, 0.95))],
          "ms": ["p50": round2(pct(inferMs, 0.5)), "p95": round2(pct(inferMs, 0.95))], "rss_mb": rssMB(),
          "error": reader.status == .failed ? String(describing: reader.error) : NSNull()])
}

emit(["ready": true, "model": modelURL.lastPathComponent, "compute": args.compute, "threshold": args.threshold, "decoder": decoder, "scale": scale,
      "input": ["name": inputName, "w": inputW, "h": inputH], "inputs": Array(desc.inputDescriptionsByName.keys), "outputs": outputNames, "rss_mb": rssMB()])

if !args.video.isEmpty {
    runVideo(id: "", path: args.video, stride: args.stride)
    exit(0)
}

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    var id = "", path = line, video = "", stride = args.stride
    if let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        id = (obj["id"] as? String) ?? ""; path = (obj["path"] as? String) ?? ""
        video = (obj["video"] as? String) ?? ""; stride = max(1, (obj["stride"] as? Int) ?? args.stride)
    }
    if !video.isEmpty { runVideo(id: id, path: video, stride: stride); continue }
    let t0 = Date()
    do {
        let dets = try detect(path: path)
        let ms = Date().timeIntervalSince(t0) * 1000
        emit(["id": id, "path": path, "ms": round2(ms), "rss_mb": rssMB(), "detections": detsJSON(dets)])
    } catch {
        emit(["id": id, "path": path, "error": "\(error)"])
    }
}
