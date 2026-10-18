import XCTest

/// Walks every screen of the installed Engram Store app and writes one
/// screenshot per step to WALK_OUT. Steps are soft: a control that cannot
/// be found is logged in steps.txt and the walk moves on, so one missing
/// element never hides the rest of the screens.
///
/// Environment (pass as TEST_RUNNER_<NAME> to xcodebuild):
///   WALK_OUT         directory for screenshots and steps.txt
///   WALK_EMAIL       a test account on the server the app points at
///   WALK_PASSPHRASE  that account's passphrase
final class ScreenWalk: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private lazy var out = URL(fileURLWithPath: env["WALK_OUT"] ?? NSTemporaryDirectory())
  private var log: [String] = []
  private var step = 0
  private var app: XCUIApplication!
  private var web: XCUIElement!

  override func setUpWithError() throws {
    continueAfterFailure = true
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
  }

  override func tearDown() {
    try? log.joined(separator: "\n").write(to: out.appendingPathComponent("steps.txt"), atomically: true, encoding: .utf8)
  }

  func testWalkEveryScreen() throws {
    app = XCUIApplication(bundleIdentifier: "com.harsharahul.engramstore")
    app.launch()
    web = app.webViews.firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 30), "the app shows its web view")
    pause(3)
    shot("launch")

    signIn()
    shot("files")

    // Phone tab bar (the sidebar drawer duplicates these labels off
    // screen, so the bottom-most hittable match is the tab).
    let hasTabs = tab("Photos")
    if hasTabs {
      pause(1.5)
      shot("photos")
      web.swipeUp()
      pause(1)
      shot("photos-scrolled")
      web.swipeDown()
      web.swipeDown()
      pause(0.5)

      if tab("Notices") {
        pause(1.2)
        shot("notices")
        dismissSheet()
      }
      if tab("More") {
        pause(1.2)
        shot("more")
        for place in ["Recent", "Favorites", "Shared", "Trash"] {
          if tapAny(place) {
            pause(1.5)
            shot("place-\(place.lowercased())")
          }
          // A place the vault lacks (Shared, on this device) leaves the
          // drawer open; openDrawer keeps it rather than toggling it shut.
          if place != "Trash" { openDrawer() }
        }
      }

      // Search: keyboard up, typed, dismissed, a result opened.
      if tab("Search") {
        pause(1.2)
        shot("search-focused")
        app.typeText("no")
        pause(1.5)
        shot("search-typed")
        hideKeyboard()
        pause(1)
        shot("search-results")
        if tapAny("alpha-notes.txt") || tapFirst(web.staticTexts, endingWith: ".txt") {
          pause(2)
          shot("preview-from-search")
          closePreview()
        }
        clearSearch()
      }
      tab("Files")
      pause(1)
    } else {
      // No tab bar: a tablet or desktop layout. Use the sidebar.
      for place in ["Photos", "Recent", "Favorites", "Shared", "Trash"] {
        if tapAny(place) {
          pause(1.5)
          shot("place-\(place.lowercased())")
        }
      }
      tapAny("Files")
      pause(1)
      let search = web.textFields.firstMatch
      if search.exists {
        search.tap()
        pause(1)
        shot("search-focused")
        app.typeText("no")
        pause(1.5)
        shot("search-typed")
        hideKeyboard()
        clearSearch()
      }
    }

    // A folder, a file in it, its preview, its menu, select mode, New.
    if tapAny("Notes") {
      pause(1.5)
      shot("folder")
      if tapFirst(web.staticTexts, endingWith: ".txt") {
        pause(2)
        shot("preview-text")
        closePreview()
      }
      if let file = first(web.staticTexts, endingWith: ".txt") {
        file.press(forDuration: 0.9)
        pause(1)
        shot("file-menu")
        dismissSheet()
      }
      if tapAny("Select") {
        pause(1)
        shot("select-mode")
        tapAny("Cancel")
      }
      goBack()
    }
    if tapAny("New") || tapAny("Add") {
      pause(1)
      shot("new-sheet")
      dismissSheet()
    }

    // Profile, wherever the account lives on this form factor. A vault on
    // this device labels the account button with the device's name and
    // keeps Profile in its menu.
    if hasTabs { openDrawer() }
    let viaDevice = ["This iPhone", "This iPad", "This Mac"].contains { label in
      // The account button opens a menu (aria-haspopup), which WebKit
      // exposes as a group named "Account: <label>" that XCUITest does not
      // consider hittable; a tap at its centre reaches it all the same.
      let opened = tapCentre(ofFirst: web.otherElements, endingWith: label)
        || tapCentre(ofFirst: web.buttons, endingWith: label)
      guard opened else {
        describeCandidates(containing: label)
        return false
      }
      pause(1)
      shot("account-menu")
      let profile = tapMenuItem("Profile and settings")
      if !profile {
        describeCandidates(containing: "Profile")
      }
      return profile
    }
    if viaDevice || tapAny("Profile") || tapAny(env["WALK_EMAIL"] ?? "") || tapAny("livecheck") {
      pause(1.5)
      shot("profile")
      web.swipeUp()
      pause(1)
      shot("profile-scrolled")
      web.swipeUp()
      pause(1)
      shot("profile-end")
    } else {
      dismissSheet()
    }

    // Landscape, where widths change the most.
    XCUIDevice.shared.orientation = .landscapeLeft
    pause(2)
    shot("landscape")
    XCUIDevice.shared.orientation = .portrait
    pause(1)
  }

  // MARK: sign-in

  /// A generic build opens on the picker; the walk keeps the vault on
  /// this device and creates it with the passphrase alone, so every
  /// later screen is the local-mode one.
  private func keepOnThisDevice() -> Bool {
    let keep = web.buttons["Keep it on this device"]
    guard keep.waitForExistence(timeout: 10) else {
      return false
    }
    shot("picker")
    keep.tap()
    // The backend binds, the client loads, the registration answer picks
    // the form: "Create your vault" with two passphrase fields.
    guard web.staticTexts["Create your vault"].waitForExistence(timeout: 60) else {
      note("the picker did not reach the vault's sign-in screen")
      return true
    }
    shot("create-vault")
    let fields = web.secureTextFields
    guard fields.count >= 2 else {
      note("the create form did not show two passphrase fields")
      return true
    }
    let passphrase = env["WALK_PASSPHRASE"] ?? "walk-pass-2026"
    fields.element(boundBy: 0).tap()
    app.typeText(passphrase)
    fields.element(boundBy: 1).tap()
    app.typeText(passphrase)
    hideKeyboard()
    shot("create-vault-filled")
    if let create = hittable(web.buttons, "Create vault") {
      create.tap()
    } else {
      app.typeText("\n")
    }
    // Key derivation is slow on purpose; the recovery key dialog follows.
    if web.buttons["I saved it, open my vault"].waitForExistence(timeout: 90) {
      shot("recovery-key")
      web.buttons["I saved it, open my vault"].tap()
    } else {
      note("no recovery key dialog after creating the vault")
    }
    if !web.buttons["More"].waitForExistence(timeout: 60), !web.buttons["Files"].waitForExistence(timeout: 5) {
      note("the vault did not open after creation")
    }
    pause(3)
    declineBiometricOffer()
    return true
  }

  /// The first unlock on a device offers Touch ID / Face ID as a sheet
  /// over everything; the walk declines it.
  private func declineBiometricOffer() {
    if web.buttons["Enable"].waitForExistence(timeout: 4), let decline = hittable(web.buttons, "Cancel") {
      shot("biometric-offer")
      decline.tap()
      note("declined the biometric unlock offer")
      pause(1)
    }
  }

  private func signIn() {
    if keepOnThisDevice() {
      return
    }
    let email = web.textFields.firstMatch
    guard email.waitForExistence(timeout: 10) else {
      note("no sign-in form; assuming a session is already open")
      return
    }
    email.tap()
    app.typeText(env["WALK_EMAIL"] ?? "")
    let pass = web.secureTextFields.firstMatch
    if pass.waitForExistence(timeout: 5) {
      pass.tap()
      app.typeText(env["WALK_PASSPHRASE"] ?? "")
    }
    shot("sign-in-filled")
    app.typeText("\n")
    // Unlocking derives keys; give it time before the first screen.
    if !web.buttons["More"].waitForExistence(timeout: 60), !web.buttons["Files"].waitForExistence(timeout: 5) {
      note("the vault did not appear after sign-in")
    }
    pause(4)
    declineBiometricOffer()
  }

  // MARK: element helpers

  /// Every hittable element in the query with exactly this label.
  private func hittableAll(_ query: XCUIElementQuery, _ label: String) -> [XCUIElement] {
    query.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
      .filter { $0.exists && $0.isHittable && $0.frame.width > 0 }
  }

  private func hittable(_ query: XCUIElementQuery, _ label: String) -> XCUIElement? {
    hittableAll(query, label).first
  }

  private func first(_ query: XCUIElementQuery, endingWith suffix: String) -> XCUIElement? {
    query.matching(NSPredicate(format: "label ENDSWITH %@", suffix)).allElementsBoundByIndex
      .first { $0.exists && $0.isHittable }
  }

  /// Taps a phone tab: the bottom-most hittable button with that label.
  @discardableResult
  private func tab(_ name: String) -> Bool {
    for _ in 0..<10 {
      if let target = hittableAll(web.buttons, name).max(by: { $0.frame.minY < $1.frame.minY }) {
        target.tap()
        note("tapped tab: \(name)")
        return true
      }
      pause(0.5)
    }
    note("could not reach tab: \(name)")
    return false
  }

  /// Taps the centre of the first element whose label ends with the text,
  /// hittable or not: a web control exposed as a group fails isHittable
  /// and yet reacts to a tap at its coordinates.
  private func tapCentre(ofFirst query: XCUIElementQuery, endingWith suffix: String) -> Bool {
    let matches = query.matching(NSPredicate(format: "label ENDSWITH %@", suffix))
    guard matches.firstMatch.waitForExistence(timeout: 3) else {
      return false
    }
    // The phone keeps the sidebar's controls off screen behind the drawer's
    // copies; only a match inside the screen can take the tap.
    let screen = app.frame
    let candidates = matches.allElementsBoundByIndex
    guard let match = candidates.first(where: { $0.frame.width > 0 && screen.intersects($0.frame) }) else {
      note("no on-screen match ending with \(suffix); frames: \(candidates.map { "\($0.frame)" }.joined(separator: " "))")
      return false
    }
    match.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    note("tapped centre of: \(match.label) at \(match.frame)")
    return true
  }

  /// Opens the More drawer and waits until its footer can take a tap. A
  /// sheet left open over the tab bar takes the first tap itself, and the
  /// drawer's controls keep their frames while it is off screen, so only
  /// a hittable footer proves the drawer is open.
  private func openDrawer() {
    let footer = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Used on this device")).firstMatch
    for _ in 0..<3 {
      if footer.exists && footer.isHittable {
        return
      }
      tab("More")
      pause(1)
      if footer.exists && footer.isHittable {
        return
      }
      dismissSheet()
    }
    note("the More drawer did not open")
  }

  /// Logs every element whose label, value or identifier mentions the
  /// text, so a control the walk cannot reach shows how it is exposed.
  private func describeCandidates(containing text: String) {
    let predicate = NSPredicate(
      format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@ OR identifier CONTAINS[c] %@", text, text, text)
    for element in app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex.prefix(12) {
      let value = (element.value as? String) ?? ""
      note("candidate type=\(element.elementType.rawValue) label=\(element.label) value=\(value) hittable=\(element.isHittable) frame=\(element.frame)")
    }
  }

  /// Taps the first hittable button, link or text with this label.
  @discardableResult
  private func tapAny(_ label: String) -> Bool {
    guard !label.isEmpty else { return false }
    for _ in 0..<6 {
      for query in [web.buttons, web.links, web.menuItems, web.staticTexts] {
        if let target = hittable(query, label) {
          target.tap()
          note("tapped: \(label)")
          return true
        }
      }
      pause(0.5)
    }
    note("could not reach: \(label)")
    return false
  }

  /// Taps an open menu's item by its exact label. WebKit exposes a menu
  /// item as a menu item, a group or plain text, never as a button, and
  /// not always as hittable; the tap lands on its centre. The query stays
  /// narrow: a page-wide scan of every element times out on this page.
  private func tapMenuItem(_ label: String) -> Bool {
    for _ in 0..<6 {
      for query in [web.menuItems, web.otherElements, web.staticTexts] {
        let match = query.matching(NSPredicate(format: "label == %@", label)).firstMatch
        if match.exists {
          match.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
          note("tapped menu item: \(label)")
          return true
        }
      }
      pause(0.5)
    }
    note("could not reach menu item: \(label)")
    return false
  }

  @discardableResult
  private func tapFirst(_ query: XCUIElementQuery, endingWith suffix: String) -> Bool {
    guard let target = first(query, endingWith: suffix) else {
      note("could not reach: something ending with \(suffix)")
      return false
    }
    target.tap()
    note("tapped: \(target.label)")
    return true
  }

  private func dismissSheet() {
    for label in ["Close", "Done", "Cancel"] {
      if let button = hittable(web.buttons, label) {
        button.tap()
        pause(0.8)
        return
      }
    }
    // An action sheet (a menu, on the phone) closes on a tap outside it:
    // the dimmed page above it.
    if web.menuItems.count > 0 {
      web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
      pause(0.8)
      if web.menuItems.count == 0 {
        return
      }
    }
    // A bottom sheet or drawer closes on a swipe; the drawer from its edge.
    app.swipeDown()
    pause(0.8)
  }

  private func closePreview() {
    for label in ["Close", "Close preview", "Back"] {
      if let button = hittable(web.buttons, label) {
        button.tap()
        pause(1)
        return
      }
    }
    app.swipeDown()
    pause(1)
  }

  private func goBack() {
    for label in ["Back", "All files", "Files"] {
      if let button = hittable(web.buttons, label) {
        button.tap()
        pause(1)
        return
      }
    }
  }

  private func clearSearch() {
    for label in ["Clear search", "Clear", "Close search"] {
      if let button = hittable(web.buttons, label) {
        button.tap()
        pause(0.8)
        return
      }
    }
  }

  private func hideKeyboard() {
    // Done on the keyboard's accessory bar only dismisses; Return would
    // also submit the field (in search, that opens the first result).
    if app.toolbars.buttons["Done"].exists {
      app.toolbars.buttons["Done"].tap()
    } else if app.buttons["Done"].exists {
      app.buttons["Done"].tap()
    } else if app.keyboards.buttons["Return"].exists {
      app.keyboards.buttons["Return"].tap()
    }
  }

  private func shot(_ name: String) {
    step += 1
    let file = String(format: "%02d-%@.png", step, name)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: out.appendingPathComponent(file))
    note("shot: \(file)")
  }

  private func note(_ line: String) {
    log.append(line)
  }

  private func pause(_ seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }
}
