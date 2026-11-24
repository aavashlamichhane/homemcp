import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface PolicyFinding {
  service: string;
  rule: string;
  message: string;
}

export interface ComposePolicyResult {
  allowed: boolean;
  violations: PolicyFinding[];
  warnings: PolicyFinding[];
}

export interface ComposePolicyAllowEntry {
  network_mode_host?: boolean | undefined;
  docker_sock?: boolean | undefined;
  cap_add?: readonly string[] | undefined;
  devices?: readonly string[] | undefined;
}

export interface ComposePolicyOptions {
  stackName: string;
  stackDir?: string | undefined;
  allowedBindRoots?: readonly string[] | undefined;
  allow?: Record<string, ComposePolicyAllowEntry> | undefined;
  allowedRegistries?: readonly string[] | undefined;
  requireLanOrLoopbackPorts?: boolean | undefined;
}

const SENSITIVE_HOST_PATHS = [
  '/',
  '/etc',
  '/root',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/var/run',
  '/run',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
];

function normalizePosix(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

function isSubpath(parent: string, child: string): boolean {
  const np = normalizePosix(parent).replace(/\/+$/, '') || '/';
  const nc = normalizePosix(child);
  if (np === '/') return nc === '/';
  return nc === np || nc.startsWith(`${np}/`);
}

function parseBindSource(vol: unknown): string | undefined {
  if (typeof vol === 'string') {
    const parts = vol.split(':');
    if (parts.length >= 2) {
      return parts[0];
    }
    return undefined;
  }
  if (vol && typeof vol === 'object') {
    const rec = vol as Record<string, unknown>;
    if (rec['type'] === 'volume' || rec['type'] === 'tmpfs') return undefined;
    if (typeof rec['source'] === 'string') return rec['source'];
  }
  return undefined;
}

function isNamedVolume(src: string): boolean {
  return (
    !src.startsWith('/') && !src.startsWith('.') && !src.startsWith('~') && !src.includes('${')
  );
}

function checkPortBinding(portSpec: unknown): { ok: boolean; detail: string } {
  let raw = '';
  if (typeof portSpec === 'string' || typeof portSpec === 'number') {
    raw = String(portSpec).trim();
  } else if (portSpec && typeof portSpec === 'object') {
    const rec = portSpec as Record<string, unknown>;
    const hostIp = typeof rec['host_ip'] === 'string' ? rec['host_ip'] : '';
    const pubRaw = rec['published'];
    const pub = typeof pubRaw === 'string' || typeof pubRaw === 'number' ? String(pubRaw) : '';
    if (!hostIp) {
      return { ok: false, detail: `Port ${pub || '<unknown>'} has no host_ip bind address` };
    }
    if (hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '[::]') {
      return { ok: false, detail: `Wildcard host_ip ${hostIp} is forbidden` };
    }
    return { ok: true, detail: '' };
  }

  // String port formats: "8080:80", "127.0.0.1:8080:80", "[::]:8080:80", "0.0.0.0:8080:80"
  if (raw.startsWith('0.0.0.0:') || raw.startsWith('[::]:') || raw.startsWith(':::')) {
    return { ok: false, detail: `Wildcard port binding "${raw}" is forbidden` };
  }
  // Strip protocol suffix
  const withoutProto = raw.replace(/\/(tcp|udp)$/i, '');
  const parts = withoutProto.split(':');
  // IPv4 explicit bind has 3 parts: ip:hostPort:containerPort (or [v6]:hostPort:containerPort)
  if (parts.length < 3 && !raw.includes(']:')) {
    return {
      ok: false,
      detail: `Port binding "${raw}" omits explicit bind IP (use 127.0.0.1 or LAN IP, or remove ports and use the proxy network)`,
    };
  }
  return { ok: true, detail: '' };
}

export function validateComposePolicy(
  yamlOrObj: string | Record<string, unknown>,
  options: ComposePolicyOptions,
): ComposePolicyResult {
  const violations: PolicyFinding[] = [];
  const warnings: PolicyFinding[] = [];

  let doc: unknown;
  if (typeof yamlOrObj === 'string') {
    try {
      doc = parseYaml(yamlOrObj);
    } catch (err) {
      violations.push({
        service: '<compose>',
        rule: 'yaml_parse',
        message: `Invalid YAML: ${err instanceof Error ? err.message : 'parse error'}`,
      });
      return { allowed: false, violations, warnings };
    }
  } else {
    doc = yamlOrObj;
  }

  if (!doc || typeof doc !== 'object') {
    violations.push({
      service: '<compose>',
      rule: 'schema',
      message: 'Compose must be a YAML mapping',
    });
    return { allowed: false, violations, warnings };
  }

  const rootObj = doc as Record<string, unknown>;
  const services = rootObj['services'];
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    violations.push({
      service: '<compose>',
      rule: 'services',
      message: 'Missing services mapping',
    });
    return { allowed: false, violations, warnings };
  }

  const stackAllow = options.allow?.[options.stackName];
  const allowedRoots = (options.allowedBindRoots ?? []).map((r) => normalizePosix(r));
  const stackDirNorm = options.stackDir ? normalizePosix(options.stackDir) : undefined;
  const requireIpBind = options.requireLanOrLoopbackPorts ?? true;

  for (const [svcName, svcRaw] of Object.entries(services as Record<string, unknown>)) {
    if (!svcRaw || typeof svcRaw !== 'object') {
      violations.push({
        service: svcName,
        rule: 'service_shape',
        message: 'Service must be an object',
      });
      continue;
    }
    const svc = svcRaw as Record<string, unknown>;
    const svcAllow = options.allow?.[svcName] ?? stackAllow;

    if (svc['privileged'] === true) {
      violations.push({
        service: svcName,
        rule: 'privileged',
        message: 'privileged: true is denied',
      });
    }

    const netMode = svc['network_mode'];
    if (typeof netMode === 'string' && netMode === 'host' && !svcAllow?.network_mode_host) {
      violations.push({
        service: svcName,
        rule: 'network_mode',
        message: 'network_mode: host is denied unless allowlisted',
      });
    }

    if (svc['pid'] === 'host') {
      violations.push({ service: svcName, rule: 'pid', message: 'pid: host is denied' });
    }
    if (svc['ipc'] === 'host') {
      violations.push({ service: svcName, rule: 'ipc', message: 'ipc: host is denied' });
    }
    if (svc['userns_mode'] === 'host') {
      violations.push({
        service: svcName,
        rule: 'userns_mode',
        message: 'userns_mode: host is denied',
      });
    }

    // security_opt
    const secOpts = svc['security_opt'];
    if (Array.isArray(secOpts)) {
      for (const opt of secOpts) {
        if (typeof opt === 'string' && /unconfined/i.test(opt)) {
          violations.push({
            service: svcName,
            rule: 'security_opt',
            message: `Unconfined security_opt "${opt}" is denied`,
          });
        }
      }
    }

    // cap_add
    const capAdd = svc['cap_add'];
    if (Array.isArray(capAdd) && capAdd.length > 0) {
      const allowedCaps = new Set((svcAllow?.cap_add ?? []).map((c) => c.toUpperCase()));
      for (const cap of capAdd) {
        const capStr = String(cap).toUpperCase();
        if (!allowedCaps.has(capStr)) {
          violations.push({
            service: svcName,
            rule: 'cap_add',
            message: `Capability "${capStr}" is not allowlisted`,
          });
        }
      }
    }

    // devices
    const devices = svc['devices'];
    if (Array.isArray(devices) && devices.length > 0) {
      const allowedDevs = svcAllow?.devices ?? [];
      for (const dev of devices) {
        const devSrc = String(dev).split(':')[0] ?? '';
        if (!allowedDevs.some((a) => devSrc === a || devSrc.startsWith(`${a}/`))) {
          violations.push({
            service: svcName,
            rule: 'devices',
            message: `Device "${devSrc}" is not allowlisted`,
          });
        }
      }
    }

    // volumes / bind mounts
    const volumes = svc['volumes'];
    if (Array.isArray(volumes)) {
      for (const vol of volumes) {
        const src = parseBindSource(vol);
        if (!src) continue;
        if (isNamedVolume(src)) continue;

        if (src.includes('..')) {
          violations.push({
            service: svcName,
            rule: 'volume_traversal',
            message: `Bind mount "${src}" contains '..' traversal`,
          });
          continue;
        }

        const normSrc = normalizePosix(src);
        if (normSrc === '/var/run/docker.sock' || normSrc === '/run/docker.sock') {
          if (!svcAllow?.docker_sock) {
            violations.push({
              service: svcName,
              rule: 'docker_sock',
              message: 'Mounting docker.sock is denied unless allowlisted',
            });
          }
          continue;
        }

        if (/\/\.ssh(?:\/|$)/i.test(normSrc)) {
          violations.push({
            service: svcName,
            rule: 'sensitive_mount',
            message: `Mounting SSH directory "${src}" is denied`,
          });
          continue;
        }

        if (
          SENSITIVE_HOST_PATHS.some((s) => normSrc === s || (s !== '/' && isSubpath(s, normSrc)))
        ) {
          violations.push({
            service: svcName,
            rule: 'sensitive_mount',
            message: `Bind mount "${src}" targets a protected host path`,
          });
          continue;
        }

        const isRelativeToStack = normSrc.startsWith('./') || normSrc === '.';
        if (isRelativeToStack) continue;

        if (normSrc.startsWith('/') || normSrc.startsWith('~')) {
          const okInStack = stackDirNorm ? isSubpath(stackDirNorm, normSrc) : false;
          const okInAllowed = allowedRoots.some((r) => isSubpath(r, normSrc));
          if (!okInStack && !okInAllowed) {
            violations.push({
              service: svcName,
              rule: 'volume_outside_roots',
              message: `Bind mount "${src}" is outside allowed roots`,
            });
          }
        }
      }
    }

    // ports
    if (requireIpBind && Array.isArray(svc['ports'])) {
      for (const p of svc['ports']) {
        const res = checkPortBinding(p);
        if (!res.ok) {
          violations.push({ service: svcName, rule: 'ports', message: res.detail });
        }
      }
    }

    // Recommended/required operational defaults (warnings or violations depending on strictness)
    if (!svc['restart']) {
      warnings.push({
        service: svcName,
        rule: 'restart_policy',
        message: 'Missing restart policy (recommended: unless-stopped)',
      });
    }

    const deploy = svc['deploy'] as Record<string, unknown> | undefined;
    const resources = deploy?.['resources'] as Record<string, unknown> | undefined;
    const limits = resources?.['limits'] as Record<string, unknown> | undefined;
    if (!svc['mem_limit'] && !limits?.['memory']) {
      warnings.push({
        service: svcName,
        rule: 'mem_limit',
        message: 'Missing mem_limit (or deploy.resources.limits.memory)',
      });
    }
    if (!svc['pids_limit']) {
      warnings.push({
        service: svcName,
        rule: 'pids_limit',
        message: 'Missing pids_limit',
      });
    }
    if (!svc['healthcheck']) {
      warnings.push({
        service: svcName,
        rule: 'healthcheck',
        message: 'Missing healthcheck',
      });
    }

    const image = typeof svc['image'] === 'string' ? svc['image'] : '';
    if (image) {
      if (image.endsWith(':latest') || (!image.includes(':') && !image.includes('@sha256:'))) {
        warnings.push({
          service: svcName,
          rule: 'image_tag',
          message: `Image "${image}" is not pinned to a specific version or digest`,
        });
      }
      if (options.allowedRegistries && image.includes('/')) {
        const firstSeg = image.split('/')[0] ?? '';
        if (firstSeg.includes('.') || firstSeg.includes(':')) {
          if (!options.allowedRegistries.includes(firstSeg)) {
            warnings.push({
              service: svcName,
              rule: 'unknown_registry',
              message: `Image "${image}" uses non-standard registry "${firstSeg}"`,
            });
          }
        }
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
    warnings,
  };
}
