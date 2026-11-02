/** `512 bytes`, `4.0 KiB`, `1.2 MiB`, `3.4 GiB`: binary units, as trunkdb's CLI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes.toLocaleString("en")} bytes`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
