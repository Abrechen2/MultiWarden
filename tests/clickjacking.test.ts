// Unit tests for the decision logic behind the clickjacking / invisible-field defences
// (src/content/guard.ts, src/inline-menu/arming.ts). The DOM side is covered by tests/content-dom.test.ts.
import { clipHidesAll, clipPathHidesAll, filterFactor, intentAllows, INTENT_WINDOW_MS } from "../src/content/guard";
import { ARMING_DELAY_MS, isArmed } from "../src/inline-menu/arming";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

// CSS filter → how much of the content is still perceivable
check("filter none keeps everything", filterFactor("none") === 1);
check("filter opacity(0) hides", filterFactor("opacity(0)") === 0, filterFactor("opacity(0)"));
check("filter opacity(0.05) is nearly invisible", filterFactor("opacity(0.05)") < 0.1, filterFactor("opacity(0.05)"));
check("filter brightness(0) hides", filterFactor("brightness(0)") === 0, filterFactor("brightness(0)"));
check("filter contrast(0.02) hides", filterFactor("contrast(0.02)") < 0.1, filterFactor("contrast(0.02)"));
check("filter blur(20px) hides", filterFactor("blur(20px)") === 0, filterFactor("blur(20px)"));
check("filter invert(0.5) hides", filterFactor("invert(0.5)") === 0, filterFactor("invert(0.5)"));
check("dark-mode filter stays visible", filterFactor("invert(1) hue-rotate(180deg)") === 1, filterFactor("invert(1) hue-rotate(180deg)"));
check("drop-shadow stays visible", filterFactor("drop-shadow(rgba(0, 0, 0, 0.3) 0px 1px 2px)") === 1);

// clip / clip-path that cut the element away
check("clip rect(0,0,0,0) hides", clipHidesAll("rect(0px, 0px, 0px, 0px)"));
check("clip rect(1px,1px,1px,1px) hides", clipHidesAll("rect(1px, 1px, 1px, 1px)"));
check("clip auto keeps", !clipHidesAll("auto"));
check("clip rect(0, 200px, 30px, 0) keeps", !clipHidesAll("rect(0px, 200px, 30px, 0px)"));
check("clip with auto edges keeps", !clipHidesAll("rect(auto, auto, auto, auto)"));
check("clip-path inset(50%) hides", clipPathHidesAll("inset(50%)"));
check("clip-path inset(100%) hides", clipPathHidesAll("inset(100%)"));
check("clip-path inset(0 0 100% 0) hides", clipPathHidesAll("inset(0px 0px 100% 0px)"));
check("clip-path circle(0) hides", clipPathHidesAll("circle(0px at 50% 50%)"));
check("clip-path none keeps", !clipPathHidesAll("none"));
check("clip-path inset(10%) keeps", !clipPathHidesAll("inset(10%)"));
check("clip-path rounded inset keeps", !clipPathHidesAll("inset(0px round 8px)"));

// the menu opens only after genuine interaction with the field
const field = { id: "field" } as unknown as Element;
const label = { id: "label" } as unknown as Element;
const other = { id: "other" } as unknown as Element;
check("no interaction → no menu", !intentAllows(null, field, [], 1000));
check("pointer on the field → menu", intentAllows({ at: 1000, via: "pointer", target: field }, field, [], 1100));
check("pointer on its label → menu", intentAllows({ at: 1000, via: "pointer", target: label }, field, [label], 1100));
check("pointer elsewhere (script then calls focus()) → no menu", !intentAllows({ at: 1000, via: "pointer", target: other }, field, [label], 1100));
check("Tab key → menu", intentAllows({ at: 1000, via: "tab", target: null }, field, [], 1100));
check("stale interaction → no menu", !intentAllows({ at: 1000, via: "pointer", target: field }, field, [], 1000 + INTENT_WINDOW_MS + 1));
check("typing in the field → menu", intentAllows({ at: 1000, via: "key", target: field }, field, [], 1010));
check("typing elsewhere → no menu", !intentAllows({ at: 1000, via: "key", target: other }, field, [], 1010));

// inline menu entries ignore clicks right after the menu appeared or moved
check("not armed right after showing", !isArmed({ shownAt: 1000, occluded: false }, 1100));
check("not armed just before the delay", !isArmed({ shownAt: 1000, occluded: false }, 1000 + ARMING_DELAY_MS - 1));
check("armed after the delay", isArmed({ shownAt: 1000, occluded: false }, 1000 + ARMING_DELAY_MS));
check("never armed while occluded", !isArmed({ shownAt: 1000, occluded: true }, 9000));
check("delay is at least 500 ms", ARMING_DELAY_MS >= 500);

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
