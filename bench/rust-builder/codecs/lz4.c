/* Diagnostic independent LZ4 block decoder. Input includes the experiment's
 * little-endian uncompressed-size prefix. No allocation or runtime imports. */
typedef unsigned int u32;
static unsigned char input[9 * 1024 * 1024], output[8 * 1024 * 1024];
unsigned char *input_ptr(void) { return input; }
unsigned char *output_ptr(void) { return output; }
int decode(u32 n) {
  if (n < 4 || n > sizeof(input)) return -1;
  u32 size = input[0] | (u32)input[1] << 8 | (u32)input[2] << 16 | (u32)input[3] << 24;
  if (size > sizeof(output)) return -2;
  u32 at = 4, pos = 0;
  while (at < n) {
    u32 token = input[at++], literals = token >> 4;
    if (literals == 15) {
      u32 extra;
      do { if (at == n) return -3; extra = input[at++]; literals += extra; }
      while (extra == 255);
    }
    if (literals > n - at || literals > size - pos) return -4;
    for (u32 i = 0; i < literals; ++i) output[pos++] = input[at++];
    if (at == n) break;
    if (n - at < 2) return -5;
    u32 offset = input[at] | (u32)input[at + 1] << 8; at += 2;
    if (!offset || offset > pos) return -6;
    u32 matches = (token & 15) + 4;
    if ((token & 15) == 15) {
      u32 extra;
      do { if (at == n) return -7; extra = input[at++]; matches += extra; }
      while (extra == 255);
    }
    if (matches > size - pos) return -8;
    for (u32 i = 0; i < matches; ++i) { output[pos] = output[pos - offset]; ++pos; }
  }
  return pos == size ? (int)pos : -9;
}
