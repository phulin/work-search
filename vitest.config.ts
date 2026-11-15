import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Construction controls contain frozen copies of tests and source. Run
    // those explicitly from their own directory, never as this checkout's tests.
    exclude: [...configDefaults.exclude, "work/**"],
  },
});
