import { StringDecoder } from "node:string_decoder";

export const MAX_MONITOR_OUTPUT_BYTES = 1024 * 1024;

export function appendMonitorContext(pending: string[], line: string): string[] {
  const lines = [...pending, line].slice(-50);
  let bytes = lines.reduce((total, text) => total + Buffer.byteLength(text), 0);
  while (bytes > MAX_MONITOR_OUTPUT_BYTES && lines.length > 0) {
    bytes -= Buffer.byteLength(lines.shift()!);
  }
  return lines;
}

export function createMonitorOutputReader(
  onLine: (line: string) => void,
  onOverflow: () => void,
): { write(chunk: Buffer): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let pendingLine = "";
  let pendingBytes = 0;
  let stopped = false;
  const takeText = (text: string) => {
    const parts = text.split(/\r\n|\n|\r/);
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      pendingBytes += Buffer.byteLength(part);
      if (pendingBytes > MAX_MONITOR_OUTPUT_BYTES) {
        stopped = true;
        pendingLine = "";
        onOverflow();
        return;
      }
      pendingLine += part;
      if (index < parts.length - 1) {
        onLine(pendingLine);
        pendingLine = "";
        pendingBytes = 0;
      }
    }
  };
  return {
    write(chunk) {
      if (!stopped) takeText(decoder.write(chunk));
    },
    end() {
      if (stopped) return;
      takeText(decoder.end());
      if (!stopped && pendingLine.length > 0) onLine(pendingLine);
      pendingLine = "";
      stopped = true;
    },
  };
}
