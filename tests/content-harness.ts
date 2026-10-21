// Page-side harness for tests/content-dom.test.ts: the real content script (inline menu, field
// detection, filling) bundled into a test page. tests/content-dom.test.ts installs a chrome.* stub first.
import "../src/content/autofill";
export { isVisible } from "../src/content/fields";
export { fill, opidOf } from "../src/content/fill";
