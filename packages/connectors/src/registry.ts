import { fetchWithTimeout } from './http.js';

export interface RegistryDigestCheck {
  image: string;
  local_digest?: string | undefined;
  remote_digest?: string | undefined;
  update_available: boolean | null;
  error?: string | undefined;
}

export interface RegistryConnector {
  checkImageUpdate(imageRef: string, localDigests: readonly string[]): Promise<RegistryDigestCheck>;
}

interface ParsedImage {
  registry: string;
  repo: string;
  tag: string;
}

function parseImageRef(ref: string): ParsedImage {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastColon = withoutDigest.lastIndexOf(':');
  const lastSlash = withoutDigest.lastIndexOf('/');
  const hasTag = lastColon > lastSlash;
  const name = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : 'latest';

  const parts = name.split('/');
  let registry = 'registry-1.docker.io';
  let repo = name;
  if (parts.length > 1 && (parts[0]!.includes('.') || parts[0]!.includes(':'))) {
    registry = parts[0]!;
    repo = parts.slice(1).join('/');
  } else if (parts.length === 1) {
    repo = `library/${name}`;
  }
  return { registry, repo, tag };
}

export class OciRegistryConnector implements RegistryConnector {
  private readonly cache = new Map<string, { digest: string; expiresAt: number }>();

  public async checkImageUpdate(
    imageRef: string,
    localDigests: readonly string[],
  ): Promise<RegistryDigestCheck> {
    const localDigest = localDigests[0]?.split('@')[1];
    if (!imageRef || imageRef.endsWith(':local')) {
      return { image: imageRef, local_digest: localDigest, update_available: null };
    }

    const { registry, repo, tag } = parseImageRef(imageRef);
    const cacheKey = `${registry}/${repo}:${tag}`;
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {
        image: imageRef,
        local_digest: localDigest,
        remote_digest: cached.digest,
        update_available: localDigest ? cached.digest !== localDigest : null,
      };
    }

    try {
      const tokenUrl =
        registry === 'ghcr.io'
          ? `https://ghcr.io/token?scope=repository:${repo}:pull`
          : registry === 'lscr.io'
            ? `https://ghcr.io/token?scope=repository:${repo}:pull`
            : `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;

      const tokResp = await fetchWithTimeout(tokenUrl, { serviceName: 'oci-auth' });
      const tokJson = tokResp.ok ? ((await tokResp.json()) as { token?: string }) : {};
      const manifestUrl = `https://${registry}/v2/${repo}/manifests/${tag}`;
      const manResp = await fetchWithTimeout(manifestUrl, {
        method: 'HEAD',
        headers: {
          ...(tokJson.token ? { Authorization: `Bearer ${tokJson.token}` } : {}),
          Accept:
            'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
        },
        serviceName: 'oci-registry',
      });
      const digest = manResp.headers.get('docker-content-digest') ?? undefined;
      if (!manResp.ok || !digest) {
        return {
          image: imageRef,
          local_digest: localDigest,
          update_available: null,
          error: `Registry returned ${manResp.status}`,
        };
      }
      this.cache.set(cacheKey, { digest, expiresAt: now + 6 * 3600_000 });
      return {
        image: imageRef,
        local_digest: localDigest,
        remote_digest: digest,
        update_available: localDigest ? digest !== localDigest : null,
      };
    } catch (err) {
      return {
        image: imageRef,
        local_digest: localDigest,
        update_available: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
