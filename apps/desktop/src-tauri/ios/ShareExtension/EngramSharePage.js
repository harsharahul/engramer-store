// Runs inside the shared web page before the extension opens, and hands
// it the page's title, address and selected text. The page's content
// never leaves the device: the extension renders it to a PDF itself.
var EngramSharePage = function () {};

EngramSharePage.prototype = {
  run: function (arguments) {
    arguments.completionFunction({
      title: document.title || "",
      url: document.URL || "",
      selection: String(window.getSelection ? window.getSelection() : ""),
    });
  },
  finalize: function () {},
};

var ExtensionPreprocessingJS = new EngramSharePage();
