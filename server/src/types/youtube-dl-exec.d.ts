declare module 'youtube-dl-exec' {
  import { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';

  export interface YoutubeDlExecOptions {
    [flag: string]: string | number | boolean | undefined;
  }

  export type ChildProcessPromise = ChildProcessWithoutNullStreams & Promise<unknown>;

  type YoutubeDlResult = string | Record<string, unknown>;

  interface YoutubeDlExec {
    (url: string, options?: YoutubeDlExecOptions, spawnOptions?: SpawnOptionsWithoutStdio): Promise<YoutubeDlResult>;
    exec(
      url: string,
      options?: YoutubeDlExecOptions,
      spawnOptions?: SpawnOptionsWithoutStdio
    ): ChildProcessPromise;
    youtubeDl: YoutubeDlExec;
    create: (binaryPath: string) => YoutubeDlExec;
    args: (flags?: YoutubeDlExecOptions) => string[];
    isJSON: (output?: string) => boolean;
    constants: Record<string, string>;
  }

  const youtubedl: YoutubeDlExec;
  export default youtubedl;
}
