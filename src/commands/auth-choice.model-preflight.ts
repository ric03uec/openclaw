// Live-catalog preflight for the configured default model.
//
// The onboarding wizard previously wrote a hardcoded flagship model into
// `agents.defaults.model` regardless of whether the authenticated account
// actually had access to that tier. When the gateway booted, inference
// crashed on the first turn with a "model not found" / "no access to model"
// error (see issue 180453). This helper runs after credentials have been
// captured but before the setup result is returned, probes the provider's
// live catalog, and recommends a safe starter model whenever the configured
// model is missing from the catalog the authenticated account can see.
//
// Scope constraints:
//
//   * The caller is responsible for passing the staged auth profiles that
//     have not yet been persisted. The helper injects their API key into
//     the discovery env for the probed provider so the live catalog request
//     authenticates as the identity the wizard just captured rather than a
//     pre-existing (possibly stale) profile. The on-disk auth store is
//     never mutated.
//   * The helper only reports a replacement candidate; it never mutates
//     config. The caller decides whether to apply the replacement based on
//     selection provenance (user-picked vs. inherited default).
//
// Accepted edge cases (left to a dedicated follow-up with core owners):
//
//   * `loadPreparedModelCatalogView` short-circuits to the configured
//     catalog when `config.models.mode === "replace"`, so a preflight on
//     such a config may report `ok` without a live probe. Addressing this
//     would require a `liveOnly` loader mode owned by the catalog view.
//   * Live discovery still reads persisted auth profiles for the probed
//     provider; a privileged persisted profile could mask a restricted
//     staged key. A fully credential-isolated probe needs an auth-store
//     overlay on the catalog boundary. Until then, the preflight is
//     advisory: a false `ok` leaves the configured default alone, which is
//     the same state as before this change.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { loadPreparedModelCatalogView } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import { getProviderEnvVarsCore } from "../secrets/provider-env-vars.js";

export type DefaultModelPreflightOptions = {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Transaction-local auth profiles returned by `prepareAuthChoice` that
   * have not yet been persisted. When present, they are merged into a
   * transient auth-store overlay so the catalog loader probes the identity
   * the wizard just set up rather than a pre-existing profile.
   */
  pendingAuthProfiles?: ProviderAuthResult["profiles"];
};

export type DefaultModelPreflightOutcome =
  | { status: "ok" }
  | { status: "unverified"; reason: "no-catalog" }
  | {
      status: "replace";
      configuredRef: string;
      replacement: { provider: string; modelId: string; ref: string };
    };

function formatModelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function readPendingApiKey(
  profiles: readonly ProviderAuthResult["profiles"][number][],
): string | undefined {
  // A single non-API-key staged credential (OAuth/device code/etc.) for the
  // probed provider forces fail-closed: we would otherwise validate access
  // under a different identity than the one onboarding will activate.
  let apiKey: string | undefined;
  for (const { credential } of profiles) {
    if (credential.type !== "api_key") {
      return undefined;
    }
    if (apiKey === undefined && typeof credential.key === "string" && credential.key.length > 0) {
      apiKey = credential.key;
    }
  }
  return apiKey;
}

/**
 * Build the env the live catalog loader will see. Returns `null` when a
 * staged profile targets the probed provider but we have no way to inject
 * its credential (unmapped provider, or a non-API-key credential type).
 * The caller must treat `null` as unverified instead of probing with the
 * surrounding env, which could carry stale persisted credentials.
 */
function buildDiscoveryEnv(params: {
  provider: string;
  base: NodeJS.ProcessEnv | undefined;
  pendingForProvider: readonly ProviderAuthResult["profiles"][number][];
  config: OpenClawConfig;
  workspaceDir?: string;
}): NodeJS.ProcessEnv | null {
  const base = { ...(params.base ?? process.env) };
  if (params.pendingForProvider.length === 0) {
    return base;
  }
  const pendingKey = readPendingApiKey(params.pendingForProvider);
  if (!pendingKey) {
    // A staged profile exists for this provider but is not an API key the
    // env boundary can represent (OAuth/device-code/etc.). Fail closed.
    return null;
  }
  let envVars: readonly string[];
  try {
    envVars = getProviderEnvVarsCore(params.provider, {
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.base,
    });
  } catch {
    // Mapping resolution is advisory; a thrown error during setup must not
    // abort onboarding. Treat it as unverified.
    return null;
  }
  if (envVars.length === 0) {
    // No known env-var mapping for this provider. Probing now would
    // authenticate as whatever stale credential the surrounding env or the
    // persisted auth store exposes, not the identity the user just entered.
    return null;
  }
  for (const envVar of envVars) {
    base[envVar] = pendingKey;
  }
  return base;
}

function matchesConfiguredModel(
  entry: ModelCatalogEntry,
  provider: string,
  modelId: string,
): boolean {
  if (normalizeProviderId(entry.provider) !== provider) {
    return false;
  }
  return entry.id.trim().toLowerCase() === modelId;
}

function pickStarterCandidate(
  entries: readonly ModelCatalogEntry[],
  provider: string,
): ModelCatalogEntry | undefined {
  const scoped = entries.filter((entry) => normalizeProviderId(entry.provider) === provider);
  if (scoped.length === 0) {
    return undefined;
  }
  // Catalog entries carry a provider-owned strongest-first order; preserve it
  // so the recommended starter matches what the picker would surface.
  const ordered = [...scoped].sort((a, b) => {
    const left = a.providerOrder ?? Number.POSITIVE_INFINITY;
    const right = b.providerOrder ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
  return ordered[0];
}

/**
 * Probe the live model catalog for the configured provider using the
 * credentials visible to the setup owner (including staged profiles).
 * Returns a replacement recommendation when the configured model is
 * missing from the catalog the authenticated account can actually see;
 * otherwise reports the configured model is OK or the catalog could not
 * be verified. Never mutates config.
 */
export async function preflightDefaultModelAccess(
  config: OpenClawConfig,
  options: DefaultModelPreflightOptions = {},
): Promise<DefaultModelPreflightOutcome> {
  const ref = resolveDefaultModelForAgent({ cfg: config, agentId: options.agentId });
  const provider = normalizeProviderId(ref.provider);
  const modelId = ref.model.trim().toLowerCase();
  if (!provider || !modelId) {
    return { status: "unverified", reason: "no-catalog" };
  }

  // Staged auth profiles for the probed provider carry the credential the
  // user just entered but have not been persisted yet. Inject the API key
  // into the discovery env under the provider's known env-var names so the
  // live catalog request authenticates as the identity the wizard just
  // captured. The on-disk auth store is not touched; the env override is
  // scoped to this call. When no staged profile targets the probed
  // provider, `loadPreparedModelCatalogView` falls back to persisted
  // credentials, matching the behavior for already-onboarded users.
  const pendingForProvider = (options.pendingAuthProfiles ?? []).filter(
    (profile) => normalizeProviderId(profile.credential.provider) === provider,
  );
  const discoveryEnv = buildDiscoveryEnv({
    provider,
    base: options.env,
    pendingForProvider,
    config,
    workspaceDir: options.workspaceDir,
  });
  if (discoveryEnv === null) {
    return { status: "unverified", reason: "no-catalog" };
  }

  let entries: readonly ModelCatalogEntry[];
  try {
    const { snapshot } = await loadPreparedModelCatalogView({
      kind: "picker",
      config,
      preferredProvider: provider,
      preferLiveProviderCatalog: true,
      providerScoped: true,
      allowStaticFallbackCatalog: false,
      ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
      ...(options.workspaceDir !== undefined ? { workspaceDir: options.workspaceDir } : {}),
      env: discoveryEnv,
    });
    entries = snapshot.entries;
  } catch {
    // Live discovery is advisory; an unreachable endpoint or transient
    // outage must not abort the wizard. Leave the configured default alone
    // and report the probe as unverified.
    return { status: "unverified", reason: "no-catalog" };
  }

  if (entries.length === 0) {
    return { status: "unverified", reason: "no-catalog" };
  }

  if (entries.some((entry) => matchesConfiguredModel(entry, provider, modelId))) {
    return { status: "ok" };
  }

  const starter = pickStarterCandidate(entries, provider);
  if (!starter) {
    return { status: "unverified", reason: "no-catalog" };
  }

  const starterProvider = normalizeProviderId(starter.provider);
  if (!starterProvider) {
    return { status: "unverified", reason: "no-catalog" };
  }

  return {
    status: "replace",
    configuredRef: formatModelRef(provider, modelId),
    replacement: {
      provider: starterProvider,
      modelId: starter.id,
      ref: formatModelRef(starterProvider, starter.id),
    },
  };
}
