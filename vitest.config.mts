import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		exclude: ["**/.direnv/**", "**/node_modules/**", "**/dist/**"],
	},
});
