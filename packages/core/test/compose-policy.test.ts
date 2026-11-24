import { describe, expect, it } from 'vitest';
import { validateComposePolicy } from '../src/compose-policy.js';

const baseOpts = {
  stackName: 'test-app',
  stackDir: '/home/homelab/docker-containers/test-app',
  allowedBindRoots: ['/home/homelab/docker-containers/test-app', '/mnt/storage/media'],
  allow: {
    jellyfin: { network_mode_host: true, devices: ['/dev/dri'] },
    portainer: { docker_sock: true },
  },
};

describe('validateComposePolicy', () => {
  it('allows a compliant hardened compose file', () => {
    const yaml = `
services:
  uptime-kuma:
    image: louislam/uptime-kuma:1.23.16
    restart: unless-stopped
    mem_limit: 256m
    pids_limit: 128
    security_opt:
      - no-new-privileges:true
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "node", "healthcheck.js"]
    networks:
      - proxy
networks:
  proxy:
    external: true
`;
    const res = validateComposePolicy(yaml, baseOpts);
    expect(res.allowed).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('denies all 20 malicious compose attack payloads', () => {
    const payloads: Array<{ name: string; yaml: string }> = [
      {
        name: '1. privileged: true',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    privileged: true\n',
      },
      {
        name: '2. rootfs mount /',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /:/host\n',
      },
      {
        name: '3. /etc mount',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /etc/shadow:/shadow:ro\n',
      },
      {
        name: '4. /root mount',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /root:/root\n',
      },
      {
        name: '5. traversal mount ../..',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - ../../etc:/mnt\n',
      },
      {
        name: '6. docker.sock mount without allowlist',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
      },
      {
        name: '7. /run/docker.sock mount without allowlist',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /run/docker.sock:/var/run/docker.sock\n',
      },
      {
        name: '8. network_mode: host without allowlist',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    network_mode: host\n',
      },
      {
        name: '9. pid: host',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    pid: host\n',
      },
      {
        name: '10. ipc: host',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    ipc: host\n',
      },
      {
        name: '11. userns_mode: host',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    userns_mode: host\n',
      },
      {
        name: '12. security_opt apparmor:unconfined',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    security_opt:\n      - apparmor:unconfined\n',
      },
      {
        name: '13. security_opt seccomp:unconfined',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    security_opt:\n      - seccomp=unconfined\n',
      },
      {
        name: '14. cap_add SYS_ADMIN',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    cap_add:\n      - SYS_ADMIN\n',
      },
      {
        name: '15. cap_add NET_RAW',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    cap_add:\n      - NET_RAW\n',
      },
      {
        name: '16. device /dev/sda',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    devices:\n      - /dev/sda:/dev/sda\n',
      },
      {
        name: '17. .ssh mount',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /home/homelab/.ssh:/ssh:ro\n',
      },
      {
        name: '18. bind mount outside allowed roots',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    volumes:\n      - /var/lib/secret-stuff:/data\n',
      },
      {
        name: '19. wildcard port 0.0.0.0:8080:80',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    ports:\n      - "0.0.0.0:8080:80"\n',
      },
      {
        name: '20. unpinned port 8080:80 without bind IP',
        yaml: 'services:\n  x:\n    image: alpine:3.20\n    ports:\n      - "8080:80"\n',
      },
    ];

    expect(payloads).toHaveLength(20);
    for (const p of payloads) {
      const res = validateComposePolicy(p.yaml, baseOpts);
      expect(res.allowed, `${p.name} should be denied`).toBe(false);
      expect(res.violations.length, `${p.name} should have violations`).toBeGreaterThan(0);
    }
  });

  it('respects per-service allowlist for jellyfin and portainer', () => {
    const jelly = `
services:
  jellyfin:
    image: jellyfin/jellyfin:10.11.8
    network_mode: host
    devices:
      - /dev/dri:/dev/dri
    restart: unless-stopped
    mem_limit: 2g
    pids_limit: 512
    healthcheck:
      test: ["CMD", "curl", "-f", "http://127.0.0.1:8096/health"]
`;
    const res = validateComposePolicy(jelly, baseOpts);
    expect(res.allowed).toBe(true);
  });
});
