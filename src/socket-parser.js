import { Encoder, Decoder as SocketDecoder, protocol } from 'socket.io-parser';
import { LIMITS, binary, utf8 } from './values.js';
import { check } from './errors.js';

// Keep the standard Socket.IO wire format. A ULDA batch has at most two binary
// attachments per resource. Bound bytes before the decoder retains each frame;
// protocol.js still validates the complete reconstructed application message.
export const SOCKET_HEADER_BYTES = 65_536;
class Decoder extends SocketDecoder {
  #receivedBytes = 0;
  constructor() {
    super({ maxAttachments: LIMITS.batch * 2 });
    this.on('decoded', () => { this.#receivedBytes = 0; });
  }
  add(chunk) {
    try {
      if (typeof chunk === 'string') {
        check(chunk.length <= SOCKET_HEADER_BYTES && utf8(chunk).byteLength <= SOCKET_HEADER_BYTES, 'LIMIT');
        this.#receivedBytes = 0;
      } else {
        const bytes = binary(chunk);
        check(this.#receivedBytes + bytes.byteLength <= LIMITS.messageBytes, 'LIMIT');
        this.#receivedBytes += bytes.byteLength;
      }
      return super.add(chunk);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  destroy() {
    super.destroy();
    this.#receivedBytes = 0;
  }
}

export const socketParser = Object.freeze({ Encoder, Decoder, protocol });
