/**
 * SSH tunnel manager for connecting to a DB behind a bastion host.
 *
 * One tunnel per connection id, shared by that connection's driver pool. The map
 * caches the *promise* (not the resolved value) so two queries racing to open the
 * same tunnel share one forward instead of opening two (the agent loop fans out
 * concurrent queries). The map lives on globalThis so Next.js dev-mode module
 * re-evaluation doesn't duplicate it and leak tunnels that closeTunnel() can't find.
 */
import { Client, type ConnectConfig } from 'ssh2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  /** Exactly one of these is set. Both are decrypted secret material. */
  privateKey?: string;
  password?: string;
}

interface Tunnel {
  client: Client;
  server: net.Server;
  localPort: number;
}

// Pin the registry to globalThis so HMR / multiple module instances share it.
const g = globalThis as unknown as { __mdmTunnels?: Map<string, Promise<Tunnel>> };
const tunnels: Map<string, Promise<Tunnel>> = g.__mdmTunnels ?? (g.__mdmTunnels = new Map());

function openTunnel(sshCfg: SshConfig, targetHost: string, targetPort: number): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    const client = new Client();
    const connectCfg: ConnectConfig = {
      host: sshCfg.host,
      port: sshCfg.port,
      username: sshCfg.user,
      ...(sshCfg.privateKey ? { privateKey: sshCfg.privateKey } : {}),
      ...(sshCfg.password ? { password: sshCfg.password } : {}),
      readyTimeout: 15_000,
    };

    client.on('ready', () => {
      // Local TCP server: each inbound socket gets its own forwarded channel to
      // the target DB through the SSH connection.
      const server = net.createServer((sock) => {
        client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          sock.on('error', () => stream.end());
          stream.on('error', () => sock.destroy());
        });
      });
      server.on('error', (e) => { client.end(); reject(e); });
      server.listen(0, '127.0.0.1', () => {
        const localPort = (server.address() as AddressInfo).port;
        resolve({ client, server, localPort });
      });
    });
    client.on('error', (e) => reject(e));
    client.connect(connectCfg);
  });
}

/** Ensure a tunnel exists for this connection; returns the local port to dial.
 *  Concurrent callers share one tunnel. A failed attempt is not cached. */
export async function ensureTunnel(connectionId: string, sshCfg: SshConfig, targetHost: string, targetPort: number): Promise<number> {
  let p = tunnels.get(connectionId);
  if (!p) {
    p = openTunnel(sshCfg, targetHost, targetPort);
    tunnels.set(connectionId, p);
    // Don't leave a rejected promise cached — next call should retry.
    p.catch(() => { if (tunnels.get(connectionId) === p) tunnels.delete(connectionId); });
  }
  const t = await p;
  return t.localPort;
}

/** Tear down the tunnel for a connection (on delete/edit). Safe if none exists. */
export async function closeTunnel(connectionId: string): Promise<void> {
  const p = tunnels.get(connectionId);
  if (!p) return;
  tunnels.delete(connectionId);
  try {
    const t = await p;
    t.server.close();
    t.client.end();
  } catch { /* open failed → nothing to close */ }
}
