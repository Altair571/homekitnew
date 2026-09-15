import dgram, { SocketType } from 'dgram';
import { isIP } from 'net';
import os from 'os';
import { closeQuiet } from '@scrypted/common/src/listen-cluster';

function normalize(address: string, family: number): string {
    if (family === 4 && /^::ffff:/i.test(address)) {
        const mapped = address.slice(7);
        if (isIP(mapped) === 4) return mapped;
    }
    return address;
}

function sameAddress(a: string, b: string): boolean {
    if (a === b) return true;
    // Canonicalize compressed/expanded IPv6 without losing a link-local scope ID.
    if (isIP(a) !== 6 || isIP(b) !== 6) return false;
    const [ipA, scopeA] = a.split('%'), [ipB, scopeB] = b.split('%');
    return scopeA === scopeB && new URL(`http://[${ipA}]`).hostname === new URL(`http://[${ipB}]`).hostname;
}

/** UDP connect asks the OS for a local route; no application datagram is sent.
 * The temporary socket is never used for media or exposed as a HomeKit endpoint. */
async function routedAddress(type: SocketType, target: string, port: number): Promise<string> {
    const socket = dgram.createSocket(type);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, address?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            closeQuiet(socket);
            if (error) reject(error); else resolve(address);
        };
        const timer = setTimeout(() => finish(new Error('HomeKit media route lookup timed out')), 1500);
        timer.unref?.();
        socket.once('error', error => finish(error));
        try {
            socket.connect(port, target, (error?: Error) => {
                if (error) return finish(error);
                try { finish(undefined, socket.address().address); }
                catch (error) { finish(error as Error); }
            });
        }
        catch (error) { finish(error as Error); }
    });
}

/** HAP's TCP connection and its requested RTP transport can use different IP families.
 * Never bind udp4 to a genuine IPv6 address (or udp6 to an IPv4 address). */
export async function selectCameraStreamAddress(type: SocketType, source: string, target: string, port: number,
    configured: string[] = [], interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): Promise<string> {
    const family = type === 'udp6' ? 6 : 4;
    const sourceAddress = normalize(source, family);
    const targetAddress = normalize(target, family);
    if (isIP(targetAddress) !== family) throw new Error('HomeKit requested media address family does not match the target');
    const groups = Object.entries(interfaces).filter(([, infos]) => !!infos).map(([name, infos]) => infos.map(info => {
        const scope = (info as any).scopeid;
        const address = isIP(info.address) === 6 && scope > 0 && !info.address.includes('%')
            ? `${info.address}%${scope}` : info.address;
        return { address, aliases: [address, info.address, ...(scope > 0 ? [`${info.address}%${name}`] : [])] };
    }));
    const locals = groups.flat();
    const assigned = (address: string) => locals.some(info => info.aliases.some(alias => sameAddress(normalize(alias, family), address)));
    const valid = (address: string) => isIP(address) === family && address !== '0.0.0.0' && address !== '::' && assigned(address);
    const allowed = configured.map(address => normalize(address, family)).filter(valid);
    if (valid(sourceAddress) && (!allowed.length || allowed.some(address => sameAddress(address, sourceAddress))))
        return sourceAddress;
    // Honor a configured, currently assigned server address of the requested family.
    if (allowed.length) return allowed[0];
    // On dual-stack hosts, prefer the counterpart on the control connection's adapter.
    const adapter = groups.find(infos => infos.some(info => info.aliases.some(alias => sameAddress(alias, source))));
    const counterparts = adapter?.map(info => normalize(info.address, family)).filter(valid) || [];
    if (counterparts.length === 1) return counterparts[0];
    // Multiple adapters/IPv6 addresses: use routing, never an arbitrary interface.
    const routed = normalize(await routedAddress(type, targetAddress, port), family);
    if (!valid(routed)) throw new Error('No assigned local address for the requested HomeKit media family');
    return routed;
}
