// inspect_ane.swift — query CoreML's runtime compute-unit plan for a
// compiled MLModelC. Same info Xcode's Performance Report shows, no GUI.
//
// Usage:
//   xcrun coremlcompiler compile build/AneEncoder.mlpackage build/
//   swift inspect_ane.swift build/AneEncoder.mlmodelc

import CoreML
import Foundation

func deviceLabel(_ d: MLComputeDevice?) -> String {
    guard let d = d else { return "none" }
    // Concrete class names (MLCPUComputeDevice, MLNeuralEngineComputeDevice,
    // MLGPUComputeDevice) are exposed via the Obj-C `description` rather
    // than Swift's type(of:), which only resolves to the protocol.
    let n = String(describing: d)
    if n.contains("NeuralEngine") { return "ANE" }
    if n.contains("CPU")          { return "CPU" }
    if n.contains("GPU")          { return "GPU" }
    return "other(\(n.prefix(40)))"
}

func walk(_ block: MLModelStructure.Program.Block,
          plan: MLComputePlan,
          counter: inout [String: Int],
          byOp:    inout [String: [String: Int]]) {
    for op in block.operations {
        let name = op.operatorName.replacingOccurrences(of: "ios16.", with: "")
                                  .replacingOccurrences(of: "ios17.", with: "")
                                  .replacingOccurrences(of: "ios18.", with: "")
        let dev: String
        if let usage = plan.deviceUsage(for: op) {
            dev = deviceLabel(usage.preferred)
        } else {
            // const ops + structural ops get no plan (they're not scheduled)
            dev = "static"
        }
        counter[dev, default: 0] += 1
        byOp[name, default: [:]][dev, default: 0] += 1
        for nested in op.blocks {
            walk(nested, plan: plan, counter: &counter, byOp: &byOp)
        }
    }
}

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: swift inspect_ane.swift <path.mlmodelc>\n".utf8))
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])

let config = MLModelConfiguration()
config.computeUnits = .cpuAndNeuralEngine

print("[load] \(url.lastPathComponent) with computeUnits=.cpuAndNeuralEngine")
let plan = try await MLComputePlan.load(contentsOf: url, configuration: config)
let structure = plan.modelStructure
guard case .program(let program) = structure else {
    FileHandle.standardError.write(Data("error: model is not an mlprogram\n".utf8))
    exit(1)
}

var counter: [String: Int] = [:]
var byOp:    [String: [String: Int]] = [:]
for (fnName, fn) in program.functions {
    print("[fn] \(fnName)")
    walk(fn.block, plan: plan, counter: &counter, byOp: &byOp)
}

let total = counter.values.reduce(0, +)
// "schedulable" excludes const + structural ops that don't have a plan.
let schedulable = total - (counter["static", default: 0])
let aneCount = counter["ANE", default: 0]
let cpuCount = counter["CPU", default: 0]
let gpuCount = counter["GPU", default: 0]
let pctAne = schedulable > 0 ? Double(aneCount) / Double(schedulable) * 100.0 : 0.0

print()
print("[summary] total ops parsed: \(total)")
for k in ["ANE", "CPU", "GPU", "other", "static"] {
    if let v = counter[k], v > 0 {
        let pct = Double(v) / Double(total) * 100.0
        print("  \(k.padding(toLength: 10, withPad: " ", startingAt: 0)) \(String(format: "%4d", v))  (\(String(format: "%5.1f", pct))%)")
    }
}
print()
print(String(format: "[verdict] runtime ANE residency (of schedulable ops): %.1f%% (%d/%d)",
             pctAne, aneCount, schedulable))
print("           — schedulable = total minus const / static ops with no compute plan")

print()
print("[per-op-type breakdown]")
let sortedTypes = byOp.keys.sorted { (a, b) in
    (byOp[a]!.values.reduce(0,+)) > (byOp[b]!.values.reduce(0,+))
}
for t in sortedTypes {
    let dist = byOp[t]!.sorted { $0.value > $1.value }
        .map { "\($0.key)=\($0.value)" }.joined(separator: " ")
    let n = byOp[t]!.values.reduce(0,+)
    print("  \(t.padding(toLength: 28, withPad: " ", startingAt: 0)) \(String(format: "%4d", n))  [\(dist)]")
}

// Write JSON proof artefact
var json: [String: Any] = [:]
json["package"]           = url.lastPathComponent
json["total_ops"]         = total
json["schedulable_ops"]   = schedulable
json["ane_ops"]           = aneCount
json["cpu_ops"]           = cpuCount
json["gpu_ops"]           = gpuCount
json["ane_residency_pct"] = pctAne
json["device_counts"]     = counter
json["per_op_type"]       = byOp

let proofDir = url.deletingLastPathComponent().appendingPathComponent("proof")
try? FileManager.default.createDirectory(at: proofDir, withIntermediateDirectories: true)
let data = try JSONSerialization.data(withJSONObject: json,
                                      options: [.prettyPrinted, .sortedKeys])
let outPath = proofDir.appendingPathComponent("runtime_plan.json")
try data.write(to: outPath)
print()
print("[write] \(outPath.path)")

// 95%+ ANE on schedulable ops = practical 100% (Apple's ml-ane-transformers
// reference repo lands here too — boundary transposes are unavoidable).
exit(pctAne >= 95.0 ? 0 : 1)
