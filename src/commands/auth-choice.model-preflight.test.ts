import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preflightDefaultModelAccess } from "./auth-choice.model-preflight.js";

const loadPreparedModelCatalogView = vi.hoisted(() =>
  vi.fn(async () => ({ snapshot: { entries: [], routeVariants: [] } })),
);
const resolveDefaultModelForAgent = vi.hoisted(() =>
  vi.fn(() => ({ provider: "openai", model: "gpt-6-astra" })),
);
const getProviderEnvVarsCore = vi.hoisted(() => vi.fn(() => ["OPENAI_API_KEY"]));

vi.mock("../agents/model-catalog-view.js", () => ({ loadPreparedModelCatalogView }));
vi.mock("../agents/model-selection.js", () => ({ resolveDefaultModelForAgent }));
vi.mock("../secrets/provider-env-vars.js", () => ({ getProviderEnvVarsCore }));

const config: OpenClawConfig = {};

describe("preflightDefaultModelAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-6-astra" });
    getProviderEnvVarsCore.mockReturnValue(["OPENAI_API_KEY"]);
  });

  it("returns ok when the configured model is present in the live catalog", async () => {
    loadPreparedModelCatalogView.mockResolvedValueOnce({
      snapshot: {
        entries: [{ provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra" }],
        routeVariants: [],
      },
    });
    const outcome = await preflightDefaultModelAccess(config);
    expect(outcome).toEqual({ status: "ok" });
    expect(loadPreparedModelCatalogView).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "picker",
        providerScoped: true,
        preferLiveProviderCatalog: true,
        allowStaticFallbackCatalog: false,
      }),
    );
  });

  it("returns replace with the lowest providerOrder entry when the configured model is absent", async () => {
    loadPreparedModelCatalogView.mockResolvedValueOnce({
      snapshot: {
        entries: [
          { provider: "openai", id: "gpt-5-nano", name: "nano", providerOrder: 10 },
          { provider: "openai", id: "gpt-5", name: "flagship", providerOrder: 1 },
        ],
        routeVariants: [],
      },
    });
    const outcome = await preflightDefaultModelAccess(config);
    expect(outcome).toEqual({
      status: "replace",
      configuredRef: "openai/gpt-6-astra",
      replacement: { provider: "openai", modelId: "gpt-5", ref: "openai/gpt-5" },
    });
  });

  it("returns unverified when the catalog loader throws", async () => {
    loadPreparedModelCatalogView.mockRejectedValueOnce(new Error("boom"));
    const outcome = await preflightDefaultModelAccess(config);
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
  });

  it("returns unverified when the catalog is empty", async () => {
    const outcome = await preflightDefaultModelAccess(config);
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
  });

  it("rejects cross-provider entries so a mismatched catalog never becomes a replacement", async () => {
    loadPreparedModelCatalogView.mockResolvedValueOnce({
      snapshot: {
        entries: [
          { provider: "anthropic", id: "claude-sonnet", name: "Sonnet", providerOrder: 1 },
          { provider: "anthropic", id: "claude-haiku", name: "Haiku", providerOrder: 2 },
        ],
        routeVariants: [],
      },
    });
    const outcome = await preflightDefaultModelAccess(config);
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
  });

  it("probes the catalog with the staged credential injected into the discovery env", async () => {
    loadPreparedModelCatalogView.mockResolvedValueOnce({
      snapshot: {
        entries: [
          { provider: "openai", id: "gpt-5-nano", name: "nano", providerOrder: 10 },
          { provider: "openai", id: "gpt-5", name: "flagship", providerOrder: 1 },
        ],
        routeVariants: [],
      },
    });
    const outcome = await preflightDefaultModelAccess(config, {
      env: { EXISTING_UNRELATED: "keep" },
      pendingAuthProfiles: [
        {
          profileId: "openai:new",
          credential: { type: "api_key", provider: "openai", key: "pending-tier-key" },
        },
      ],
    });
    expect(outcome).toEqual({
      status: "replace",
      configuredRef: "openai/gpt-6-astra",
      replacement: { provider: "openai", modelId: "gpt-5", ref: "openai/gpt-5" },
    });
    expect(loadPreparedModelCatalogView).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "pending-tier-key",
          EXISTING_UNRELATED: "keep",
        }),
      }),
    );
  });

  it("fails closed when the staged profile targets a provider with no env-var mapping", async () => {
    getProviderEnvVarsCore.mockReturnValueOnce([]);
    const outcome = await preflightDefaultModelAccess(config, {
      env: { OPENAI_API_KEY: "stale-persisted-key" },
      pendingAuthProfiles: [
        {
          profileId: "openai:new",
          credential: { type: "api_key", provider: "openai", key: "pending-tier-key" },
        },
      ],
    });
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
    expect(loadPreparedModelCatalogView).not.toHaveBeenCalled();
  });

  it("fails closed when the staged profile is not an api_key credential", async () => {
    const outcome = await preflightDefaultModelAccess(config, {
      pendingAuthProfiles: [
        {
          profileId: "openai:oauth",
          credential: { type: "oauth" as never, provider: "openai" } as never,
        },
      ],
    });
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
    expect(loadPreparedModelCatalogView).not.toHaveBeenCalled();
  });

  it("fails closed when a staged non-API-key profile sits beside an API-key one", async () => {
    const outcome = await preflightDefaultModelAccess(config, {
      pendingAuthProfiles: [
        {
          profileId: "openai:oauth",
          credential: { type: "oauth" as never, provider: "openai" } as never,
        },
        {
          profileId: "openai:apikey",
          credential: { type: "api_key", provider: "openai", key: "pending" },
        },
      ],
    });
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
    expect(loadPreparedModelCatalogView).not.toHaveBeenCalled();
  });

  it("fails closed when provider env-var resolution throws", async () => {
    getProviderEnvVarsCore.mockImplementationOnce(() => {
      throw new Error("mapping unavailable");
    });
    const outcome = await preflightDefaultModelAccess(config, {
      pendingAuthProfiles: [
        {
          profileId: "openai:new",
          credential: { type: "api_key", provider: "openai", key: "pending" },
        },
      ],
    });
    expect(outcome).toEqual({ status: "unverified", reason: "no-catalog" });
    expect(loadPreparedModelCatalogView).not.toHaveBeenCalled();
  });

  it("uses persisted credentials when no staged profile targets the probed provider", async () => {
    loadPreparedModelCatalogView.mockResolvedValueOnce({
      snapshot: {
        entries: [{ provider: "openai", id: "gpt-6-astra", name: "flagship" }],
        routeVariants: [],
      },
    });
    const outcome = await preflightDefaultModelAccess(config, {
      env: { OPENAI_API_KEY: "persisted-key" },
      pendingAuthProfiles: [
        {
          profileId: "anthropic:new",
          credential: { type: "api_key", provider: "anthropic", key: "unrelated" },
        },
      ],
    });
    expect(outcome).toEqual({ status: "ok" });
    const [[request]] = loadPreparedModelCatalogView.mock.calls;
    expect(request.env?.OPENAI_API_KEY).toBe("persisted-key");
  });
});
