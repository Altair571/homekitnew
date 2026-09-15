import type { SFrameKeyData } from './hksv-webrtc-protocol';

/** §4.22 configures the accessory's receive direction, independently of the
 * outgoing SFrame option in §4.17. Our audio/video transceivers are send-only.
 * Retain provisioned keys while reception is inactive; this is not an SFrame
 * decryptor and must never authorize an active media receiver. */
export class WebRTCReceiveKeys {
    private readonly keys = new Map<bigint, Buffer>();

    get size(): number { return this.keys.size; }

    update(add: SFrameKeyData[], remove: bigint[]): void {
        // Local resource bounds, not claims about Apple's cipher/key size.
        if (add.length > 32 || remove.length > 32)
            throw new Error('Too many WebRTC receive key operations');
        const validKid = (kid: bigint) => typeof kid === 'bigint' && kid >= 0n && kid <= 0xffffffffffffffffn;
        const seen = new Set<bigint>();
        for (const entry of add) {
            if (!validKid(entry.kid) || !Buffer.isBuffer(entry.key) || !entry.key.length || entry.key.length > 1024
                || seen.has(entry.kid)) throw new Error('Invalid WebRTC receive key entry');
            seen.add(entry.kid);
        }
        if (remove.some(kid => !validKid(kid) || seen.has(kid)))
            throw new Error('Invalid or conflicting WebRTC receive key removal');
        const nextIds = new Set(this.keys.keys());
        remove.forEach(kid => nextIds.delete(kid));
        add.forEach(entry => nextIds.add(entry.kid));
        if (nextIds.size > 32) throw new Error('WebRTC receive key limit reached');

        // Validate the complete rotation before touching existing key material.
        const copies = add.map(entry => ({ kid: entry.kid, key: Buffer.from(entry.key) }));
        for (const kid of remove) {
            this.keys.get(kid)?.fill(0);
            this.keys.delete(kid);
        }
        for (const entry of copies) {
            this.keys.get(entry.kid)?.fill(0);
            this.keys.set(entry.kid, entry.key);
        }
    }

    clear(): void {
        for (const key of this.keys.values()) key.fill(0);
        this.keys.clear();
    }
}
