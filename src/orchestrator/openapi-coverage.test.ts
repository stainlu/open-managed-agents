import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("OpenAPI route coverage", () => {
  it("documents every public v1 server route", () => {
    const serverRoutes = readServerRoutes();
    const openApiRoutes = readOpenApiRoutes();

    for (const route of serverRoutes) {
      expect(
        openApiRoutes.has(route.key),
        `${route.method.toUpperCase()} ${route.path} is missing from openapi/openapi.yaml`,
      ).toBe(true);
    }
  });
});

function readServerRoutes(): Array<{ method: string; path: string; key: string }> {
  const source = readFileSync(resolve(repoRoot, "src/orchestrator/server.ts"), "utf8");
  const routes: Array<{ method: string; path: string; key: string }> = [];
  const routePattern = /app\.(get|post|put|delete|patch)\("([^"]+)"/g;
  for (const match of source.matchAll(routePattern)) {
    const method = match[1];
    const path = match[2];
    if (!method || !path.startsWith("/v1/")) continue;
    routes.push({
      method,
      path,
      key: routeKey(method, normalizeHonoPath(path)),
    });
  }
  return routes.sort((a, b) => a.key.localeCompare(b.key));
}

function readOpenApiRoutes(): Set<string> {
  const source = readFileSync(resolve(repoRoot, "openapi/openapi.yaml"), "utf8");
  const routes = new Set<string>();
  let currentPath: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const pathMatch = /^  (\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = /^    (get|post|put|delete|patch):$/.exec(line);
    if (currentPath && methodMatch?.[1]) {
      routes.add(routeKey(methodMatch[1], currentPath));
    }
  }
  return routes;
}

function normalizeHonoPath(path: string): string {
  return path
    .replace(/\/\*$/, "/{filePath}")
    .replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}

function routeKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}
