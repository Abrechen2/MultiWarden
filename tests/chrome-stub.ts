// Minimal chrome.* stub for running background code in Node (import this first).
export const localData: Record<string, any> = {};
export const sessionData: Record<string, any> = {};
const mkArea = (m: Record<string, any>) => ({
  get: async (k: string | null) => {
    if (k == null) return structuredClone(m);
    return { [k]: m[k] === undefined ? undefined : structuredClone(m[k]) };
  },
  set: async (o: any) => {
    for (const [k, v] of Object.entries(o)) m[k] = structuredClone(v);
  },
  remove: async (k: string | string[]) => {
    for (const x of Array.isArray(k) ? k : [k]) delete m[x];
  },
});
const noopEvent = { addListener() {}, removeListener() {} };
export const opened: { tabs: string[]; windows: string[] } = { tabs: [], windows: [] };
(globalThis as any).chrome = {
  i18n: { getUILanguage: () => "de" },
  storage: { local: mkArea(localData), session: mkArea(sessionData) },
  runtime: {
    id: "test",
    getURL: (p: string) => "chrome-extension://test/" + p,
    sendMessage: async () => {},
    onConnect: noopEvent,
    onMessage: noopEvent,
  },
  tabs: {
    create: async (o: any) => {
      opened.tabs.push(o.url);
      return { id: 1000 + opened.tabs.length, url: o.url };
    },
    remove: async () => {},
    sendMessage: async () => {},
    onUpdated: noopEvent,
    onRemoved: noopEvent,
  },
  windows: {
    getAll: async () => [{ id: 1, focused: true }],
    create: async (o: any) => {
      opened.windows.push(o.url);
      return { id: 2000 + opened.windows.length, tabs: [{ id: 3000 + opened.windows.length }] };
    },
    update: async () => ({}),
    get: async () => ({ id: 1, left: 0, top: 0, width: 1200, height: 800 }),
    remove: async () => {},
    onRemoved: noopEvent,
  },
};

export function resetStorage() {
  for (const k of Object.keys(localData)) delete localData[k];
  for (const k of Object.keys(sessionData)) delete sessionData[k];
}

export const loginUi = { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} };
