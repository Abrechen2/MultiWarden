// Browser test of the content script's defences against invisible fields and inline-menu clickjacking:
// the real content script (tests/content-harness.ts) runs in a test page in Chromium with a chrome.* stub,
// so layout, hit testing and trusted input events are real. No extension or vault server needed.
// Run: CHROMIUM_PATH=… tests/run-node.sh tests/content-dom.test.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, Page } from "playwright-core";
import { TMP, chromiumOptions } from "./env.mjs";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const ORIGIN = "http://mw.test";
// bundled through the esbuild CLI (run-node.sh bundles this file, and esbuild itself cannot be bundled)
const harnessOut = path.join(TMP, "content-harness.js");
execFileSync(
  process.execPath,
  [
    path.resolve("node_modules/esbuild/bin/esbuild"),
    path.resolve("tests/content-harness.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=MWH",
    "--define:__TEST__=false",
    "--define:__FIREFOX__=false",
    "--log-level=warning",
    "--outfile=" + harnessOut,
  ],
  { stdio: "inherit" },
);
// window.chrome cannot be replaced in a page, so the bundle sees the stub as a function parameter
const bundle = `(function (chrome) {
${readFileSync(harnessOut, "utf8")}
window.MWH = MWH;
})(window.__chromeStub);`;

/** chrome.* stub for the page: hands out menu tokens and records the opid of the field. */
const STUB = `
window.__mw = { opids: [], listeners: [] };
const ev = { addListener() {}, removeListener() {} };
window.__chromeStub = {
  runtime: {
    getURL: (p) => "${ORIGIN}/ext/" + p,
    sendMessage: async (m) => {
      if (m && m.rpc === "inlineMenuToken") { __mw.opids.push(m.args.opid); return { ok: true, data: { token: "tok" + __mw.opids.length } }; }
      return { ok: true };
    },
    onMessage: { addListener: (fn) => __mw.listeners.push(fn), removeListener() {} },
  },
  storage: { local: { get: async () => ({ settings: { inlineMenu: true } }) }, onChanged: ev },
};`;

// the real inline menu page (src/inline-menu), with a chrome.* stub that serves two entries and records fills
const menuOut = path.join(TMP, "inline-menu-harness.js");
execFileSync(
  process.execPath,
  [
    path.resolve("node_modules/esbuild/bin/esbuild"),
    path.resolve("src/inline-menu/index.tsx"),
    "--bundle",
    "--format=iife",
    "--jsx=automatic",
    "--jsx-import-source=preact",
    "--loader:.css=empty",
    "--define:__TEST__=false",
    "--define:__FIREFOX__=false",
    "--log-level=warning",
    "--outfile=" + menuOut,
  ],
  { stdio: "inherit" },
);
const REAL_MENU_PAGE = `<!doctype html><html><body style="margin:0;background:#fff"><div id="root"></div><script>
window.__fills = [];
const ev = { addListener() {}, removeListener() {} };
const item = (id, name) => ({ id, accountKey: "a", name, username: name + "@test", type: 1, accountColor: "#175ddc", accountLabel: "A", accountInitials: "A" });
window.__menuChrome = {
  i18n: { getUILanguage: () => "de" },
  storage: { local: { get: async () => ({ settings: {} }) }, onChanged: ev },
  runtime: {
    onMessage: ev,
    sendMessage: async (m) => {
      if (m.rpc === "inlineMenuData")
        return { ok: true, data: { kind: "login", locked: false, hasAccounts: true, items: [item("1", "Erster"), item("2", "Zweiter")], passkeys: [], showFavicons: false, theme: "light", multi: false } };
      if (m.rpc === "inlineMenuFill") { __fills.push(m.args.itemId); return { ok: true, data: { ok: true } }; }
      return { ok: true, data: {} };
    },
  },
};
</script><script>(function (chrome) {
${readFileSync(menuOut, "utf8").replace(/<\/script/gi, "<\\/script")}
})(window.__menuChrome);</script></body></html>`;
let realMenu = false;

/** stand-in for the inline menu page: reports its height like the real one */
const MENU_PAGE = `<!doctype html><body style="margin:0;background:#fff"><div style="height:200px">menu</div>
<script>parent.postMessage({ mwToken: decodeURIComponent(location.hash.slice(1)), height: 200 }, "*");</script></body>`;

const pages: Record<string, string> = {};

async function open(ctx: any, name: string, html: string): Promise<Page> {
  pages[name] = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:8px">${html}</body></html>`;
  const p: Page = await ctx.newPage();
  await p.addInitScript(STUB);
  await p.goto(`${ORIGIN}/${name}.html`);
  await p.addScriptTag({ content: bundle });
  await p.waitForTimeout(80);
  return p;
}

const menuState = (p: Page) =>
  p.evaluate(() => {
    const h = document.querySelector("mw-inline-menu") as HTMLElement | null;
    if (!h) return null;
    const cs = getComputedStyle(h);
    return { opacity: cs.opacity, filter: cs.filter, display: cs.display, visibility: cs.visibility };
  });

const CARD_FORM = `<input id="before" style="width:120px"><form id="f" style="margin-top:20px">
  <input id="ccnum" autocomplete="cc-number" style="width:200px"><br>
  <input id="ccname" autocomplete="cc-name" style="width:200px"><br>
  <input id="exp" autocomplete="cc-exp" style="width:80px"><input id="csc" autocomplete="cc-csc" style="width:60px">
</form>`;
const CARD = { number: "4111111111111111", cardholderName: "Alex Test", code: "123", expMonth: "4", expYear: "2029" };

(async () => {
  const browser = await chromium.launch({ ...chromiumOptions, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  ctx.setDefaultTimeout(5000);
  await ctx.route(`${ORIGIN}/**`, (route: any) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/ext/")) return route.fulfill({ contentType: "text/html", body: realMenu ? REAL_MENU_PAGE : MENU_PAGE });
    const name = u.pathname.slice(1).replace(/\.html$/, "");
    return route.fulfill({ contentType: "text/html", body: pages[name] ?? "not found", status: pages[name] ? 200 : 404 });
  });

  // ------------------------------------------------------------------------------------------
  // 1c: the menu opens only on genuine user interaction with the field
  {
    const p = await open(ctx, "intent", CARD_FORM);
    await p.evaluate(() => (document.getElementById("ccnum") as HTMLInputElement).focus());
    await p.waitForTimeout(300);
    check("programmatic focus() does not open the menu", !(await menuState(p)));
    await p.click("#ccnum");
    await p.waitForTimeout(300);
    check("trusted click on the field opens the menu", !!(await menuState(p)));
    await p.click("#before");
    await p.waitForTimeout(300);
    await p.keyboard.press("Tab");
    await p.waitForTimeout(300);
    check("keyboard Tab into the field opens the menu", !!(await menuState(p)));
    await p.click("#before");
    await p.waitForTimeout(300);
    await p.evaluate(() => (document.getElementById("ccnum") as HTMLInputElement).focus());
    await p.waitForTimeout(200);
    await p.keyboard.type("4");
    await p.waitForTimeout(300);
    check("typing into a programmatically focused field opens the menu", !!(await menuState(p)));
    await p.close();
  }

  // 1a: page CSS / inline style tampering cannot hide the menu host
  {
    const p = await open(
      ctx,
      "css",
      `<style>mw-inline-menu { opacity: 0 !important; filter: opacity(0) !important; visibility: hidden !important }</style>` + CARD_FORM,
    );
    await p.click("#ccnum");
    await p.waitForTimeout(300);
    const st = await menuState(p);
    check(
      "page stylesheet cannot hide the menu host",
      !st || (st.opacity === "1" && st.filter === "none" && st.visibility === "visible"),
      st,
    );
    await p.close();
  }
  {
    const p = await open(ctx, "tamper", CARD_FORM);
    await p.click("#ccnum");
    await p.waitForTimeout(300);
    await p.evaluate(() => (document.querySelector("mw-inline-menu") as HTMLElement).style.setProperty("opacity", "0", "important"));
    await p.waitForTimeout(150);
    const st = await menuState(p);
    check("inline style tampering closes or restores the menu", !st || st.opacity === "1", st);
    await p.close();
  }

  // 1a: the same for the "save login?" bar
  {
    const p = await open(ctx, "bar", `<style>mw-notification { opacity: 0 !important; transform: scale(0) !important }</style><p>x</p>`);
    await p.evaluate(() => (window as any).__mw.listeners.forEach((fn: any) => fn({ cmd: "showNotification", token: "n1" })));
    await p.waitForTimeout(100);
    const bar = () =>
      p.evaluate(() => {
        const h = document.querySelector("mw-notification") as HTMLElement | null;
        return h ? { opacity: getComputedStyle(h).opacity, transform: getComputedStyle(h).transform } : null;
      });
    const b1 = await bar();
    check("page stylesheet cannot hide the notification bar", !!b1 && b1.opacity === "1" && b1.transform === "none", b1);
    await p.evaluate(() => (document.querySelector("mw-notification") as HTMLElement).style.setProperty("opacity", "0", "important"));
    await p.waitForTimeout(100);
    const b2 = await bar();
    check("inline style tampering on the notification bar is undone", !b2 || b2.opacity === "1", b2);
    await p.close();
  }

  // 1b: the menu must really be rendered when a fill is requested from it
  const menuFill = (p: Page) =>
    p.evaluate((card) => {
      const opid = (window as any).__mw.opids.at(-1);
      return (globalThis as any).__mwFill({ kind: "card", card, targetOpid: opid }).filled as number;
    }, CARD);
  {
    const p = await open(ctx, "fill-ok", CARD_FORM);
    await p.click("#ccnum");
    await p.waitForTimeout(400);
    check("menu fill works when the menu is visible", (await menuFill(p)) > 0 && (await p.inputValue("#ccnum")) === CARD.number);
    await p.close();
  }
  {
    const p = await open(ctx, "fill-hidden-parent", CARD_FORM);
    await p.click("#ccnum");
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const w = document.createElement("div");
      w.style.opacity = "0";
      document.body.append(w);
      w.append(document.querySelector("mw-inline-menu")!);
    });
    await p.waitForTimeout(100);
    check("menu fill refused when the host was moved into a transparent container", (await menuFill(p)) === 0 && !(await p.inputValue("#ccnum")));
    await p.close();
  }
  {
    const p = await open(ctx, "fill-covered", CARD_FORM);
    await p.click("#ccnum");
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const r = document.querySelector("mw-inline-menu")!.getBoundingClientRect();
      const d = document.createElement("div");
      d.setAttribute(
        "style",
        `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:2147483647;background:#fff`,
      );
      document.body.append(d);
    });
    await p.waitForTimeout(100);
    check("menu fill refused when a decoy covers the menu", (await menuFill(p)) === 0 && !(await p.inputValue("#ccnum")));
    await p.close();
  }

  // ------------------------------------------------------------------------------------------
  // 2: visibility of fields
  {
    const box = "display:inline-block;width:160px;margin:2px;vertical-align:top";
    const p = await open(
      ctx,
      "visible",
      `<div style="display:flex;flex-wrap:wrap;width:980px">
      <div style="${box}"><input id="v-normal"></div>
      <div style="${box}"><details><summary>x</summary><input id="v-details"></details></div>
      <div style="${box}"><div style="display:none"><input id="v-tab"></div></div>
      <div style="${box}"><div style="opacity:.05"><input id="v-anc-opacity"></div></div>
      <div style="${box}"><div style="opacity:.3"><div style="opacity:.3"><input id="v-anc-opacity2"></div></div></div>
      <div style="${box}"><div style="opacity:.5"><input id="v-half"></div></div>
      <div style="${box}"><input id="v-offleft" style="position:absolute;left:-9999px"></div>
      <div style="${box}"><input id="v-offtop" style="position:absolute;top:-9999px"></div>
      <div style="${box};position:relative"><input id="v-clip" style="position:absolute;clip:rect(0px,0px,0px,0px)"></div>
      <div style="${box}"><input id="v-clippath" style="clip-path:inset(50%)"></div>
      <div style="${box}"><div style="clip-path:inset(100%)"><input id="v-anc-clippath"></div></div>
      <div style="${box}"><input id="v-scale" style="transform:scale(0.01)"></div>
      <div style="${box}"><div style="width:0;height:0;overflow:hidden"><input id="v-overflow"></div></div>
      <div style="${box};position:relative"><input id="v-covered"><div style="position:absolute;inset:0;background:#fff;z-index:5"></div></div>
      <div style="${box};position:relative"><input id="v-label"><label for="v-label" style="position:absolute;left:4px;top:2px">Name</label></div>
      <div style="${box}"><div style="filter:opacity(0)"><input id="v-filter"></div></div>
      <div style="${box}"><span id="host"></span></div>
      </div>
      <div style="height:3000px"></div><input id="v-below">`,
    );
    await p.evaluate(() => {
      const sr = document.getElementById("host")!.attachShadow({ mode: "open" });
      sr.innerHTML = '<input id="v-shadow">';
    });
    const res: Record<string, boolean> = await p.evaluate(() => {
      const out: Record<string, boolean> = {};
      const all = [...document.querySelectorAll("input"), document.getElementById("host")!.shadowRoot!.querySelector("input")!];
      for (const i of all) out[i.id] = (window as any).MWH.isVisible(i);
      return out;
    });
    const want: Record<string, boolean> = {
      "v-normal": true,
      "v-below": true,
      "v-half": true,
      "v-label": true,
      "v-shadow": true,
      "v-details": false,
      "v-tab": false,
      "v-anc-opacity": false,
      "v-anc-opacity2": false,
      "v-offleft": false,
      "v-offtop": false,
      "v-clip": false,
      "v-clippath": false,
      "v-anc-clippath": false,
      "v-scale": false,
      "v-overflow": false,
      "v-covered": false,
      "v-filter": false,
    };
    for (const [id, v] of Object.entries(want)) check(`isVisible ${id} = ${v}`, res[id] === v, res[id]);
    await p.close();
  }

  // card / identity fills only reach visible fields, custom fields included
  {
    const p = await open(
      ctx,
      "card-hidden",
      `<form id="f">
      <input id="ccnum" autocomplete="cc-number"><input id="ccname" autocomplete="cc-name">
      <div style="opacity:.01"><input id="hcsc" autocomplete="cc-csc"></div>
      <div style="position:absolute;left:-9999px"><input id="hexp" autocomplete="cc-exp"></div>
      <div style="opacity:0"><input id="secret" name="secret"></div>
      <input id="note" name="note">
      </form>`,
    );
    const filled = await p.evaluate((card) => {
      const H = (window as any).MWH;
      return H.fill({
        kind: "card",
        card,
        fields: [
          { name: "secret", value: "S3CR3T" },
          { name: "note", value: "visible-note" },
        ],
        targetOpid: H.opidOf(document.getElementById("ccnum")),
      }).filled;
    }, CARD);
    const v = async (id: string) => p.inputValue("#" + id);
    check("card fill: visible fields filled", (await v("ccnum")) === CARD.number && (await v("ccname")) === CARD.cardholderName, filled);
    check("card fill: CVC in near-transparent container not filled", !(await v("hcsc")), await v("hcsc"));
    check("card fill: off-screen expiry not filled", !(await v("hexp")), await v("hexp"));
    check("card fill: custom field in transparent container not filled", !(await v("secret")), await v("secret"));
    check("card fill: visible custom field filled", (await v("note")) === "visible-note");
    await p.close();
  }
  {
    const p = await open(
      ctx,
      "identity-hidden",
      `<form id="f">
      <input id="vn" autocomplete="given-name"><input id="nn" autocomplete="family-name">
      <div style="position:absolute;left:-9999px"><input id="hstreet" autocomplete="street-address"><input id="htel" autocomplete="tel"></div>
      <div style="opacity:.02"><input id="hmail" autocomplete="email"></div>
      </form>`,
    );
    await p.evaluate(() => {
      const H = (window as any).MWH;
      H.fill({
        kind: "identity",
        identity: { firstName: "Alex", lastName: "Test", address1: "Musterstraße 12a", phone: "0123", email: "a@b.test" },
        targetOpid: H.opidOf(document.getElementById("vn")),
      });
    });
    const v = async (id: string) => p.inputValue("#" + id);
    check("identity fill: visible fields filled", (await v("vn")) === "Alex" && (await v("nn")) === "Test");
    check(
      "identity fill: hidden address/phone/e-mail not filled",
      !(await v("hstreet")) && !(await v("htel")) && !(await v("hmail")),
      [await v("hstreet"), await v("htel"), await v("hmail")],
    );
    await p.close();
  }

  // ------------------------------------------------------------------------------------------
  // regression: the open inline menu lies over the password field below the username field;
  // our own menu must not make that field count as "covered" (only one field got filled)
  {
    const LOGIN = `<form style="margin-top:20px"><input id="u" name="username" style="width:200px"><br>
      <input id="p" type="password" name="password" style="width:200px"><br><button>Login</button></form>`;
    const p = await open(ctx, "login-menu", LOGIN);
    const n0 = await p.evaluate(() => (window as any).MWH.fill({ kind: "login", username: "alex", password: "pw" }).filled);
    check("login fill without menu fills username and password", n0 === 2 && (await p.inputValue("#p")) === "pw", n0);
    await p.close();
    const q = await open(ctx, "login-menu2", LOGIN);
    await q.click("#u");
    await q.waitForTimeout(600);
    const n = await q.evaluate(() => {
      const opid = (window as any).__mw.opids.at(-1);
      return (globalThis as any).__mwFill({ kind: "login", username: "alex", password: "pw", targetOpid: opid }).filled as number;
    });
    check(
      "login fill from the open inline menu fills username and password",
      (await q.inputValue("#u")) === "alex" && (await q.inputValue("#p")) === "pw",
      { n, u: await q.inputValue("#u"), p: await q.inputValue("#p") },
    );
    await q.close();
    // a page element that only borrows the tag name is still a cover
    const f = await open(
      ctx,
      "fake-host",
      `<input id="v" style="width:200px;margin-top:40px"><mw-inline-menu style="position:absolute;left:0;top:30px;width:400px;height:60px;display:block;background:#fff"></mw-inline-menu>`,
    );
    check("page-made <mw-inline-menu> still covers a field", (await f.evaluate(() => (window as any).MWH.isVisible(document.getElementById("v")))) === false);
    await f.close();
  }

  // ------------------------------------------------------------------------------------------
  // 3: origin guard between the background's match and the fill
  {
    const p = await open(ctx, "origin", `<form><input id="u" name="username"><input id="p" type="password"></form>`);
    const r1 = await p.evaluate(
      () => (window as any).MWH.fill({ kind: "login", username: "alex", password: "pw", expectOrigin: "https://evil.example" }).filled,
    );
    check("fill refused when the frame's origin differs from the matched one", r1 === 0 && !(await p.inputValue("#p")), r1);
    const r2 = await p.evaluate(
      () =>
        (window as any).MWH.fill({ kind: "login", username: "alex", password: "pw", expectOrigin: location.origin, expectUrl: location.href + "#x" })
          .filled,
    );
    check("fill allowed for the matched origin/URL", r2 > 0 && (await p.inputValue("#p")) === "pw", r2);
    await p.evaluate(() => ((document.getElementById("p") as HTMLInputElement).value = ""));
    const r3 = await p.evaluate(
      () =>
        (window as any).MWH.fill({ kind: "login", username: "alex", password: "pw", expectOrigin: location.origin, expectUrl: location.origin + "/other.html" })
          .filled,
    );
    check("login fill refused when the URL changed after matching", r3 === 0 && !(await p.inputValue("#p")), r3);
  }

  // ------------------------------------------------------------------------------------------
  // 1d: the real menu page ignores clicks right after it appeared and while it is covered
  {
    realMenu = true;
    const LOGIN = `<form><input id="u" name="username" autocomplete="username"><input id="p" type="password"></form>`;
    const menuFrame = (p: Page) => p.frames().find((fr) => fr.url().includes("/ext/inline-menu.html"));
    const fills = async (p: Page) => (await menuFrame(p)!.evaluate(() => (window as any).__fills)) as string[];

    const p1 = await open(ctx, "arm-early", LOGIN);
    await p1.click("#u");
    await p1.waitForFunction(() => !!document.querySelector("mw-inline-menu"));
    const f1 = await (async () => {
      for (let i = 0; i < 50 && !menuFrame(p1); i++) await p1.waitForTimeout(20);
      return menuFrame(p1)!;
    })();
    await f1.waitForSelector('[data-testid="inline-item"]');
    await f1.click('[data-testid="inline-item"] >> nth=0');
    check("menu entry ignores a click right after the menu appeared", (await fills(p1)).length === 0, await fills(p1));
    await p1.waitForTimeout(700);
    await f1.click('[data-testid="inline-item"] >> nth=0');
    check("menu entry works once the menu has been visible for a moment", (await fills(p1)).length === 1, await fills(p1));
    await p1.close();

    const p2 = await open(ctx, "arm-overlay", LOGIN);
    await p2.click("#u");
    await p2.waitForFunction(() => !!document.querySelector("mw-inline-menu"));
    for (let i = 0; i < 50 && !menuFrame(p2); i++) await p2.waitForTimeout(20);
    const f2 = menuFrame(p2)!;
    await f2.waitForSelector('[data-testid="inline-item"]');
    await p2.evaluate(() => {
      // a decoy painted over the menu that lets clicks through to it
      const d = document.createElement("div");
      d.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:#fff");
      document.body.append(d);
    });
    await p2.waitForTimeout(800);
    await f2.click('[data-testid="inline-item"] >> nth=0');
    check("menu entry ignores clicks through a pointer-events:none overlay (Chromium)", (await fills(p2)).length === 0, await fills(p2));
    await p2.close();
    realMenu = false;
  }

  await browser.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
