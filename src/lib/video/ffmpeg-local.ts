// The installed ffmpeg.wasm wrapper asks Turbopack to resolve a runtime Worker
// URL, which it cannot do. Speak the pinned package worker's small message
// protocol directly while keeping all encoder assets on this origin.
type WorkerReply = { id?: number; type: string; data?: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type ProgressCallback = (progress: { time: number; progress: number }) => void;

export class LocalFFmpeg {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private progress = new Set<ProgressCallback>();

  private send<T>(type: string, data: Record<string, unknown>): Promise<T> {
    if (!this.worker) return Promise.reject(new Error("encoder_not_loaded"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker!.postMessage({ id, type, data });
    });
  }

  async load(): Promise<void> {
    if (this.worker) throw new Error("encoder_already_loaded");
    this.worker = new Worker("/ffmpeg/worker.js", { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { id, type, data } = event.data;
      if (type === "PROGRESS") {
        const value = data as { time?: number; progress?: number };
        if (typeof value?.time === "number" && typeof value.progress === "number")
          for (const callback of this.progress) callback({ time: value.time, progress: value.progress });
        return;
      }
      // Deliberately discard LOG messages; FFmpeg logs can contain names.
      if (type === "LOG" || id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (type === "ERROR") pending.reject(new Error("encoder_operation_failed"));
      else pending.resolve(data);
    };
    this.worker.onerror = () => this.terminate();
    await this.send("LOAD", { coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`,
      wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm` });
  }

  on(event: "progress", callback: ProgressCallback): void { if (event === "progress") this.progress.add(callback); }
  off(event: "progress", callback: ProgressCallback): void { if (event === "progress") this.progress.delete(callback); }
  exec(args: string[], timeout = -1): Promise<number> {
    return this.send("EXEC", { args: ["-nostdin", "-y", ...args], timeout });
  }
  ffprobe(args: string[]): Promise<number> { return this.send("FFPROBE", { args, timeout: -1 }); }
  createDir(path: string): Promise<boolean> { return this.send("CREATE_DIR", { path }); }
  mount(fsType: "WORKERFS", options: { files: File[] }, mountPoint: string): Promise<boolean> {
    return this.send("MOUNT", { fsType, options, mountPoint });
  }
  readFile(path: string): Promise<Uint8Array> { return this.send("READ_FILE", { path, encoding: "binary" }); }
  deleteFile(path: string): Promise<boolean> { return this.send("DELETE_FILE", { path }); }

  terminate(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("encoder_terminated"));
    this.pending.clear();
    this.progress.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}
