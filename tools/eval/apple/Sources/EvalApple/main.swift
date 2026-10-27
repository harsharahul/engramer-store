// The eval harness for Apple's on-device model: the app's own Swift shim,
// driven from the command line. One request per input line (the JSON the
// app sends), one answer envelope per output line. Never used by the app.

import Foundation

if CommandLine.arguments.contains("--availability") {
    print(IntelAvailability.json())
    exit(0)
}

while let line = readLine(strippingNewline: true) {
    if line.isEmpty {
        continue
    }
    print(IntelGenerate.run(requestJSON: line, emit: nil))
    fflush(stdout)
}
