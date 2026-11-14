/** Physical object packing is independent of the logical fetch/cache unit.
 * The builder owns one bounded buffer and writes each container once. */
export class PacketObjects {
  private buffer = new Uint8Array(32 * 1048576);
  private at = 0;
  private object = 0;
  constructor(
    private readonly write: (object: number, data: Uint8Array) => Promise<void>,
  ) {}
  async append(data: Uint8Array) {
    if (!data.length || data.length > this.buffer.length)
      throw Error("Invalid packet size");
    if (this.at + data.length > this.buffer.length) await this.flush();
    const locator = { object: this.object, offset: this.at };
    this.buffer.set(data, this.at);
    this.at += data.length;
    return locator;
  }
  async flush() {
    if (!this.at) return;
    await this.write(this.object, this.buffer.subarray(0, this.at));
    this.object++;
    this.at = 0;
  }
}
