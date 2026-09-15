// Independent RFC 3711/7714 oracle. No werift parsing, KDF or decryption code.
// Synthetic loopback test keys only; never reads camera or device traffic.
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } = require('node:crypto');

function derive(key, salt, label, bytes) {
    const iv = Buffer.alloc(16); salt.copy(iv); iv[7] ^= label;
    const cipher = createCipheriv('aes-128-ctr', key, iv);
    return Buffer.concat([cipher.update(Buffer.alloc(bytes)), cipher.final()]);
}

class WireReceiver {
    constructor(key, salt, profile) {
        assert([1, 7].includes(profile));
        this.profile = profile;
        this.key = derive(key, salt, 0, 16);
        this.salt = derive(key, salt, 2, profile === 7 ? 12 : 14);
        this.auth = derive(key, salt, 1, 20);
        this.indices = new Map();
    }
    read(packet) {
        assert.equal(packet[0] >>> 6, 2);
        const seq = packet.readUInt16BE(2), ssrc = packet.readUInt32BE(8);
        const previous = this.indices.get(ssrc);
        let roc = previous === undefined ? 0 : Math.floor(previous / 65536);
        if (previous !== undefined) {
            const last = previous & 65535;
            if (last < 32768 && seq - last > 32768) roc--;
            if (last >= 32768 && last - seq > 32768) roc++;
        }
        assert(roc >= 0);
        let offset = 12 + (packet[0] & 15) * 4;
        if (packet[0] & 16) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
        const tagSize = this.profile === 7 ? 16 : 10;
        assert(offset <= packet.length - tagSize);
        const header = packet.subarray(0, offset);
        const ciphertext = packet.subarray(offset, -tagSize);
        const tag = packet.subarray(-tagSize);
        let decoder;
        if (this.profile === 7) {
            const iv = Buffer.alloc(12);
            iv.writeUInt32BE(ssrc, 2); iv.writeUInt32BE(roc, 6); iv.writeUInt16BE(seq, 10);
            for (let i = 0; i < 12; i++) iv[i] ^= this.salt[i];
            decoder = createDecipheriv('aes-128-gcm', this.key, iv);
            decoder.setAAD(header); decoder.setAuthTag(tag);
        } else {
            const rocBytes = Buffer.alloc(4); rocBytes.writeUInt32BE(roc);
            const expected = createHmac('sha1', this.auth).update(packet.subarray(0, -10)).update(rocBytes).digest().subarray(0, 10);
            assert(timingSafeEqual(expected, tag), 'SRTP authentication failed');
            const iv = Buffer.alloc(16); this.salt.copy(iv);
            const index = Buffer.alloc(16);
            index.writeUInt32BE(ssrc, 4); index.writeUInt32BE(roc, 8); index.writeUInt16BE(seq, 12);
            for (let i = 0; i < 16; i++) iv[i] ^= index[i];
            decoder = createDecipheriv('aes-128-ctr', this.key, iv);
        }
        const payload = Buffer.concat([decoder.update(ciphertext), decoder.final()]);
        this.indices.set(ssrc, Math.max(previous ?? 0, roc * 65536 + seq));
        return { header, payload, ssrc, payloadType: packet[1] & 127, seq };
    }
}

module.exports = { derive, WireReceiver };
