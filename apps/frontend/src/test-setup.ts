import "@testing-library/jest-dom/vitest";

// Node 22+ ships an experimental global `localStorage`/`sessionStorage` that is
// `undefined` unless `--localstorage-file` is passed, and it shadows the ones
// jsdom provides in the vitest jsdom environment. jsdom already supplies real
// Storage objects, so only fill the gap when the globals are missing (e.g. on
// newer Node versions) to keep the suite deterministic across Node majors.
function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = createStorageMock();
}
if (typeof globalThis.sessionStorage === "undefined") {
  globalThis.sessionStorage = createStorageMock();
}

// jsdom does not implement matchMedia. Components that branch on the viewport
// (useMediaQuery, e.g. the quadrant view) need a minimal, always-desktop stub.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
