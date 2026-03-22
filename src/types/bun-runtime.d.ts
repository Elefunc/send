declare const Bun: {
  file(path: string): Blob & { type: string }
  write(path: string, data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<number>
  sleep(ms: number): Promise<void>
}
