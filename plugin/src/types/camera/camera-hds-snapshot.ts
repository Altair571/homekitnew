import { HDSProtocolSpecificErrorReason as Reason, HDSStatus, ResourceRequestReason } from '../../hap';
import type { DataStreamConnection, RecordingManagement, SnapshotRequest } from '../../hap';

interface SnapshotOptions {
    width: number;
    height: number;
    isActive(): boolean;
    takeSnapshot(request: SnapshotRequest): Promise<Buffer>;
    console: Console;
    timeoutMs?: number;
}

interface SnapshotTransfer {
    connection: DataStreamConnection;
    streamId: number;
    timer: ReturnType<typeof setTimeout>;
    onClose(): void;
    sent: boolean;
}

/**
 * Experimental ipcamera.snapshot adapter on the existing HDS dataSend transport.
 * Chunk numbering / ACK / close follow the bundled HAP recording transport. The
 * ipcamera.snapshot, imageWidth/imageHeight and "image" dataType were accepted by
 * the user's iOS 27 RC device. The public guide does not define this exchange.
 */
export class HdsSnapshotTransport {
    private readonly transfers = new Set<SnapshotTransfer>();
    private pendingCaptures = 0;

    constructor(private readonly recording: RecordingManagement, private readonly options: SnapshotOptions) {
        const transport = recording.dataStreamManagement;
        // RecordingManagement registers a bound handler and exposes no dispatcher override.
        // Replace only its global dataSend/open dispatch, retaining the exact original
        // listeners for recordings and all other request types. Dependencies are pinned to
        // the supplied bundle and this integration is tested against its actual server.
        const emitter = (transport as any).dataStreamServer.internalEventEmitter;
        const event = 'dataSend-r-open';
        const legacyHandlers = emitter.listeners(event);
        emitter.removeAllListeners(event);
        transport.onRequestMessage('dataSend', 'open', (connection, id, message) => {
            if (message.type === 'ipcamera.snapshot') {
                this.open(connection, id, message);
                return;
            }
            // Legacy CameraRecordingStream owns dataSend's per-connection event routing.
            // Do not let it take over while this connection has an image awaiting ACK.
            if (this.find(connection)) {
                this.reject(connection, id, Reason.BUSY);
                return;
            }
            for (const handler of legacyHandlers) handler.call(emitter, connection, id, message);
        });
        transport.onEventMessage('dataSend', 'ack', (connection, message) => {
            const transfer = this.find(connection, message.streamId);
            if (!transfer || !transfer.sent || message.endOfStream !== true) return;
            this.options.console.log(`HomeKit HDS snapshot acknowledged (stream ${transfer.streamId})`);
            this.finish(transfer);
        });
        transport.onEventMessage('dataSend', 'close', (connection, message) => {
            const transfer = this.find(connection, message.streamId);
            if (!transfer) return;
            this.options.console.log(`HomeKit HDS snapshot closed by controller (stream ${transfer.streamId}, reason ${Number.isInteger(message.reason) ? message.reason : '?'})`);
            this.finish(transfer);
        });
    }

    private find(connection: DataStreamConnection, streamId?: number): SnapshotTransfer | undefined {
        return [...this.transfers].find(t => t.connection === connection
            && (streamId === undefined || t.streamId === streamId));
    }

    private reject(connection: DataStreamConnection, id: number, reason: number): void {
        connection.sendResponse('dataSend', 'open', id, HDSStatus.PROTOCOL_SPECIFIC_ERROR, { status: reason });
    }

    private open(connection: DataStreamConnection, id: number, message: any): void {
        if (message.target !== 'controller' || !Number.isSafeInteger(message.streamId) || message.streamId < 0) {
            this.reject(connection, id, Reason.BAD_DATA); return;
        }
        if (!this.options.isActive()) { this.reject(connection, id, Reason.NOT_ALLOWED); return; }
        if (this.find(connection, message.streamId) || this.transfers.size >= 2 || this.pendingCaptures >= 2
            || (this.recording as any).recordingStream?.connection === connection) {
            this.reject(connection, id, Reason.BUSY); return;
        }
        const metadata = message.metadata;
        if (metadata != null && (typeof metadata !== 'object' || Buffer.isBuffer(metadata) || Array.isArray(metadata))) {
            this.reject(connection, id, Reason.BAD_DATA); return;
        }
        // Accept bounded image dimensions when supplied; otherwise use this sensor's size.
        const dimension = (value: unknown, fallback: number) => value === undefined ? fallback
            : Number.isInteger(value) && Number(value) > 0 && Number(value) <= 8192 ? Number(value) : undefined;
        const width = dimension(metadata?.['image-width'] ?? metadata?.imageWidth ?? metadata?.width, this.options.width);
        const height = dimension(metadata?.['image-height'] ?? metadata?.imageHeight ?? metadata?.height, this.options.height);
        if (!width || !height) { this.reject(connection, id, Reason.BAD_DATA); return; }
        const requestedReason = metadata?.reason ?? message.reason;
        const reason = requestedReason === 'event' || requestedReason === ResourceRequestReason.EVENT
            ? ResourceRequestReason.EVENT
            : requestedReason === 'periodic' || requestedReason === ResourceRequestReason.PERIODIC
                ? ResourceRequestReason.PERIODIC : undefined;
        const transfer: SnapshotTransfer = {
            connection, streamId: message.streamId, sent: false,
            timer: undefined!, onClose: () => this.finish(transfer),
        };
        this.transfers.add(transfer);
        connection.once('closed', transfer.onClose);
        this.armTimeout(transfer);
        try { connection.sendResponse('dataSend', 'open', id, HDSStatus.SUCCESS, { status: 0 }); }
        catch (e) { this.finish(transfer); return; }
        // Home's tile hint was reducing detail before the JPEG reached it. Request
        // the real sensor resolution when larger, rather than upscale a small image.
        const native = [this.options.width, this.options.height].every(v => Number.isInteger(v) && v > 0 && v <= 8192)
            && this.options.width * this.options.height > width * height;
        const captureWidth = native ? this.options.width : width;
        const captureHeight = native ? this.options.height : height;
        this.options.console.log(`HomeKit HDS snapshot requested: ${width}x${height}; capturing ${captureWidth}x${captureHeight} (stream ${transfer.streamId})`);
        void this.sendImage(transfer, { width: captureWidth, height: captureHeight, reason });
    }

    private async sendImage(transfer: SnapshotTransfer, request: SnapshotRequest): Promise<void> {
        this.pendingCaptures++;
        try {
            let jpeg: Buffer;
            try { jpeg = await this.options.takeSnapshot(request); }
            finally { this.pendingCaptures--; }
            if (!this.transfers.has(transfer)) return;
            if (!this.options.isActive()) { this.finish(transfer, Reason.NOT_ALLOWED); return; }
            if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg.length > 8 * 1024 * 1024
                || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Snapshot is empty, oversized or not JPEG');
            const chunkSize = 0x40000;
            for (let offset = 0, sequence = 1; offset < jpeg.length; offset += chunkSize, sequence++) {
                if (!this.transfers.has(transfer)) return;
                if (!this.options.isActive()) { this.finish(transfer, Reason.NOT_ALLOWED); return; }
                const data = jpeg.subarray(offset, offset + chunkSize);
                const last = offset + data.length === jpeg.length;
                transfer.sent = last;
                transfer.connection.sendEvent('dataSend', 'data', {
                    streamId: transfer.streamId,
                    packets: [{ data, metadata: {
                        dataType: 'image', dataSequenceNumber: 1, dataChunkSequenceNumber: sequence,
                        isLastDataChunk: last, ...(sequence === 1 ? { dataTotalSize: jpeg.length } : {}),
                    } }], endOfStream: last,
                });
                if (!last) await new Promise<void>(resolve => setImmediate(resolve));
            }
            this.options.console.log(`HomeKit HDS snapshot sent: ${jpeg.length} bytes (stream ${transfer.streamId}); waiting for controller ACK`);
            if (this.transfers.has(transfer)) this.armTimeout(transfer);
        }
        catch (e) {
            if (!this.transfers.has(transfer)) return;
            this.options.console.warn('HomeKit HDS snapshot failed', e instanceof Error ? e.message : e);
            this.finish(transfer, e === -70412 || e === -70401 ? Reason.NOT_ALLOWED : Reason.UNEXPECTED_FAILURE);
        }
    }

    private armTimeout(transfer: SnapshotTransfer): void {
        clearTimeout(transfer.timer);
        transfer.timer = setTimeout(() => {
            this.options.console.warn(`HomeKit HDS snapshot ${transfer.sent ? 'ACK' : 'capture'} timed out (stream ${transfer.streamId})`);
            this.finish(transfer, Reason.TIMEOUT);
        }, this.options.timeoutMs ?? 10000);
        transfer.timer.unref?.();
    }

    private finish(transfer: SnapshotTransfer, reason?: number): void {
        if (!this.transfers.delete(transfer)) return;
        clearTimeout(transfer.timer);
        transfer.connection.removeListener('closed', transfer.onClose);
        if (reason !== undefined) {
            try { transfer.connection.sendEvent('dataSend', 'close', { streamId: transfer.streamId, reason }); }
            catch (_) { /* Closing a disconnected transport needs no further response. */ }
        }
    }

    closeAll(): void {
        for (const transfer of this.transfers) this.finish(transfer, Reason.CANCELLED);
    }
}
